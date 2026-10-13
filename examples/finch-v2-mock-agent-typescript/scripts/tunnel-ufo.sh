#!/usr/bin/env bash
# Expose the local provider on a public HTTPS URL using ufo + a persistent ufo.k0s.io relay.
#
# ufo (https://github.com/webteleport/ufo, MIT) is an open-source WebTransport-based
# tunnel tool by the webteleport team. With `ufo pub :PORT`, it allocates a public
# HTTPS URL on the configured RELAY server and forwards to your local port.
#
# Install:
#   curl -sL https://k0s.io/install.sh | bash   # puts ufo in ~/.k0s/bin
#   export PATH="$HOME/.k0s/bin:$PATH"
#
# Usage:
#   scripts/tunnel-ufo.sh              # tunnel to 127.0.0.1:28891
#   scripts/tunnel-ufo.sh 9000         # tunnel to 127.0.0.1:9000
#
# By default this uses the standard public relay at https://ufo.k0s.io (random subdomain).
# To get a PERSISTENT subdomain that survives restarts, set RELAY to a server that
# supports persistence, e.g.:
#   RELAY=https://ufoufo.k0s.io/finch-dev?persist=1 scripts/tunnel-ufo.sh
#
# Stop with Ctrl-C.

set -euo pipefail

UFO="${UFO_BIN:-$HOME/.k0s/bin/ufo}"
LOCAL_PORT="${1:-${MOCK_PORT:-28891}}"
HOST_PORT="${HOST_PORT:-0}"  # 0 = let ufo pick a free port on its side

if ! [ -x "$UFO" ]; then
  echo "ufo not found at $UFO" >&2
  echo "Install with:  curl -sL https://k0s.io/install.sh | bash" >&2
  exit 1
fi

echo "Starting ufo tunnel: localhost:${LOCAL_PORT} -> ${RELAY:-https://ufo.k0s.io}"
echo "Press Ctrl-C to stop."
echo

# ufo pub syntax (from `ufo help pub`):
#   ufo pub [host]:<port>            # forward local port to a public URL
#   :<port>                          # 0.0.0.0:<port> shorthand
HOST_ARG="${HOST_PORT}:localhost:${LOCAL_PORT}"
exec "$UFO" pub "$HOST_ARG"
