"""
Stateless OAuth token broker for the instigation SPA (Flask).

The browser can't complete GitHub's OAuth flow itself: the code->token exchange
needs the client secret, and GitHub's token endpoint sends no CORS headers. This
app does only those two things -- swap a code for a token, and revoke a token on
logout -- holding the client secret. No storage, no sessions, no user data.

Config (environment variables):
  GITHUB_CLIENT_ID       the OAuth app's client id
  GITHUB_CLIENT_SECRET   the OAuth app's client secret (secret; only here)
  ALLOWED_ORIGIN         the SPA's origin, e.g. https://lets-encode.example (or *)

See README.md for how to run it (and the HTTPS/CORS notes).
"""

import os

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_API = "https://api.github.com"

CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")


@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Vary"] = "Origin"
    return resp


@app.route("/token", methods=["POST", "OPTIONS"])
def token():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    code = body.get("code")
    if not code:
        return jsonify(error="missing_code"), 400
    r = requests.post(
        GITHUB_TOKEN_URL,
        headers={"Accept": "application/json"},
        json={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": code,
            "redirect_uri": body.get("redirect_uri"),
        },
        timeout=10,
    )
    data = r.json() if r.ok else {}
    if data.get("error") or not data.get("access_token"):
        reason = data.get("error_description") or data.get("error") or "exchange_failed"
        return jsonify(error=reason), 502
    return jsonify(access_token=data["access_token"], scope=data.get("scope", ""))


@app.route("/revoke", methods=["POST", "OPTIONS"])
def revoke():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    tok = body.get("token")
    if not tok:
        return jsonify(error="missing_token"), 400
    # Authenticated with the app's client_id/client_secret (Basic auth), not the
    # user token. 204 = revoked, 404 = already invalid; both count as success.
    r = requests.delete(
        f"{GITHUB_API}/applications/{CLIENT_ID}/token",
        headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
        auth=(CLIENT_ID, CLIENT_SECRET),
        json={"access_token": tok},
        timeout=10,
    )
    return jsonify(ok=r.ok or r.status_code == 404)


if __name__ == "__main__":
    app.run(port=8787)
