#!/usr/bin/env bash
# Regenera el archivo de un skill desde la base. Uso: skills_sync_job.sh [slug]
set -uo pipefail
export HOME=/root
export PATH="/usr/local/bin:/usr/bin:/bin"
exec python3 /root/clausina/core/scripts/skills_sync.py ${1:+"$1"}
