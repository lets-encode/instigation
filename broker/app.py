"""
OAuth session broker for the instigation SPA (Flask).

The full OAuth flow runs server-side (/login -> GitHub -> /authorize), the
token is stored in a server-side session, and the browser holds only an opaque
httpOnly session cookie. All authenticated GitHub API traffic from the SPA
flows through /proxy/<url>, which attaches the token from the session.

The broker must be served under the SAME origin as the SPA (mounted at /auth by
the reverse proxy in production, or by the Vite dev proxy) so the session cookie
is first-party and CORS never comes into play.

Config (environment variables, loaded from broker/.env if present):
  GITHUB_CLIENT_ID       the OAuth app's client id
  GITHUB_CLIENT_SECRET   the OAuth app's client secret (secret; only here)
  FLASK_SECRET           key that signs the session cookie (secret; generate one)
  REDIRECT_URL           the OAuth callback as the browser reaches it, e.g.
                         https://your-domain.example/oauth/authorize
  SESSION_DIR            where session files live (default: instance/sessions)
  FLASK_ENV              set to "development" to allow the cookie over plain HTTP

See README.md for setup, and deploy/apache.conf for the production mount
(deploy/nginx.conf is the equivalent for deployers running nginx).

Behind a reverse proxy the client address Flask sees is the proxy's own, so the
rate limits below would collapse into a single shared bucket. Wrap the app in
werkzeug's ProxyFix to read X-Forwarded-For, matching x_for to the number of
proxies actually in front of it.
"""

import ipaddress
import json
import socket
import sys
import time
from datetime import timedelta
from os import getenv, makedirs, chmod, path
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
from authlib.integrations.flask_client import OAuth
from cachelib.file import FileSystemCache
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, session
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_session import Session

# Load broker/.env (next to this file) into the environment — found regardless of
# the working directory flask/gunicorn is launched from. Real environment
# variables take precedence, so production can set them via the service manager.
load_dotenv(Path(__file__).with_name(".env"))

app = Flask(__name__)
development = getenv("FLASK_ENV") == "development"
app.secret_key = getenv("FLASK_SECRET")
if not app.secret_key:
    sys.exit(
        "FLASK_SECRET is not set; refusing to start with unsigned sessions."
    )
if not development and not getenv("REDIRECT_URL"):
    sys.exit(
        "REDIRECT_URL is not set; production OAuth callbacks must be explicit."
    )
if not getenv("GITHUB_CLIENT_ID") or not getenv("GITHUB_CLIENT_SECRET"):
    sys.exit("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must both be set.")

# Server-side sessions: session data (including the GitHub OAuth token) is kept
# on the server; the browser only holds an opaque session ID. With Flask's
# default client-side sessions the cookie itself would contain the token in
# base64-readable (signed, but not encrypted) form.
# The filesystem cache is shared between gunicorn workers on the same host and
# lives in the (gitignored, never-served) Flask instance folder by default, so
# sessions survive restarts and deployments without external setup. Set
# SESSION_DIR to override. No fallback on failure: refusing to start is better
# than silently landing somewhere volatile and losing all sessions later.
session_dir = getenv("SESSION_DIR") or path.join(app.instance_path, "sessions")
try:
    makedirs(session_dir, mode=0o700, exist_ok=True)
    if not getenv("SESSION_DIR"):
        # session files contain OAuth tokens: keep the default directory
        # private to the service user (an explicit SESSION_DIR is presumed
        # provisioned with intentional permissions, so leave those alone)
        chmod(session_dir, 0o700)
except OSError as e:
    sys.exit("Cannot create session directory {}: {}".format(session_dir, e))
app.config["SESSION_TYPE"] = "cachelib"
app.config["SESSION_CACHELIB"] = FileSystemCache(
    cache_dir=session_dir, threshold=1000
)
# Session cookie hygiene. Secure requires HTTPS, so switch it off for local
# development by setting FLASK_ENV=development.
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = not development
app.config["SESSION_COOKIE_NAME"] = (
    "lets_encode_session" if development else "__Host-lets_encode_session"
)
app.config["SESSION_COOKIE_PATH"] = "/"
app.config["SESSION_PERMANENT"] = False
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=12)
Session(app)

limiter = Limiter(get_remote_address, app=app, default_limits=["20 per second"])

# The campaign name registry (see registry.py): the name → (forge, repo id)
# mapping and the claim/register lifecycle around it. It lives in the broker
# because claiming and registering require the GitHub session; the /registry
# path is passed through unchanged by the production reverse proxy and by the
# Vite dev proxy.
try:
    from .registry import registry
except ImportError:  # run as a top-level module (flask --app app run, gunicorn app:app)
    from registry import registry
app.register_blueprint(registry, url_prefix="/registry")


@app.errorhandler(429)
def broker_rate_limited(_error):
    app.logger.warning(
        "github_api %s",
        json.dumps(
            {
                "source": "broker",
                "method": request.method,
                "endpoint": request.path,
                "status": 429,
                "user": session.get("userLogin"),
            },
            separators=(",", ":"),
        ),
    )
    response = jsonify(
        error="OAuth broker request rate limit exceeded", source="broker"
    )
    response.status_code = 429
    response.headers["X-Lets-Encode-Upstream"] = "broker"
    return response


oauth = OAuth(app)
github = oauth.register(
    name="github",
    client_id=getenv("GITHUB_CLIENT_ID"),
    client_secret=getenv("GITHUB_CLIENT_SECRET"),
    access_token_url="https://github.com/login/oauth/access_token",
    authorize_url="https://github.com/login/oauth/authorize",
    api_base_url="https://api.github.com/",
    client_kwargs={
        # public_repo (not the broader repo): fork/create-from-template/commit/PR
        # on public repositories, no access to the user's private repos.
        # notifications: mute the campaign repo for volunteers (see muteOnce).
        "scope": "public_repo notifications",
        "code_challenge_method": "S256",
    },
)

GITHUB_API = "https://api.github.com"
# The proxy relays only GitHub REST API calls (the SPA does no git smart-HTTP).
ALLOWED_DOMAINS = ["api.github.com"]

# /iiif relay limits. Campaign sources come from any institution's IIIF server,
# so the host cannot be an allowlist; the request is constrained instead — see
# iiif_fetch. A manifest is JSON and a canvas is one downscaled page image, so
# both fit well inside the size cap.
IIIF_MAX_BYTES = 25 * 1024 * 1024
IIIF_MAX_REDIRECTS = 5
IIIF_ALLOWED_CONTENT = ("application/json", "application/ld+json", "image/")


def resolves_to_public_address(hostname):
    """
    True when every address a hostname resolves to is publicly routable.

    The IIIF relay fetches URLs supplied by the browser, so without this it
    would be a server-side request forgery vector into anything the broker's
    network can reach — cloud metadata endpoints, loopback services, private
    LAN hosts. Every resolved address is checked, since a name can return both
    a public and a private record.
    """
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            return False
    return True


def oauth_callback_url() -> str:
    # Behind the /oauth mount the prefix and scheme are invisible to Flask, so
    # url_for can't reconstruct the externally reachable callback; REDIRECT_URL
    # states it explicitly (it must match the OAuth app's registered callback).
    return getenv("REDIRECT_URL") or request.host_url.rstrip("/") + "/authorize"


def safe_return_path(value):
    # Only same-origin absolute paths. Backslashes are rejected because browsers
    # can normalize them as URL separators ("/\\host" → "//host").
    if (
        not value
        or value.startswith("//")
        or "\\" in value
        or any(ord(char) < 0x20 for char in value)
    ):
        return "/"
    parsed = urlsplit(value)
    if not parsed.scheme and not parsed.netloc and parsed.path.startswith("/"):
        return value
    return "/"


def with_auth_error(return_to, message):
    parsed = urlsplit(return_to)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("auth_error", message))
    return urlunsplit(("", "", parsed.path, urlencode(query), parsed.fragment))


@app.route("/login")
def login():
    # Remember where the SPA wants the user back, then hand off to GitHub.
    # authlib generates and session-stores the OAuth `state` parameter.
    session["return_to"] = safe_return_path(request.args.get("return_to"))
    return github.authorize_redirect(oauth_callback_url())


@app.route("/authorize")
def authorize():
    return_to = session.pop("return_to", "/")
    try:
        token = github.authorize_access_token()
    except Exception as e:
        # Denied grant, stale/invalid state, or a failed exchange. Surface it to
        # the SPA rather than failing silently.
        return redirect(with_auth_error(return_to, str(e)))
    resp = github.get("user", token=token)
    if not resp.ok:
        return redirect(
            with_auth_error(return_to, "Could not resolve the GitHub user.")
        )
    # Replace the pre-login session ID after authentication so an ID fixed by
    # an attacker cannot become an authenticated session.
    app.session_interface.regenerate(session)
    session["githubToken"] = token["access_token"]
    session["userLogin"] = resp.json().get("login", "")
    return redirect(return_to)


def revoke_github_token(token):
    # Ask GitHub to invalidate the OAuth token so it cannot be reused after
    # logout. OAuth App tokens do not expire on their own, so without this a
    # leaked token stays valid indefinitely. Best-effort: never let a failure
    # here block the user from logging out.
    client_id = getenv("GITHUB_CLIENT_ID")
    client_secret = getenv("GITHUB_CLIENT_SECRET")
    if not (token and client_id and client_secret):
        return
    try:
        # 204 = revoked, 404 = already invalid; both leave the token unusable.
        requests.delete(
            "{}/applications/{}/token".format(GITHUB_API, client_id),
            auth=(client_id, client_secret),
            json={"access_token": token},
            headers={"Accept": "application/vnd.github+json"},
            timeout=5,
        )
    except requests.RequestException as e:
        print("Could not revoke GitHub token on logout:", e)


@app.route("/logout", methods=["POST"])
def logout():
    revoke_github_token(session.get("githubToken"))
    session.clear()
    return jsonify(ok=True)


@app.route("/iiif", methods=["GET"])
# Reading a source is one request per canvas, so a large manifest is a burst of
# hundreds. The client spaces them to stay under this ceiling (see
# IIIF_REQUESTS_PER_SECOND); the margin between the two rates leaves room for a
# manifest fetch, or a second tab, alongside a run. Lowering this without
# lowering the client's rate makes every large source fail partway.
@limiter.limit(
    "20 per second",
    key_func=lambda: session.get("userLogin") or get_remote_address(),
)
def iiif_fetch():
    """
    Relay a IIIF manifest or canvas image, same-origin, for the onboarding
    wizard.

    Campaign sources come from arbitrary institutions, which rules out both a
    CSP host allowlist and direct browser fetches (many IIIF servers send no
    CORS headers). Relaying here solves both. No credentials are attached — the
    session gates who may use the relay, nothing more — and redirects are
    followed manually so each hop is re-checked against the address rules.
    """
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    target = request.args.get("url", "")
    if not target:
        return jsonify(error="A url parameter is required"), 400

    seen_redirects = 0
    while True:
        parsed = urlsplit(target)
        if parsed.scheme != "https":
            return jsonify(error="Only https URLs are allowed"), 400
        if not parsed.hostname or not resolves_to_public_address(
            parsed.hostname
        ):
            return jsonify(error="That host is not allowed"), 400
        try:
            response = requests.get(
                target,
                headers={"accept": request.headers.get("accept", "*/*")},
                timeout=(10, 60),
                allow_redirects=False,
                stream=True,
            )
        except requests.Timeout:
            return jsonify(error="Upstream request timed out"), 504
        except requests.RequestException:
            return jsonify(error="Upstream request failed"), 502

        if response.is_redirect or response.is_permanent_redirect:
            seen_redirects += 1
            if seen_redirects > IIIF_MAX_REDIRECTS:
                response.close()
                return jsonify(error="Too many redirects"), 502
            location = response.headers.get("location", "")
            response.close()
            if not location:
                return jsonify(error="Upstream request failed"), 502
            # A relative Location resolves against the hop it came from.
            target = requests.compat.urljoin(target, location)
            continue
        break

    content_type = response.headers.get("content-type", "")
    if not content_type.startswith(IIIF_ALLOWED_CONTENT):
        response.close()
        return jsonify(error="Unexpected content type from that URL"), 415

    # Read with a ceiling rather than trusting Content-Length, which may be
    # absent or understate a chunked response.
    chunks = []
    total = 0
    for chunk in response.iter_content(64 * 1024):
        total += len(chunk)
        if total > IIIF_MAX_BYTES:
            response.close()
            return jsonify(error="That resource is too large"), 413
        chunks.append(chunk)
    response.close()

    return (
        b"".join(chunks),
        response.status_code,
        [
            ("Content-Type", content_type),
            ("Cache-Control", "no-store"),
            ("X-Lets-Encode-Upstream", "iiif"),
        ],
    )


@app.route(
    "/proxy/<path:url>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"]
)
# All authenticated GitHub traffic flows through here, and the SPA polls
# (workflow runs, fork readiness), so bursts exceed the default limit. Key by
# user login so users behind a shared institutional NAT don't throttle each
# other.
@limiter.limit(
    "30 per second",
    key_func=lambda: session.get("userLogin") or get_remote_address(),
)
def proxy(url):
    # Only logged-in users may use the proxy: it exists to attach the session's
    # token, and gating it prevents abuse as an open relay. Anonymous reads
    # (e.g. the public campaign listing) go directly to the API from the
    # browser instead.
    if "githubToken" not in session:
        return jsonify(error="Authentication required"), 401
    url = requests.utils.unquote(url)
    if not url.startswith("http"):
        url = "https://" + url
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc not in ALLOWED_DOMAINS:
        return jsonify(error="Domain not allowed"), 400
    if request.query_string:
        url += "?" + request.query_string.decode()

    # Drop hop-by-hop and identity-bearing headers: never forward our own
    # session cookie upstream, let requests set its own Host, and ignore any
    # client-supplied Authorization — credentials are attached server-side from
    # the session so that the OAuth token never needs to be present in the
    # browser.
    excluded_request_headers = {"host", "cookie", "authorization"}
    headers = {
        key: value
        for key, value in request.headers
        if key.lower() not in excluded_request_headers
    }
    headers["Authorization"] = "token " + session["githubToken"]

    # Timeout protects gunicorn workers from being parked indefinitely by a
    # hung upstream connection: 10s to connect, 60s between reads.
    started_at = time.monotonic()
    try:
        response = requests.request(
            request.method,
            url,
            headers=headers,
            data=request.get_data(),
            timeout=(10, 60),
            allow_redirects=False,
        )
    except requests.Timeout:
        return jsonify(error="Upstream request timed out"), 504
    except requests.RequestException:
        return jsonify(error="Upstream request failed"), 502

    # 'date' and 'server' must not be passed through: our own HTTP layer adds
    # its own, and duplicate Date headers are joined by browsers into a string
    # that parses as Invalid Date. Cache-directive headers must not be forwarded
    # either: these are per-request, per-user authenticated relays, and any
    # shared cache in front of us could serve a stale response — or one user's
    # response to another — on the same /proxy path. Force no-store.
    # ETag/Last-Modified ARE forwarded: the SPA stores them and sends
    # `If-None-Match` on the next read, so unchanged resources answer 304 (which
    # GitHub does not count against the API rate limit). The SPA keeps those
    # validators itself, so no shared or HTTP cache is involved.
    excluded_response_headers = {
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "www-authenticate",
        "date",
        "server",
        "set-cookie",
        "cache-control",
        "expires",
        "pragma",
        "age",
    }
    out_headers = [
        (name, value)
        for name, value in response.raw.headers.items()
        if name.lower() not in excluded_response_headers
    ]
    out_headers.append(("Cache-Control", "no-store"))
    out_headers.append(("X-Lets-Encode-Upstream", "github"))
    upstream_headers = requests.structures.CaseInsensitiveDict(
        response.raw.headers
    )
    app.logger.info(
        "github_api %s",
        json.dumps(
            {
                "source": "github",
                "method": request.method,
                "endpoint": parsed.path,
                "status": response.status_code,
                "duration_ms": round((time.monotonic() - started_at) * 1000),
                "user": session.get("userLogin"),
                "resource": upstream_headers.get("X-RateLimit-Resource"),
                "limit": upstream_headers.get("X-RateLimit-Limit"),
                "remaining": upstream_headers.get("X-RateLimit-Remaining"),
                "used": upstream_headers.get("X-RateLimit-Used"),
                "reset": upstream_headers.get("X-RateLimit-Reset"),
                "retry_after": upstream_headers.get("Retry-After"),
                "request_id": upstream_headers.get("X-GitHub-Request-Id"),
            },
            separators=(",", ":"),
        ),
    )
    return (response.content, response.status_code, out_headers)


if __name__ == "__main__":
    app.run(port=8787)
