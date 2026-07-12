#!/bin/sh
set -eu

if command -v node >/dev/null 2>&1; then
  exec node "$(dirname "$0")/render-video.mjs" "$@"
fi

CODEX_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$CODEX_NODE" ]; then
  exec "$CODEX_NODE" "$(dirname "$0")/render-video.mjs" "$@"
fi

echo "Node.js was not found. Install Node.js or run render-video.mjs with the Codex bundled Node runtime." >&2
exit 1
