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
# Wrap the app in ProxyFix as the deployed broker is (one reverse proxy).
os.environ["PROXY_FIX_X_FOR"] = "1"
# Keep the registry's import-time store out of broker/instance/ during tests.
os.environ.setdefault("DB_PATH", os.path.join(_session_dir.name, "slugs.db"))

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

    def test_omr_api_is_gated_configured_and_allowlisted(self):
        self.assertEqual(self.client.get("/omr/api/pipelines").status_code, 401)
        self.authenticate()
        with patch.object(broker, "MUSIBOT_TOKEN", None):
            response = self.client.get("/omr/api/pipelines")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["source"], "musibot")

        with patch.object(broker, "MUSIBOT_TOKEN", "musibot-token"):
            # The page listing and any unlisted endpoint are refused before
            # anything reaches the service.
            with patch.object(broker.requests, "request") as upstream:
                self.assertEqual(self.client.get("/omr/api/musicorpus-pages").status_code, 404)
                self.assertEqual(self.client.post("/omr/api/public-sessions").status_code, 404)
                self.assertEqual(
                    self.client.get("/omr/api/musicorpus-pages/abc/pipeline-executions").status_code,
                    404,
                )
                upstream.assert_not_called()

            relayed = SimpleNamespace(
                status_code=201,
                content=b'{"page_id":"p1","executions":[]}',
                headers={"content-type": "application/json"},
            )
            with patch.object(broker.requests, "request", return_value=relayed) as upstream:
                response = self.client.post(
                    "/omr/api/musicorpus-pages/p1/pipeline-executions",
                    data=b'{"pipeline_name":"mzk-staff"}',
                    content_type="application/json",
                )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["page_id"], "p1")
        self.assertEqual(response.headers["X-Lets-Encode-Upstream"], "musibot")
        method, url = upstream.call_args.args
        self.assertEqual((method, url), ("POST", f"{broker.MUSIBOT_URL}/musicorpus-pages/p1/pipeline-executions"))
        headers = upstream.call_args.kwargs["headers"]
        # The Musibot token goes upstream; the session's GitHub token never does.
        self.assertEqual(headers["Authorization"], "Bearer musibot-token")
        self.assertEqual(upstream.call_args.kwargs["data"], b'{"pipeline_name":"mzk-staff"}')

    def test_omr_blob_is_restricted_to_the_service_host_and_capped(self):
        self.assertEqual(self.client.get("/omr/blob?url=https://x.test/f").status_code, 401)
        self.authenticate()
        for url in ("https://evil.test/f", f"http://{broker.MUSIBOT_HOST}/f", ""):
            with patch.object(broker.requests, "get") as upstream:
                self.assertEqual(self.client.get(f"/omr/blob?url={url}").status_code, 400, url)
                upstream.assert_not_called()

        signed = f"https://{broker.MUSIBOT_HOST}/bucket/p1/image.jpg?X-Amz-Signature=abc"
        with patch.object(broker.requests, "put", return_value=SimpleNamespace(ok=True, status_code=200, close=lambda: None)) as upstream:
            response = self.client.put(f"/omr/blob?url={signed}", data=b"jpeg", content_type="image/jpeg")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(upstream.call_args.args[0], signed)
        self.assertEqual(upstream.call_args.kwargs["data"], b"jpeg")
        self.assertEqual(upstream.call_args.kwargs["headers"]["Content-Type"], "image/jpeg")

        with patch.object(broker.requests, "put") as upstream:
            response = self.client.put(
                f"/omr/blob?url={signed}",
                data=b"x" * (broker.OMR_MAX_BYTES + 1),
                content_type="image/jpeg",
            )
            self.assertEqual(response.status_code, 413)
            upstream.assert_not_called()

        downloaded = self.iiif_response(b"<score-partwise/>", "application/xml")
        with patch.object(broker.requests, "get", return_value=downloaded) as upstream:
            response = self.client.get(f"/omr/blob?url={signed}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"<score-partwise/>")
        self.assertEqual(response.headers["Content-Type"], "application/xml")
        self.assertNotIn("Authorization", upstream.call_args.kwargs.get("headers", {}))

    def test_cross_origin_writes_are_rejected(self):
        # reject_cross_origin_writes runs before any route: a POST whose Origin
        # names another host is refused even without a session.
        response = self.client.post(
            "/logout", headers={"Origin": "https://evil.test"}
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.get_json(), {"error": "cross-origin request rejected"}
        )
        # The same write from the request's own origin passes the guard.
        response = self.client.post(
            "/logout", headers={"Origin": "http://localhost"}
        )
        self.assertEqual(response.status_code, 200)

    def test_proxied_write_matches_origin_against_forwarded_host(self):
        # Apache forwards with Host set to the broker's loopback address and
        # the public host in X-Forwarded-Host.
        public = "lets-encode.example"
        response = self.client.post(
            "/logout",
            base_url="http://127.0.0.1:7777",
            headers={
                "Origin": f"https://{public}",
                "X-Forwarded-Host": public,
                "X-Forwarded-Proto": "https",
                "X-Forwarded-For": "203.0.113.5",
            },
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            "/logout",
            base_url="http://127.0.0.1:7777",
            headers={"Origin": "https://evil.test", "X-Forwarded-Host": public},
        )
        self.assertEqual(response.status_code, 403)

    def test_authorize_rotates_the_session_id(self):
        # A session ID fixed before login must not survive into the
        # authenticated session (see app.session_interface.regenerate).
        self.client.get("/login?return_to=/")
        before = self.client.get_cookie("lets_encode_session").value

        token = {"access_token": "fresh-token"}
        user = SimpleNamespace(ok=True, json=lambda: {"login": "alice"})
        with patch.object(broker.github, "authorize_access_token", return_value=token):
            with patch.object(broker.github, "get", return_value=user):
                self.client.get("/authorize")

        after = self.client.get_cookie("lets_encode_session").value
        self.assertNotEqual(before, after)
        with self.client.session_transaction() as current:
            self.assertEqual(current["githubToken"], "fresh-token")

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
