#!/usr/bin/env bash
set -euo pipefail
args=()
out=""
while (($#)); do
  if [[ "$1" == "--file" ]]; then out="$2"; shift 2; else args+=("$1"); shift; fi
done
[[ -n "$out" && -n "${LITRADOCK_PG_CONTAINER:-}" ]]
docker exec -e PGPASSWORD="${PGPASSWORD}" "$LITRADOCK_PG_CONTAINER" pg_dump "${args[@]}" > "$out"
