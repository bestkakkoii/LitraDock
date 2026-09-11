#!/usr/bin/env bash
set -euo pipefail
args=("$@")
last=$((${#args[@]}-1))
input="${args[$last]}"
unset 'args[$last]'
[[ -f "$input" && -n "${LITRADOCK_PG_CONTAINER:-}" ]]
docker exec -i -e PGPASSWORD="${PGPASSWORD}" "$LITRADOCK_PG_CONTAINER" pg_restore "${args[@]}" < "$input"
