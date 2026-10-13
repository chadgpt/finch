#!/usr/bin/env bash
# Start a public HTTPS tunnel to the local provider using localhost.run (SSH-based, no install).
#
# Usage:
#   scripts/tunnel.sh              # tunnel to 127.0.0.1:28891
#   scripts/tunnel.sh 9000         # tunnel to 127.0.0.1:9000
#   REMOTE_PORT=80 scripts/tunnel.sh
#
# Output:
#   Prints the public URL once the tunnel is established. The URL changes
#   every time you run this script (random subdomain). For a stable URL,
#   register a custom domain at https://admin.localhost.run/ and add your
#   SSH public key; see https://localhost.run/docs/forever-free/.
#
# Requirements:
#   - ssh (OpenSSH or compatible)
#   - The provider must be running on the target local port
#
# Stop with Ctrl-C; the SSH connection will close and the public URL will
# stop working immediately.

set -euo pipefail

LOCAL_PORT="${1:-${MOCK_PORT:-28891}}"
REMOTE_PORT="${REMOTE_PORT:-80}"
SSH_OPTS=(
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o ExitOnForwardFailure=yes
  -p 22
  -R "${REMOTE_PORT}:localhost:${LOCAL_PORT}"
  nokey@localhost.run
)

echo "Starting SSH tunnel: localhost:${LOCAL_PORT} -> public HTTPS via localhost.run"
echo "Press Ctrl-C to stop."
echo

exec ssh "${SSH_OPTS[@]}"
