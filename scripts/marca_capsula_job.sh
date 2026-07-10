#!/usr/bin/env bash
# Wrapper del worker: aplica un pedido de cápsula (scaffold/archivar) en el host.
# Uso: marca_capsula_job.sh <accion> <slug>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
accion="${1:-scaffold}"; slug="${2:-}"
[ -z "$slug" ] && { echo "uso: marca_capsula_job.sh <accion> <slug>" >&2; exit 2; }
exec 9>"/tmp/marca_capsula_${slug}.lock"; flock -n 9 || exit 0

MARCAS="/root/clausina/marcas"; MOTOR="/root/clausina/core"
case "$accion" in
  scaffold) exec bash "$MOTOR/scripts/scaffold_marca.sh" "$slug" ;;
  archivar)
    # Baja: NO se borra (la cápsula puede tener trabajo/landing). Se archiva fuera de marcas/.
    case "$slug" in *[!a-z0-9-]*|"" ) echo "slug inválido" >&2; exit 2 ;; esac
    [ -d "$MARCAS/$slug" ] || { echo "no existe la cápsula $slug"; exit 0; }
    mkdir -p "$MARCAS/.archivadas"
    mv "$MARCAS/$slug" "$MARCAS/.archivadas/${slug}-$(date +%Y%m%d%H%M%S)"
    echo "cápsula archivada" ;;
  *) echo "acción desconocida: $accion" >&2; exit 2 ;;
esac
