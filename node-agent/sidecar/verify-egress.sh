#!/bin/sh
# Print the address this network namespace egresses from, or fail.
#
# Run with `docker exec <sidecar> vortex-verify`. It runs as root inside the
# namespace, which means it is subject to exactly the same redirection and DROP
# rules as the tenant: the request has to resolve a hostname through the dnstc
# -> TCP -> proxy path and then complete a TLS connection through redsocks. If
# either leg is broken this exits non-zero and prints nothing usable, which is
# what the agent turns into "do not start the desktop".
set -eu
URL="${1:-${PROXY_CHECK_URL:-https://api.ipify.org}}"
TIMEOUT="${2:-${VERIFY_TIMEOUT:-12}}"
exec curl -sS --fail --max-time "$TIMEOUT" "$URL"
