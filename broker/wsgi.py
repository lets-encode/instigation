"""WSGI entry point for the broker.

Exists so service managers can use the conventional `wsgi:app` target instead of
`app:app` — the systemd unit on the deploy host points here. `app.py` resolves
its own sibling imports and loads `broker/.env` relative to its own path, so this
shim needs no path setup of its own; it only has to run with `broker/` importable
(systemd `WorkingDirectory=`, or gunicorn's `--pythonpath`).
"""

from app import app

__all__ = ["app"]
