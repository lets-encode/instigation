"""
OAuth session broker for the instigation SPA (Flask).

The GitHub OAuth token never reaches the browser. The full OAuth flow runs
server-side (/login -> GitHub -> /authorize), the token is stored in a
server-side session, and the browser holds only an opaque httpOnly session
cookie. All authenticated GitHub API traffic from the SPA flows through
/proxy/<url>, which attaches the token from the session.

The broker must be served under the SAME origin as the SPA (e.g. mounted at
/oauth by nginx in production, or by the Vite dev proxy) so the session cookie
is first-party and CORS never comes into play.

Config (environment variables, loaded from broker/.env if present):
  GITHUB_CLIENT_ID       the OAuth app's client id
  GITHUB_CLIENT_SECRET   the OAuth app's client secret (secret; only here)
  FLASK_SECRET           key that signs the session cookie (secret; generate one)
  REDIRECT_URL           the OAuth callback as the browser reaches it, e.g.
                         https://your-domain.example/oauth/authorize
  SESSION_DIR            where session files live (default: instance/sessions)
  FLASK_ENV              set to "development" to allow the cookie over plain HTTP

See README.md for setup, and deploy/nginx.conf for the production mount.
"""

import sys
from datetime import timedelta
from os import getenv, makedirs, chmod, path
from pathlib import Path

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
    sys.exit("FLASK_SECRET is not set; refusing to start with unsigned sessions.")
if not development and not getenv("REDIRECT_URL"):
    sys.exit("REDIRECT_URL is not set; production OAuth callbacks must be explicit.")

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
app.config["SESSION_CACHELIB"] = FileSystemCache(cache_dir=session_dir, threshold=1000)
# Session cookie hygiene. Secure requires HTTPS, so switch it off for local
# development by setting FLASK_ENV=development.
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = not development
app.config["SESSION_COOKIE_NAME"] = "lets_encode_session" if development else "__Host-lets_encode_session"
app.config["SESSION_COOKIE_PATH"] = "/"
app.config["SESSION_PERMANENT"] = False
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=12)
Session(app)

limiter = Limiter(get_remote_address, app=app, default_limits=["20 per second"])

oauth = OAuth(app)
github = oauth.register(
    name="github",
    client_id=getenv("GITHUB_CLIENT_ID"),
    client_secret=getenv("GITHUB_CLIENT_SECRET"),
    access_token_url="https://github.com/login/oauth/access_token",
    authorize_url="https://github.com/login/oauth/authorize",
    api_base_url="https://api.github.com/",
    client_kwargs={"scope": "repo"},
)

GITHUB_API = "https://api.github.com"
# The proxy relays only GitHub REST API calls (the SPA does no git smart-HTTP).
ALLOWED_DOMAINS = ["api.github.com"]


def oauth_callback_url() -> str:
    # Behind the /oauth mount the prefix and scheme are invisible to Flask, so
    # url_for can't reconstruct the externally reachable callback; REDIRECT_URL
    # states it explicitly (it must match the OAuth app's registered callback).
    return getenv("REDIRECT_URL") or request.host_url.rstrip("/") + "/authorize"


def safe_return_path(value):
    # Only same-origin absolute paths — reject full URLs and scheme-relative
    # ("//host") values so the post-login redirect can't leave the SPA.
    if value and value.startswith("/") and not value.startswith("//"):
        return value
    return "/"


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
        return redirect(return_to + "?auth_error=" + requests.utils.quote(str(e)))
    resp = github.get("user", token=token)
    if not resp.ok:
        return redirect(return_to + "?auth_error=" + requests.utils.quote("Could not resolve the GitHub user."))
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


@app.route("/proxy/<path:url>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
# All authenticated GitHub traffic flows through here, and the SPA polls
# (workflow runs, fork readiness), so bursts exceed the default limit. Key by
# user login so users behind a shared institutional NAT don't throttle each
# other.
@limiter.limit("30 per second", key_func=lambda: session.get("userLogin") or get_remote_address())
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
        key: value for key, value in request.headers if key.lower() not in excluded_request_headers
    }
    headers["Authorization"] = "token " + session["githubToken"]

    # Timeout protects gunicorn workers from being parked indefinitely by a
    # hung upstream connection: 10s to connect, 60s between reads.
    try:
        response = requests.request(
            request.method, url, headers=headers, data=request.get_data(), timeout=(10, 60)
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
        "content-encoding", "content-length", "transfer-encoding", "connection",
        "www-authenticate", "date", "server",
        "cache-control", "expires", "pragma", "age",
    }
    out_headers = [
        (name, value)
        for name, value in response.raw.headers.items()
        if name.lower() not in excluded_response_headers
    ]
    out_headers.append(("Cache-Control", "no-store"))
    return (response.content, response.status_code, out_headers)


if __name__ == "__main__":
    app.run(port=8787)
