#!/usr/bin/env bash
# registry-admin.sh — Let's Encode! campaign name registry admin client.
#
# Usage:
#   scripts/registry-admin.sh <instance> list
#   scripts/registry-admin.sh <instance> tombstone <name> [--notes "<why>"]
#   scripts/registry-admin.sh --help
#
# Commands:
#   list        Print every registered name with its state (JSON).
#   tombstone   Retire <name>: its campaign stops resolving, and the row is kept
#               so the name can never be registered again. Cannot be undone;
#               you are asked to type the name to confirm. --notes records why.
#
# Instances:
#   A name from the INSTANCES table at the top of this script, or any origin,
#   e.g. https://example.org.
#
# The admin token:
#   Asked for on the terminal and not echoed; paste it and press Enter. For
#   scripting, set REGISTRY_ADMIN_TOKEN instead. The token never appears on a
#   command line (curl reads the Authorization header from stdin, so `ps`
#   cannot show it) and is not stored.
#
# Where it works:
#   The broker must have ADMIN_TOKEN and ADMIN_ROUTES_ENABLED=1 in its
#   environment. If the reverse proxy restricts /registry/admin/ to certain
#   networks, requests from anywhere else are refused with 403 whatever the
#   token.
#
# Exit status:
#   0 success; 1 refused or failed (the HTTP status is explained on stderr:
#   401 wrong token, 403 refused by the reverse proxy, 404 unknown name, 503
#   admin routes disabled); 2 usage error.
#
# Examples:
#   scripts/registry-admin.sh testing list
#   scripts/registry-admin.sh production tombstone spam-campaign --notes "spam, reported by …"
#   scripts/registry-admin.sh local tombstone no-such-campaign   # a safe test: 404
#
# Needs curl; jq for --notes and for pretty-printed output. Written for bash 3.2
# (macOS's /bin/bash) as well as current bash.

# ---- Your deployment's instances: one "name origin" pair per line. Edit these.
INSTANCES='
production  https://lets-encode.mdw.ac.at
staging     https://staging.lets-encode.mdw.ac.at
testing     https://testing.lets-encode.mdw.ac.at
local       http://localhost:8080
'

set -euo pipefail

# The comment block above, without its leading "# ".
help_text() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

help() {
  help_text
  echo
  echo "Configured instances:"
  printf '%s\n' "$INSTANCES" | awk 'NF == 2 { printf "  %-11s %s\n", $1, $2 }'
  exit 0
}

# Just the Usage section, for mistakes.
usage() {
  help_text | awk '/^Usage:/ { on = 1 } on && /^$/ { exit } on' >&2
  echo "Run with --help for the full documentation." >&2
  exit 2
}

case ${1:-} in -h | --help | help) help ;; esac
case ${2:-} in -h | --help) help ;; esac

[ $# -ge 2 ] || usage
instance=$1
command=$2
shift 2

case $instance in
  http://* | https://*) origin=${instance%/} ;;
  *)
    origin=$(printf '%s\n' "$INSTANCES" |
      awk -v name="$instance" 'NF == 2 && $1 == name { print $2; exit }')
    [ -n "$origin" ] || {
      echo "unknown instance '$instance' (see --help for the configured ones)" >&2
      exit 2
    }
    ;;
esac

case $command in
  list)
    [ $# -eq 0 ] || usage
    method=GET
    path=/registry/admin/slugs
    body=
    ;;
  tombstone)
    [ $# -ge 1 ] || usage
    name=$1
    shift
    notes=
    if [ $# -gt 0 ]; then
      [ $# -eq 2 ] && [ "$1" = --notes ] || usage
      notes=$2
    fi
    # Refuse names that would change the URL path rather than name a slug.
    case $name in
      *[!a-z0-9-]* | "")
        echo "'$name' is not a valid campaign name" >&2
        exit 2
        ;;
    esac
    method=DELETE
    path=/registry/admin/slugs/$name
    if [ -n "$notes" ]; then
      command -v jq >/dev/null || {
        echo "--notes needs jq" >&2
        exit 2
      }
      body=$(jq -cn --arg notes "$notes" '{notes: $notes}')
    else
      body=
    fi
    # A tombstone keeps the row, so the name can never be registered again.
    printf 'Tombstone "%s" on %s? It cannot be undone. Type the name to confirm: ' \
      "$name" "$origin" >/dev/tty
    read -r confirm </dev/tty
    [ "$confirm" = "$name" ] || {
      echo "not confirmed; nothing changed" >&2
      exit 1
    }
    ;;
  *) usage ;;
esac

if [ -n "${REGISTRY_ADMIN_TOKEN:-}" ]; then
  token=$REGISTRY_ADMIN_TOKEN
else
  read -rsp 'Admin token: ' token </dev/tty
  echo >/dev/tty
fi
[ -n "$token" ] || {
  echo "no token given" >&2
  exit 2
}

response=$(mktemp "${TMPDIR:-/tmp}/registry-admin.XXXXXX")
trap 'rm -f "$response"' EXIT

curl_args=(-sS -o "$response" -w '%{http_code}' -X "$method" -H @-)
if [ -n "$body" ]; then
  curl_args+=(-H 'Content-Type: application/json' --data "$body")
fi
status=$(printf 'Authorization: Bearer %s\n' "$token" |
  curl "${curl_args[@]}" "$origin$path") || true
unset token

case $status in
  2??)
    if command -v jq >/dev/null; then jq . "$response"; else cat "$response"; fi
    ;;
  401) echo "401: the broker rejected the token" >&2 ;;
  403) echo "403: refused by the reverse proxy — not from a network allowed to use the admin API" >&2 ;;
  404) echo "404: $(jq -r '.error // empty' "$response" 2>/dev/null || true)" >&2 ;;
  503) echo "503: the admin routes are disabled (the broker needs ADMIN_TOKEN and ADMIN_ROUTES_ENABLED=1)" >&2 ;;
  *)
    echo "HTTP $status from $origin$path" >&2
    cat "$response" >&2
    ;;
esac
case $status in 2??) exit 0 ;; *) exit 1 ;; esac
