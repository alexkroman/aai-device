#!/usr/bin/env bash
# Bring up this repo's local Supabase stack if it isn't already, then print the agent's
# connection settings as `export` lines for `eval "$(supabase/up.sh)"` (make agent does).
#
# Printed rather than written to agent/.env so the keys and ports always match the
# running stack; agent/.env only declares the names, which is what lets `aai dev` pass
# them through to ctx.env. Progress goes to stderr so stdout stays evaluable.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop…" >&2
  open -a Docker
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || { echo "Docker did not start" >&2; exit 1; }
fi

if ! status=$(supabase status -o env 2>/dev/null) || ! grep -q '^API_URL=' <<<"$status"; then
  echo "Starting local Supabase (first run pulls images; migrations apply on a fresh database)…" >&2
  supabase start >&2
fi
# `supabase start` can return while the db container is still starting, and status has
# no keys until it is healthy.
for _ in $(seq 1 30); do
  status=$(supabase status -o env 2>/dev/null) && grep -q '^API_URL=' <<<"$status" && break
  sleep 2
done

get() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" <<<"$status"; }
api=$(get API_URL)
secret=$(get SECRET_KEY)
db=$(get DB_URL)
# The storage API checks Authorization as a JWT, so uploads get the service-role JWT.
service_jwt=$(get SERVICE_ROLE_KEY)
[ -n "$api" ] && [ -n "$secret" ] && [ -n "$db" ] || { echo "supabase status is missing keys" >&2; exit 1; }

cat <<EOF
export SUPABASE_URL='$api'
export SUPABASE_SECRET_KEY='$secret'
export DATABASE_URL='$db'
export AAI_UPLOAD_STORAGE_URL='$api'
export AAI_UPLOAD_STORAGE_KEY='$service_jwt'
export AAI_UPLOAD_STORAGE_BUCKET='blobs'
EOF
echo "Supabase is up: API $api, Studio $(get STUDIO_URL)" >&2
