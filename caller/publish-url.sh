#!/usr/bin/env bash
# `aai dev --on-public-url` hook (run.sh): publish the tunnel's URL to the speaker as
# settings.caller_url while the calling agent runs, and withdraw it on exit — aai dev runs
# this again with PUBLIC_URL empty, which deletes the row, so the speaker never dials into
# a tunnel that is gone.
set -euo pipefail
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

setting caller_url "${PUBLIC_URL:-}"
if [ -n "${PUBLIC_URL:-}" ]; then
  echo "Calling agent reachable at $PUBLIC_URL/phone (published to the speaker)" >&2
fi
