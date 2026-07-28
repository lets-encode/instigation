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
        self.assertEqual(broker.safe_return_path("/campaign/my-campaign?view=table"), "/campaign/my-campaign?view=table")
        for unsafe in ("https://evil.test/", "//evil.test/", "///evil.test/", "/\\evil.test/", "javascript:alert(1)"):
            self.assertEqual(broker.safe_return_path(unsafe), "/")

        with self.client.session_transaction() as current:
            current["return_to"] = "/campaign/my-campaign?view=table"
        with patch.object(broker.github, "authorize_access_token", side_effect=RuntimeError("denied")):
            response = self.client.get("/authorize")
        location = urlsplit(response.headers["Location"])
        self.assertEqual(location.path, "/campaign/my-campaign")
        self.assertEqual(parse_qs(location.query), {"view": ["table"], "auth_error": ["denied"]})

    def test_login_uses_state_pkce_and_the_required_scopes(self):
        response = self.client.get("/login?return_to=/campaign")
        params = parse_qs(urlsplit(response.headers["Location"]).query)

        self.assertEqual(params["scope"], ["public_repo notifications"])
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
                    "X-RateLimit-Resource": "core",
                    "X-RateLimit-Limit": "5000",
                    "X-RateLimit-Remaining": "4998",
                    "X-GitHub-Request-Id": "request-1",
                }
            ),
        )

        with patch.object(broker.requests, "request", return_value=upstream) as request_upstream:
            with self.assertLogs(broker.app.logger.name, level="INFO") as logs:
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
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "github")
        self.assertNotIn("upstream=bad", response.headers.getlist("Set-Cookie"))
        event = logs.output[0]
        self.assertIn('"endpoint":"/user"', event)
        self.assertIn('"remaining":"4998"', event)
        self.assertIn('"request_id":"request-1"', event)

    def test_broker_rate_limit_is_labeled_separately(self):
        with broker.app.test_request_context("/proxy/api.github.com/user"):
            with self.assertLogs(broker.app.logger.name, level="WARNING"):
                response = broker.broker_rate_limited(None)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "broker")
        self.assertEqual(response.get_json()["source"], "broker")

    def test_proxy_maps_upstream_timeouts(self):
        self.authenticate()
        with patch.object(broker.requests, "request", side_effect=broker.requests.Timeout):
            response = self.client.get("/proxy/api.github.com/user")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.get_json(), {"error": "Upstream request timed out"})

    @staticmethod
    def iiif_response(content=b"{}", content_type="application/json", status=200):
        return SimpleNamespace(
            status_code=status,
            is_redirect=False,
            is_permanent_redirect=False,
            headers={"content-type": content_type},
            iter_content=lambda _size: [content],
            close=lambda: None,
        )

    def test_iiif_requires_authentication_and_a_url(self):
        self.assertEqual(self.client.get("/iiif?url=https://ex.test/m").status_code, 401)
        self.authenticate()
        self.assertEqual(self.client.get("/iiif").status_code, 400)

    def test_iiif_rejects_non_https_and_unroutable_hosts(self):
        self.authenticate()
        # A plain-http target never reaches DNS resolution.
        response = self.client.get("/iiif?url=http://ex.test/m")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "Only https URLs are allowed")

        # Anything resolving to a private/loopback address is refused, so the
        # relay cannot be steered at the broker's own network.
        for address in ("127.0.0.1", "169.254.169.254", "10.0.0.5", "::1"):
            with patch.object(
                broker.socket,
                "getaddrinfo",
                return_value=[(None, None, None, None, (address, 0))],
            ):
                with patch.object(broker.requests, "get") as upstream:
                    response = self.client.get("/iiif?url=https://ex.test/m")
                self.assertEqual(response.status_code, 400, address)
                upstream.assert_not_called()

    def test_iiif_relays_without_credentials_and_caps_the_body(self):
        self.authenticate()
        with patch.object(broker, "resolves_to_public_address", return_value=True):
            with patch.object(
                broker.requests, "get", return_value=self.iiif_response(b'{"ok":1}')
            ) as upstream:
                response = self.client.get("/iiif?url=https://ex.test/manifest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b'{"ok":1}')
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "iiif")
        # The session's GitHub token must never be attached to a third party.
        self.assertNotIn("Authorization", upstream.call_args.kwargs["headers"])
        self.assertFalse(upstream.call_args.kwargs["allow_redirects"])

        oversized = SimpleNamespace(
            status_code=200,
            is_redirect=False,
            is_permanent_redirect=False,
            headers={"content-type": "image/jpeg"},
            iter_content=lambda _size: [b"x" * (broker.IIIF_MAX_BYTES + 1)],
            close=lambda: None,
        )
        with patch.object(broker, "resolves_to_public_address", return_value=True):
            with patch.object(broker.requests, "get", return_value=oversized):
                response = self.client.get("/iiif?url=https://ex.test/big.jpg")
        self.assertEqual(response.status_code, 413)

    def test_iiif_rejects_unexpected_content_and_revalidates_redirects(self):
        self.authenticate()
        with patch.object(broker, "resolves_to_public_address", return_value=True):
            with patch.object(
                broker.requests,
                "get",
                return_value=self.iiif_response(b"<html>", "text/html"),
            ):
                response = self.client.get("/iiif?url=https://ex.test/page")
        self.assertEqual(response.status_code, 415)

        # A redirect to a private address must be caught on the second hop.
        redirect = SimpleNamespace(
            status_code=302,
            is_redirect=True,
            is_permanent_redirect=False,
            headers={"location": "https://internal.test/secret"},
            close=lambda: None,
        )
        with patch.object(
            broker, "resolves_to_public_address", side_effect=[True, False]
        ):
            with patch.object(broker.requests, "get", return_value=redirect):
                response = self.client.get("/iiif?url=https://ex.test/m")
        self.assertEqual(response.status_code, 400)

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
