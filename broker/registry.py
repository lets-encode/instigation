"""Campaign name registry (slug registry) blueprint.

Owns exactly one thing: the mapping from a campaign's user-chosen name to the
forge repo id of its repository — the name is the campaign's address (/<name>
on this origin) and its repo name at once, while the repo id is the stable,
rename/transfer-proof reference the SPA resolves in the background. One SQLite
table (see slug_db.py); no campaign content, no analytics.

Mounted by app.py under /registry, on the same origin as the SPA (the Vite dev
proxy and the production reverse proxy pass the path through unchanged, see
deploy/apache.conf). Claiming and registering a
name require the GitHub session — only logged-in users can create campaigns —
while the resolver is public, so logged-out visitors can browse campaigns.

A name is taken in two steps, because a campaign's setup takes a while and the
name has to be safe for the whole of it, while the repo id the name is stored
against only exists once the campaign does:

    POST /claim     holds the name the moment the organiser picks it, against a
                    claim token, for CLAIM_TTL_MINUTES. No repo id needed.
    POST /register  presents that token when the campaign is finished, turning
                    the claim into the live campaign.

So the two statuses say exactly one thing each: `pending` is a setup in
progress, `active` is a campaign that exists. A setup that is never finished
never becomes a campaign, and its name comes back.

A claim is a lease. Running out does not revoke the token — it only lets
someone else take the name — so a long setup loses the name only if somebody
actually wanted it. A claim nobody promotes occupies nothing once it has run
out; it is dropped on the next write and read as free before that, so no
sweeper is needed.

Route map (paths relative to the /registry mount):
    POST   /claim            → { name } → holds it: 201 { claim_token,
                               expires_at }, 409 if occupied, 422 invalid.
    DELETE /claim/<name>     → { claim_token } → gives the name back.
    POST   /register         → { name, repo_id, forge, claim_token } → stores
                               the mapping. 201, 200 (idempotent repeat),
                               409 on collision, 422 invalid, 403 without push
                               permission on the repo, 404 unknown repo.
    GET    /api/slug/<name>  → public resolver: { name, status, forge,
                               repo_id } (forge/repo_id only when active).
    GET    /admin/slugs          → list everything (JSON).
    DELETE /admin/slugs/<name>   → tombstone a name (row kept, stays occupied).

Admin routes are gated by the ADMIN_TOKEN bearer check — a dev/local fallback
and defence in depth, not a production auth system. In production the reverse
proxy must enforce institutional auth for /registry/admin/ before requests
reach the broker (see deploy/apache.conf). The routes serve only when
ADMIN_TOKEN and ADMIN_ROUTES_ENABLED=1 are both set; otherwise they return 503
(fail closed).
"""

import secrets
import sqlite3
from os import getenv, path

import requests
from flask import Blueprint, jsonify, request, session

try:
    from . import slug_validation as validation
    from .slug_db import SlugExists, Store, in_minutes_iso, now_iso
except ImportError:  # run as top-level modules (flask --app app run, gunicorn app:app)
    import slug_validation as validation
    from slug_db import SlugExists, Store, in_minutes_iso, now_iso

# How long a claimed name is held before anyone else may take it. It spans a
# whole campaign setup — from the name being chosen to the finished campaign
# being registered — including setups picked up again after a break, so it is
# generous. Presenting the claim's own token still works after this has passed,
# as long as nobody else has taken the name; a setup that is given up releases
# its name at once rather than waiting this out.
CLAIM_TTL_MINUTES = 24 * 60

GITHUB_API = "https://api.github.com"

# The slug database sits next to the session files in the (gitignored, never
# served) instance folder unless DB_PATH says otherwise. The entire registry
# state is this one file — back it up by copying it.
store = Store(
    getenv("DB_PATH")
    or path.join(path.dirname(path.abspath(__file__)), "instance", "slugs.db")
)

registry = Blueprint("registry", __name__)


def _occupying(row: sqlite3.Row | None) -> bool:
    """Whether a row still occupies its name. A claim that has run out does not:
    reads report the name as free, and the next write drops the row."""
    return row is not None and not (
        row["status"] == "pending" and row["expires_at"] < now_iso()
    )


@registry.post("/claim")
def claim():
    """Hold a name for the caller for the length of a campaign's setup, before
    there is a campaign to register it against. The returned token is the right
    to activate the name later (POST /register) or to give it back
    (DELETE /claim/<name>). Occupied name → 409, invalid name → 422."""
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "").strip()
    error = validation.registration_error(name)
    if error is not None:
        return jsonify(error=error), 422
    store.drop_expired_claim(name)
    claim_token = secrets.token_urlsafe(24)
    expires_at = in_minutes_iso(CLAIM_TTL_MINUTES)
    try:
        store.create_pending(name, claim_token, expires_at)
    except SlugExists:
        return jsonify(error="'{}' is already taken".format(name)), 409
    return (
        jsonify(
            name=name,
            status="pending",
            claim_token=claim_token,
            expires_at=expires_at,
        ),
        201,
    )


@registry.delete("/claim/<name>")
def release(name):
    """Give a claimed name back, so a campaign renamed before its repo exists
    does not leave its first name held. 404 if the name is not claimed under
    this token."""
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    body = request.get_json(silent=True) or {}
    if not store.release(name, str(body.get("claim_token") or "")):
        return jsonify(error="'{}' is not claimed by you".format(name)), 404
    return jsonify(name=name, status="free")


def _push_permission_error(forge, repo_id):
    """The repo-ownership gate for /register, as the error to return or None.
    The session's token must see the repository at GitHub and hold push
    permission on it, so a name cannot be registered against somebody else's
    repo (or a repo id picked at random)."""
    if forge != "github":
        return (
            jsonify(
                error="repository ownership can only be verified on github"
            ),
            404,
        )
    try:
        response = requests.get(
            "{}/repositories/{}".format(GITHUB_API, repo_id),
            headers={
                "Authorization": "token " + session["githubToken"],
                "Accept": "application/vnd.github+json",
            },
            timeout=(10, 60),
        )
    except requests.RequestException:
        return jsonify(error="could not verify the repository"), 502
    if response.status_code == 404:
        return (
            jsonify(error="no repository with id {}".format(repo_id)),
            404,
        )
    if not response.ok:
        return jsonify(error="could not verify the repository"), 502
    permissions = response.json().get("permissions") or {}
    if not permissions.get("push"):
        return (
            jsonify(
                error="push permission on repository {} is required".format(
                    repo_id
                )
            ),
            403,
        )
    return None


@registry.post("/register")
def register():
    """Register a name once the campaign exists, passing the chosen name, its
    repo's numeric id, the forge (which qualifies the id so different forges'
    ids never collide) and the token the name was claimed under. The session's
    GitHub token must show push permission on the repo (403 otherwise; an
    unknown repo or a non-github forge is 404). Activating an
    own claim works even after the claim has run out, as long as nobody else
    has taken the name since. Idempotent: a repeat with the same
    (forge, repo_id) succeeds (200). A different repo on an occupied name is a
    genuine collision (409). Invalid name → 422."""
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "").strip()
    error = validation.registration_error(name)
    if error is not None:
        return jsonify(error=error), 422
    repo_id = body.get("repo_id")
    if not isinstance(repo_id, int) or isinstance(repo_id, bool):
        return jsonify(error="repo_id must be an integer"), 422
    forge = str(body.get("forge") or "github")
    claim_token = body.get("claim_token") or None
    denied = _push_permission_error(forge, repo_id)
    if denied:
        return denied
    active = {"name": name, "status": "active", "forge": forge, "repo_id": repo_id}
    if store.activate(name, forge, repo_id, claim_token):
        return jsonify(**active), 201
    # No claim of ours to activate: the name must be free — either never
    # claimed, or claimed by someone who let it run out.
    store.drop_expired_claim(name)
    try:
        store.create_active(name, forge, repo_id)
    except SlugExists:
        row = store.get(name)
        if (
            row is not None
            and row["status"] == "active"
            and row["forge"] == forge
            and row["repo_id"] == repo_id
        ):
            return jsonify(**active)
        return jsonify(error="'{}' is already taken".format(name)), 409
    return jsonify(**active), 201


@registry.get("/api/slug/<name>")
def api_slug(name):
    """Public resolver: report a name's state and, when it is a live campaign,
    its forge + repo id. Malformed names are 400; every other state (free /
    pending / active / reserved / tombstoned) is 200 with a `status`."""
    if validation.syntax_error(name):
        return jsonify(error=validation.ERR_SYNTAX), 400
    row = store.get(name)
    if not _occupying(row):
        status = "reserved" if validation.registration_error(name) else "free"
        return jsonify(name=name, status=status, forge=None, repo_id=None)
    active = row["status"] == "active"
    return jsonify(
        name=name,
        status=row["status"],
        forge=row["forge"] if active else None,
        repo_id=row["repo_id"] if active else None,
    )


def _admin_error():
    """The admin gate, as the error to return or None. Reads the environment
    per request, and fails closed (503) unless ADMIN_TOKEN and
    ADMIN_ROUTES_ENABLED=1 are BOTH set — a token set for CLI use alone must
    not expose the routes."""
    admin_token = getenv("ADMIN_TOKEN")
    if not admin_token or getenv("ADMIN_ROUTES_ENABLED") != "1":
        return jsonify(error="admin interface disabled"), 503
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(
        token.strip(), admin_token
    ):
        return jsonify(error="invalid admin token"), 401
    return None


@registry.get("/admin/slugs")
def admin_list():
    denied = _admin_error()
    if denied:
        return denied
    return jsonify([dict(row) for row in store.list_all()])


@registry.delete("/admin/slugs/<name>")
def admin_delete(name):
    """Tombstone a slug. The row is kept so the name cannot be re-registered."""
    denied = _admin_error()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    if not store.tombstone(name, body.get("notes")):
        return jsonify(error="'{}' does not exist".format(name)), 404
    return jsonify(name=name, status="tombstoned")
