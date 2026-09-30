#!/usr/bin/env bash
# Run the speaker's agent for `make agent` (with the Supabase env already exported by
# supabase/up.sh), and beside it, when it can, the Composio CLI forwarding trigger events
# to the agent's webhook: a laptop has no public URL for Composio to POST to.
#
#   1. `aai dev` on 0.0.0.0:$PORT, where the speaker and the page reach it
#   2. `composio dev listen --forward` to /api/composio/webhook (watches.ts), signed with
#      COMPOSIO_WEBHOOK_SECRET, which the route verifies. With none in .env, this run
#      makes one and exports it to both, so they always agree. The CLI listens to ONE
#      project, and a project key can't say which it belongs to, so it is named for the
#      listener: COMPOSIO_PROJECT_ID in .env, else a `composio dev init` binding, else the
#      org's only project. Never `dev init` itself: it can mint a new key into .env.local.
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

cleanup() { kill "${listen_pid:-}" "${advertise_pid:-}" 2>/dev/null || true; }
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
  resolve_project || return 0
  # A shell export fills .env's declared name, so `aai dev` and the CLI get the same one.
  if [ -z "${COMPOSIO_WEBHOOK_SECRET:-$(dotenv COMPOSIO_WEBHOOK_SECRET)}" ]; then
    COMPOSIO_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  else
    COMPOSIO_WEBHOOK_SECRET="${COMPOSIO_WEBHOOK_SECRET:-$(dotenv COMPOSIO_WEBHOOK_SECRET)}"
  fi
  export COMPOSIO_WEBHOOK_SECRET
  local forward="http://127.0.0.1:$PORT/api/composio/webhook"
  if [ -n "$listen_project" ]; then
    COMPOSIO_ORG_ID="$listen_org" COMPOSIO_PROJECT_ID="$listen_project" \
      "$COMPOSIO" dev listen --forward "$forward" >"$LISTEN_LOG" 2>&1 &
  else
    "$COMPOSIO" dev listen --forward "$forward" >"$LISTEN_LOG" 2>&1 &
  fi
  listen_pid=$!
  # A listener that can't connect (wrong project, expired login) exits at once: say so
  # rather than leave watches that never fire.
  (
    sleep 5
    if kill -0 "$listen_pid" 2>/dev/null; then
      echo "triggers: forwarding Composio events to /api/composio/webhook (agent/$LISTEN_LOG)" >&2
    elif grep -q "dev init" "$LISTEN_LOG" 2>/dev/null; then
      # The CLI listens to the project this directory is bound to: bind it to the app's.
      echo "triggers: no Composio project to listen to; set COMPOSIO_PROJECT_ID in agent/.env" \
        "to the one COMPOSIO_API_KEY belongs to (composio dev projects list)" >&2
    else
      echo "triggers: composio dev listen exited; see agent/$LISTEN_LOG" >&2
    fi
  ) &
}

# The one id in a CLI JSON list, the selected one if several are flagged; else empty.
pick_id() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const all = JSON.parse(s.replace(/\x1b\[[0-9;]*m/g, ""));
        const one = all.length === 1 ? all : all.filter((x) => x[process.argv[1]]);
        if (one.length === 1) console.log(one[0].id);
      } catch {}
    });' "$1"
}

# Sets listen_org/listen_project, or leaves both empty for a `dev init` binding.
listen_org="" listen_project=""
resolve_project() {
  listen_project="${COMPOSIO_PROJECT_ID:-$(dotenv COMPOSIO_PROJECT_ID)}"
  if [ -z "$listen_project" ]; then
    [ -f .composio/project.json ] && return 0
    listen_project="$("$COMPOSIO" dev projects list 2>/dev/null | pick_id is_selected_global_project)"
  fi
  listen_org="${COMPOSIO_ORG_ID:-$(dotenv COMPOSIO_ORG_ID)}"
  [ -n "$listen_org" ] || listen_org="$("$COMPOSIO" orgs list 2>/dev/null | pick_id is_selected_global_org)"
  if [ -z "$listen_project" ] || [ -z "$listen_org" ]; then
    echo "triggers: several Composio projects; set COMPOSIO_PROJECT_ID in agent/.env to the" \
      "one COMPOSIO_API_KEY belongs to (composio dev projects list), not listening" >&2
    return 1
  fi
}

# Advertise the agent on the LAN (mDNS, _aai._tcp), so a speaker built without
# CONFIG_AAI_AGENT_URL finds it (firmware discovery.h) and follows this machine's address.
advertise() {
  local name="aai agent on $(hostname -s)"
  if command -v dns-sd >/dev/null; then  # macOS
    dns-sd -R "$name" _aai._tcp local "$PORT" path=/websocket >/dev/null 2>&1 &
  elif command -v avahi-publish >/dev/null; then  # Linux
    avahi-publish -s "$name" _aai._tcp "$PORT" path=/websocket >/dev/null 2>&1 &
  else
    echo "discovery: no dns-sd or avahi-publish; speakers need CONFIG_AAI_AGENT_URL" >&2
    return
  fi
  advertise_pid=$!
}

start_listener
advertise
AAI_DEV_HOST=0.0.0.0 node "$SDK/packages/aai-cli/bin.mjs" dev -p "$PORT"
