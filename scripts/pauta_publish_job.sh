#!/usr/bin/env bash
# Wrapper del worker para la creación/activación de campañas en Meta (determinístico, sin agente).
# Uso: pauta_publish_job.sh <crear|activar|pausar> <campania_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
accion="${1:-}"; cid="${2:-}"
{ [ -z "$accion" ] || [ -z "$cid" ]; } && { echo "uso: pauta_publish_job.sh <crear|activar|pausar> <campania_id>" >&2; exit 2; }
exec 9>"/tmp/pauta_pub_${cid}.lock"; flock -n 9 || exit 0
exec python3 /root/clausina/core/scripts/pauta_publish.py "$accion" "$cid"
