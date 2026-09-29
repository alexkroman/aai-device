#!/usr/bin/env bash
# Run the calling agent and give Twilio a way to reach it: `make caller` (with the
# Supabase env already exported by supabase/up.sh).
#
#   1. the agent on 127.0.0.1:$PORT (loopback: only the tunnel reaches it)
#   2. a Cloudflare quick tunnel to it — a new https://<random>.trycloudflare.com each
#      run, no Cloudflare account; Twilio gets it per call, so a new one costs nothing
#   3. that URL published to the speaker (settings.caller_url), withdrawn on exit so the
#      speaker never dials into a tunnel that is gone
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3100}"
SDK="${AAI_SDK:-$HOME/Code/aai/agent-builtin-api-tools}"
: "${SUPABASE_URL:?run through make caller}" "${SUPABASE_SECRET_KEY:?run through make caller}"

setting() { # key, value (empty value deletes)
  local auth=(-H "apikey: $SUPABASE_SECRET_KEY" -H "authorization: Bearer $SUPABASE_SECRET_KEY")
  if [ -n "$2" ]; then
    curl -fsS -X POST "$SUPABASE_URL/rest/v1/settings?on_conflict=key" "${auth[@]}" \
      -H "content-type: application/json" -H "prefer: resolution=merge-duplicates" \
      -d "{\"key\":\"$1\",\"value\":\"$2\"}" >/dev/null
  else
    curl -fsS -X DELETE "$SUPABASE_URL/rest/v1/settings?key=eq.$1" "${auth[@]}" >/dev/null
  fi
}

tunnel_log="$(mktemp)"
cleanup() {
  setting caller_url "" || true
  kill "${agent_pid:-}" "${tunnel_pid:-}" 2>/dev/null || true
  rm -f "$tunnel_log"
}
trap cleanup EXIT INT TERM

node "$SDK/packages/aai-cli/bin.mjs" dev -p "$PORT" &
agent_pid=$!

cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$tunnel_log" 2>&1 &
tunnel_pid=$!
url=""
for _ in $(seq 1 60); do
  url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" | head -1 || true)"
  [ -n "$url" ] && break
  sleep 1
done
[ -n "$url" ] || { echo "cloudflared gave no URL:" >&2; tail -20 "$tunnel_log" >&2; exit 1; }
setting caller_url "$url"
echo "Calling agent reachable at $url/phone (published to the speaker)" >&2
# Until either stops (portable: macOS's bash 3.2 has no `wait -n`).
while kill -0 "$agent_pid" 2>/dev/null && kill -0 "$tunnel_pid" 2>/dev/null; do sleep 2; done
