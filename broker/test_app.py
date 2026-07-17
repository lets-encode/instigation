import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit


_session_dir = tempfile.TemporaryDirectory()
os.environ["FLASK_ENV"] = "development"
os.environ["FLASK_SECRET"] = "test-secret"
os.environ["GITHUB_CLIENT_ID"] = "test-client"
os.environ["GITHUB_CLIENT_SECRET"] = "test-client-secret"
os.environ["SESSION_DIR"] = _session_dir.name

from broker import app as broker  # noqa: E402


class BrokerTest(unittest.TestCase):
    def setUp(self):
        broker.app.config["TESTING"] = True
        self.client = broker.app.test_client()

    def authenticate(self):
        with self.client.session_transaction() as current:
            current["githubToken"] = "server-side-token"
            current["userLogin"] = "alice"

    def test_return_path_is_same_origin_and_auth_error_preserves_query(self):
        self.assertEqual(broker.safe_return_path("/campaign/owner/repo?view=table"), "/campaign/owner/repo?view=table")
        for unsafe in ("https://evil.test/", "//evil.test/", "///evil.test/", "/\\evil.test/", "javascript:alert(1)"):
            self.assertEqual(broker.safe_return_path(unsafe), "/")

        with self.client.session_transaction() as current:
            current["return_to"] = "/campaign/owner/repo?view=table"
        with patch.object(broker.github, "authorize_access_token", side_effect=RuntimeError("denied")):
            response = self.client.get("/authorize")
        location = urlsplit(response.headers["Location"])
        self.assertEqual(location.path, "/campaign/owner/repo")
        self.assertEqual(parse_qs(location.query), {"view": ["table"], "auth_error": ["denied"]})

    def test_login_uses_state_pkce_and_the_required_scopes(self):
        response = self.client.get("/login?return_to=/campaign")
        params = parse_qs(urlsplit(response.headers["Location"]).query)

        self.assertEqual(params["scope"], ["repo notifications"])
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertTrue(params["code_challenge"][0])
        self.assertTrue(params["state"][0])

    def test_proxy_requires_authentication_and_rejects_other_hosts(self):
        self.assertEqual(self.client.get("/proxy/api.github.com/user").status_code, 401)
        self.authenticate()
        self.assertEqual(self.client.get("/proxy/api.github.com.evil.test/user").status_code, 400)

    def test_proxy_replaces_identity_headers_and_filters_the_response(self):
        self.authenticate()
        upstream = SimpleNamespace(
            content=b'{"login":"alice"}',
            status_code=200,
            raw=SimpleNamespace(
                headers={
                    "ETag": '"user-v1"',
                    "Cache-Control": "private",
                    "Set-Cookie": "upstream=bad; Path=/",
                    "Content-Type": "application/json",
                }
            ),
        )

        with patch.object(broker.requests, "request", return_value=upstream) as request_upstream:
            response = self.client.get(
                "/proxy/api.github.com/user?detail=full",
                headers={"Authorization": "Bearer browser-token", "X-Test": "kept"},
            )

        method, url = request_upstream.call_args.args
        options = request_upstream.call_args.kwargs
        self.assertEqual((method, url), ("GET", "https://api.github.com/user?detail=full"))
        self.assertEqual(options["headers"]["Authorization"], "token server-side-token")
        self.assertNotIn("Cookie", options["headers"])
        self.assertNotIn("Host", options["headers"])
        self.assertEqual(options["headers"]["X-Test"], "kept")
        self.assertFalse(options["allow_redirects"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["ETag"], '"user-v1"')
        self.assertNotIn("upstream=bad", response.headers.getlist("Set-Cookie"))

    def test_proxy_maps_upstream_timeouts(self):
        self.authenticate()
        with patch.object(broker.requests, "request", side_effect=broker.requests.Timeout):
            response = self.client.get("/proxy/api.github.com/user")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.get_json(), {"error": "Upstream request timed out"})

    def test_logout_revokes_then_clears_the_session(self):
        self.authenticate()
        with patch.object(broker, "revoke_github_token") as revoke:
            response = self.client.post("/logout")
        revoke.assert_called_once_with("server-side-token")
        self.assertEqual(response.get_json(), {"ok": True})
        with self.client.session_transaction() as current:
            self.assertNotIn("githubToken", current)
            self.assertNotIn("userLogin", current)


if __name__ == "__main__":
    unittest.main()
