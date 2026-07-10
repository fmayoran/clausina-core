#!/usr/bin/env bash
# Wrapper del worker: regenera los secretos derivados desde la DB (credencial IG en n8n).
# Uso: sync_secrets_job.sh <slug>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
slug="${1:-cortafuego}"
exec 9>"/tmp/sync_secrets_${slug}.lock"; flock -n 9 || exit 0
exec python3 /root/clausina/core/scripts/sync_secrets.py "$slug"
