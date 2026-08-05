"""Slug validation: allowlist by shape, then reserved names.

The regex ^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$ on its own would admit
single-character names and internal double hyphens, which the rules forbid
(length 3-40, no double hyphens), so length and '--' are checked explicitly on
top of the regex.

There is deliberately no profanity/abuse blocklist: abusive names are handled
reactively by staff via the admin tombstone (see registry.py), not filtered at
registration.
"""

from __future__ import annotations

import re

# Names that can never be registered as campaign slugs. A campaign lives at
# /<name> on the app's own origin, so every top-level path the origin serves —
# SvelteKit routes, reverse-proxy mounts (deploy/apache.conf), and likely
# future routes —
# must be unregistrable. Paths containing characters outside [a-z0-9-] or
# shorter than 3 characters (e.g. _app, favicon.svg, robots.txt, /c) already
# fail the shape rules, so only plain word paths need listing here.
# test_registry.py checks the routes and mounts against this list.
RESERVED_NAMES: frozenset[str] = frozenset(
    {
        # reverse-proxy / vite mounts on the app origin
        "auth",
        "registry",
        # current and likely future top-level routes / root paths
        "campaign",
        "campaigns",
        "dashboard",
        "search",
        "admin",
        "api",
        "assets",
        "static",
        "new",
        "join",
        "www",
        "index",
        "health",
        "healthz",
        "login",
        "logout",
    }
)

SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$")

MIN_LEN = 3
MAX_LEN = 40

# Distinct rejection classes, so tests and UI copy can tell them apart.
ERR_SYNTAX = (
    "Names must be 3-40 characters: lowercase letters, digits, and single "
    "internal hyphens (no leading, trailing, or double hyphens)."
)
ERR_RESERVED = "That name is reserved and cannot be used for a campaign."


def syntax_error(name: str) -> str | None:
    """Return an error message if the name fails shape rules, else None."""
    if not isinstance(name, str) or not name:
        return ERR_SYNTAX
    if "%" in name:  # percent-encoding is rejected outright, never decoded
        return ERR_SYNTAX
    if not (MIN_LEN <= len(name) <= MAX_LEN):
        return ERR_SYNTAX
    if "--" in name:
        return ERR_SYNTAX
    if not SLUG_RE.fullmatch(name):
        return ERR_SYNTAX
    return None


def registration_error(name: str) -> str | None:
    """Full check for registering a new campaign slug: shape, then reserved
    names. Abusive names are not filtered here — see the module docstring."""
    err = syntax_error(name)
    if err:
        return err
    if name in RESERVED_NAMES:
        return ERR_RESERVED
    return None
