#!/usr/bin/env bash
# Run the speaker's agent for `make agent` (with the Supabase env already exported by
# supabase/up.sh), and beside it, when it can, the Composio CLI forwarding trigger events
# to the agent's webhook: a laptop has no public URL for Composio to POST to.
#
#   1. `aai dev` on 0.0.0.0:$PORT, where the speaker and the page reach it
#   2. `composio dev listen --forward` to /api/composio/webhook (watches.ts), signed with
#      COMPOSIO_WEBHOOK_SECRET, which the route verifies. With none in .env, this run
#      makes one and exports it to both, so they always agree.
#
# Skipped, with the reason, when the CLI isn't installed or logged in, or there is no
# COMPOSIO_API_KEY: triggers are the only thing that needs it. Its output goes to
# .composio-listen.log.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
SDK="${AAI_SDK:-$HOME/Code/aai/agent-builtin-api-tools}"
COMPOSIO="${COMPOSIO:-$(command -v composio || echo "$HOME/.local/bin/composio")}"
LISTEN_LOG=.composio-listen.log

# A name's value in .env, or empty. Never printed.
dotenv() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -1; }

cleanup() { kill "${listen_pid:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

start_listener() {
  if [ ! -x "$COMPOSIO" ]; then
    echo "triggers: no Composio CLI (curl -fsSL https://composio.dev/install | bash)" >&2
    return
  fi
  if [ -z "${COMPOSIO_API_KEY:-$(dotenv COMPOSIO_API_KEY)}" ]; then
    echo "triggers: no COMPOSIO_API_KEY in agent/.env, not listening" >&2
    return
  fi
  # whoami exits 0 logged in or not; logged out it just prints nothing.
  if [ -z "$("$COMPOSIO" whoami 2>/dev/null)" ]; then
    echo "triggers: the Composio CLI isn't logged in (composio login), not listening" >&2
    return
  fi
  # A shell export fills .env's declared name, so `aai dev` and the CLI get the same one.
  if [ -z "${COMPOSIO_WEBHOOK_SECRET:-$(dotenv COMPOSIO_WEBHOOK_SECRET)}" ]; then
    COMPOSIO_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  else
    COMPOSIO_WEBHOOK_SECRET="${COMPOSIO_WEBHOOK_SECRET:-$(dotenv COMPOSIO_WEBHOOK_SECRET)}"
  fi
  export COMPOSIO_WEBHOOK_SECRET
  "$COMPOSIO" dev listen --forward "http://127.0.0.1:$PORT/api/composio/webhook" \
    >"$LISTEN_LOG" 2>&1 &
  listen_pid=$!
  # A listener that can't connect (wrong project, expired login) exits at once: say so
  # rather than leave watches that never fire.
  (
    sleep 5
    if kill -0 "$listen_pid" 2>/dev/null; then
      echo "triggers: forwarding Composio events to /api/composio/webhook (agent/$LISTEN_LOG)" >&2
    elif grep -q "dev init" "$LISTEN_LOG" 2>/dev/null; then
      # The CLI listens to the project this directory is bound to: bind it to the app's.
      echo "triggers: agent/ has no Composio project; run \`cd agent && composio dev init\`" \
        "and pick the project COMPOSIO_API_KEY belongs to" >&2
    else
      echo "triggers: composio dev listen exited; see agent/$LISTEN_LOG" >&2
    fi
  ) &
}

start_listener
AAI_DEV_HOST=0.0.0.0 node "$SDK/packages/aai-cli/bin.mjs" dev -p "$PORT"
