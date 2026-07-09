#!/usr/bin/env bash
# Wrapper del worker para el sync de pauta on-demand (botón "Actualizar ahora" del panel).
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
exec 9>"/tmp/pauta_sync.lock"; flock -n 9 || exit 0
exec python3 /root/clausina/core/scripts/pauta_sync.py
