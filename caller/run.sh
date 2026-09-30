#!/usr/bin/env bash
# Run the calling agent and give Twilio a way to reach it: `make caller` (with the
# Supabase env already exported by supabase/up.sh).
#
#   1. the agent on 127.0.0.1:$PORT (loopback: only the tunnel reaches it)
#   2. `--tunnel`: a Cloudflare quick tunnel to it — a new https://<random>.trycloudflare.com
#      each run, no Cloudflare account; Twilio gets it per call, so a new one costs nothing.
#      aai dev exits if the tunnel dies.
#   3. publish-url.sh publishes that URL to the speaker (settings.caller_url) and withdraws
#      it on exit, so the speaker never dials into a tunnel that is gone
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3100}"
SDK="${AAI_SDK:-$HOME/Code/aai/agent}"
: "${SUPABASE_URL:?run through make caller}" "${SUPABASE_SECRET_KEY:?run through make caller}"

exec node "$SDK/packages/aai-cli/bin.mjs" dev -p "$PORT" --tunnel --on-public-url ./publish-url.sh
