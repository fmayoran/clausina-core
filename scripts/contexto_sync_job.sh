#!/usr/bin/env bash
# Regenera el contexto de un negocio desde la base. Uso: contexto_sync_job.sh <slug>
set -uo pipefail
export HOME=/root
export PATH="/usr/local/bin:/usr/bin:/bin"
exec python3 /root/clausina/core/scripts/contexto_a_md.py "${1:?falta el slug}"
