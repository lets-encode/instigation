import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

_session_dir = tempfile.TemporaryDirectory()
os.environ.setdefault("FLASK_ENV", "development")
os.environ.setdefault("FLASK_SECRET", "test-secret")
os.environ.setdefault("GITHUB_CLIENT_ID", "test-client")
os.environ.setdefault("GITHUB_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault("SESSION_DIR", _session_dir.name)
os.environ.setdefault("DB_PATH", os.path.join(_session_dir.name, "import.db"))

from broker import app as broker  # noqa: E402
from broker import registry, slug_validation  # noqa: E402
from broker.slug_db import Store  # noqa: E402

ADMIN_TOKEN = "test-admin-token"
AUTH = {"Authorization": "Bearer " + ADMIN_TOKEN}


class RegistryTest(unittest.TestCase):
    def setUp(self):
        broker.app.config["TESTING"] = True
        # The suite's requests all arrive within a second, which would trip the
        # 20/s default limit; rate limiting is not under test here.
        broker.limiter.enabled = False
        self.addCleanup(lambda: setattr(broker.limiter, "enabled", True))
        self.client = broker.app.test_client()
        self._db_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._db_dir.cleanup)
        # A fresh store per test; the routes read the module attribute.
        registry.store = Store(os.path.join(self._db_dir.name, "slugs.db"))
        os.environ["ADMIN_TOKEN"] = ADMIN_TOKEN
        self.authenticate()

    def authenticate(self):
        with self.client.session_transaction() as current:
            current["githubToken"] = "server-side-token"
            current["userLogin"] = "alice"

    def log_out(self):
        with self.client.session_transaction() as current:
            current.clear()

    def register(self, name, repo_id=12345, forge="github", claim_token=None):
        """The SPA registers a name against a created repo's (forge, id)."""
        return self.client.post(
            "/registry/register",
            json={
                "name": name,
                "repo_id": repo_id,
                "forge": forge,
                "claim_token": claim_token,
            },
        )

    def claim(self, name):
        """The SPA holds a name before the repo it will belong to exists."""
        return self.client.post("/registry/claim", json={"name": name})

    def lookup(self, name):
        return self.client.get("/registry/api/slug/" + name)

    def expire_claim(self, name):
        """Backdate a claim, standing in for CLAIM_TTL_MINUTES passing."""
        conn = sqlite3.connect(registry.store.db_path)
        try:
            with conn:
                conn.execute(
                    "UPDATE slugs SET expires_at = '2020-01-01T00:00:00+00:00'"
                    " WHERE name = ?",
                    (name,),
                )
        finally:
            conn.close()

    # ------------------------------------------------------------ happy path

    def test_register_then_resolve(self):
        r = self.register("lute-tablature", repo_id=987)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(
            r.get_json(),
            {"name": "lute-tablature", "status": "active", "forge": "github", "repo_id": 987},
        )
        self.assertEqual(
            self.lookup("lute-tablature").get_json(),
            {"name": "lute-tablature", "status": "active", "forge": "github", "repo_id": 987},
        )

    def test_register_is_idempotent_for_same_repo(self):
        self.assertEqual(self.register("same-name", repo_id=42).status_code, 201)
        # A retry with the same repo id succeeds (200), not a collision.
        r = self.register("same-name", repo_id=42)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["repo_id"], 42)

    def test_register_collision_different_repo_is_409(self):
        self.assertEqual(self.register("hot-name", repo_id=1).status_code, 201)
        r = self.register("hot-name", repo_id=2)
        self.assertEqual(r.status_code, 409)
        self.assertIn("already taken", r.get_json()["error"])

    # ---------------------------------------------------------------- claims

    def test_claim_then_register_with_token(self):
        r = self.claim("held-name")
        self.assertEqual(r.status_code, 201)
        body = r.get_json()
        self.assertEqual(body["status"], "pending")
        self.assertTrue(body["claim_token"])

        r = self.register("held-name", repo_id=77, claim_token=body["claim_token"])
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.lookup("held-name").get_json()["status"], "active")

    def test_claimed_name_is_occupied_but_not_a_campaign(self):
        self.claim("mid-setup")
        self.assertEqual(
            self.lookup("mid-setup").get_json(),
            {"name": "mid-setup", "status": "pending", "forge": None, "repo_id": None},
        )
        # Nobody else can claim or register it while the claim stands.
        self.assertEqual(self.claim("mid-setup").status_code, 409)
        self.assertEqual(self.register("mid-setup", repo_id=2).status_code, 409)

    def test_register_needs_the_claims_own_token(self):
        token = self.claim("someones-name").get_json()["claim_token"]
        self.assertEqual(
            self.register("someones-name", repo_id=5, claim_token="not-it").status_code, 409
        )
        self.assertEqual(
            self.register("someones-name", repo_id=5, claim_token=token).status_code, 201
        )

    def test_release_frees_a_claimed_name(self):
        token = self.claim("second-thoughts").get_json()["claim_token"]
        # The wrong token gives nothing away.
        r = self.client.delete(
            "/registry/claim/second-thoughts", json={"claim_token": "nope"}
        )
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.lookup("second-thoughts").get_json()["status"], "pending")

        r = self.client.delete(
            "/registry/claim/second-thoughts", json={"claim_token": token}
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.lookup("second-thoughts").get_json()["status"], "free")
        self.assertEqual(self.claim("second-thoughts").status_code, 201)

    def test_expired_claim_occupies_nothing(self):
        self.claim("abandoned")
        self.expire_claim("abandoned")
        # Reported free, and free to take.
        self.assertEqual(self.lookup("abandoned").get_json()["status"], "free")
        self.assertEqual(self.claim("abandoned").status_code, 201)

    def test_running_out_does_not_revoke_the_claims_own_token(self):
        # A slow setup keeps the right to its name: the claim running out only
        # lets someone else take it, so an untaken name still activates after.
        token = self.claim("slow-setup").get_json()["claim_token"]
        self.expire_claim("slow-setup")
        r = self.register("slow-setup", repo_id=31, claim_token=token)
        self.assertEqual(r.status_code, 201)

    def test_taken_over_claim_can_no_longer_activate(self):
        token = self.claim("contested").get_json()["claim_token"]
        self.expire_claim("contested")
        self.assertEqual(self.claim("contested").status_code, 201)  # someone else takes it
        r = self.register("contested", repo_id=9, claim_token=token)
        self.assertEqual(r.status_code, 409)

    def test_claim_refuses_occupied_and_invalid_names(self):
        self.register("live-already", repo_id=3)
        self.assertEqual(self.claim("live-already").status_code, 409)
        self.assertEqual(self.claim("Bad--Name").status_code, 422)
        self.assertEqual(self.claim("admin").status_code, 422)

    def test_register_without_a_claim_still_works_on_a_free_name(self):
        # The registry does not require a name to have been claimed first.
        self.assertEqual(self.register("unclaimed-name", repo_id=64).status_code, 201)

    # ----------------------------------------------------------- session gate

    def test_claim_register_and_release_require_the_session(self):
        token = self.claim("mine").get_json()["claim_token"]
        self.log_out()
        self.assertEqual(self.claim("logged-out").status_code, 401)
        self.assertEqual(self.register("logged-out", repo_id=8).status_code, 401)
        r = self.client.delete("/registry/claim/mine", json={"claim_token": token})
        self.assertEqual(r.status_code, 401)
        # The resolver stays public: logged-out visitors browse campaigns by name.
        self.assertEqual(self.lookup("mine").get_json()["status"], "pending")

    # ------------------------------------------------------------- api states

    def test_api_slug_reports_states(self):
        self.assertEqual(
            self.lookup("nope-yet").get_json(),
            {"name": "nope-yet", "status": "free", "forge": None, "repo_id": None},
        )
        self.register("live-one", repo_id=555)
        self.assertEqual(
            self.lookup("live-one").get_json(),
            {"name": "live-one", "status": "active", "forge": "github", "repo_id": 555},
        )
        self.assertEqual(self.lookup("admin").get_json()["status"], "reserved")
        self.assertEqual(self.lookup("Bad--Name").status_code, 400)

    def test_register_same_id_different_forge_is_collision(self):
        # The name is the identity; a second campaign can't take it even if only
        # the forge differs. The forge qualifies repo_id so ids never mix.
        self.assertEqual(self.register("shared-id", repo_id=7, forge="github").status_code, 201)
        r = self.register("shared-id", repo_id=7, forge="gitlab")
        self.assertEqual(r.status_code, 409)

    # ----------------------------------------------------- validation at HTTP

    def test_register_rejects_invalid_names(self):
        for name in ("ab", "Nope", "-abc", "abc-", "ab--cd", "my_name"):
            with self.subTest(name=name):
                r = self.register(name)
                self.assertEqual(r.status_code, 422)
                self.assertIn("3-40 characters", r.get_json()["error"])

    def test_register_refuses_reserved_paths(self):
        for name in ("api", "admin", "static", "assets", "auth", "registry", "campaign"):
            with self.subTest(name=name):
                r = self.register(name)
                self.assertEqual(r.status_code, 422)
                self.assertIn("reserved", r.get_json()["error"])

    def test_register_requires_an_integer_repo_id(self):
        r = self.client.post(
            "/registry/register", json={"name": "fine-name", "repo_id": "12"}
        )
        self.assertEqual(r.status_code, 422)

    def test_app_origin_top_level_paths_are_unregistrable(self):
        # A campaign lives at /<name> on the app's own origin, so every
        # top-level path the origin serves must never be claimable as a
        # campaign name: it must fail slug syntax or be reserved. Covers the
        # SvelteKit routes, the static root files, SvelteKit's own mounts, and
        # the nginx/vite proxy mounts (deploy/nginx.conf, vite.config.js).
        root = Path(__file__).resolve().parent.parent
        names = {
            entry.name
            for entry in (root / "src" / "routes").iterdir()
            if entry.is_dir() and not entry.name.startswith("[")
        }
        names |= {entry.name for entry in (root / "static").iterdir()}
        names |= {"_app", "auth", "registry"}
        for name in names:
            with self.subTest(name=name):
                self.assertIsNotNone(slug_validation.registration_error(name))

    # ------------------------------------------------------------- tombstones

    def test_tombstone_prevents_reregistration(self):
        self.register("doomed-name")
        r = self.client.delete(
            "/registry/admin/slugs/doomed-name", headers=AUTH, json={"notes": "abusive"}
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.lookup("doomed-name").get_json()["status"], "tombstoned")
        # A tombstoned name stays occupied: re-registration collides.
        self.assertEqual(self.register("doomed-name", repo_id=999).status_code, 409)

    def test_tombstone_unknown_name_404(self):
        r = self.client.delete("/registry/admin/slugs/never-existed", headers=AUTH)
        self.assertEqual(r.status_code, 404)

    # ------------------------------------------------------------------ admin

    def test_admin_requires_token(self):
        self.assertEqual(self.client.get("/registry/admin/slugs").status_code, 401)
        self.assertEqual(
            self.client.get(
                "/registry/admin/slugs", headers={"Authorization": "Bearer wrong"}
            ).status_code,
            401,
        )
        self.assertEqual(self.client.get("/registry/admin/slugs", headers=AUTH).status_code, 200)

    def test_admin_disabled_without_token(self):
        del os.environ["ADMIN_TOKEN"]
        try:
            r = self.client.get("/registry/admin/slugs", headers=AUTH)
            self.assertEqual(r.status_code, 503)
        finally:
            os.environ["ADMIN_TOKEN"] = ADMIN_TOKEN

    def test_admin_list(self):
        self.register("one-name", repo_id=321)
        r = self.client.get("/registry/admin/slugs", headers=AUTH)
        self.assertEqual(r.status_code, 200)
        rows = r.get_json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "one-name")
        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["repo_id"], 321)


if __name__ == "__main__":
    unittest.main()
