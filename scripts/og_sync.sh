#!/usr/bin/env bash
# Mantiene al día la pieza apaisada con la que se ve cada invitación al compartirla.
# Uso: og_sync.sh [beneficio_id]   (sin argumento: todas las que estén desactualizadas)
#
# No usa cola: compara og_generado_en contra actualizado_en del beneficio, así que si alguien
# cambia el nombre, el frente o el tema, la pieza se rehace sola en la próxima corrida. Un job
# que se auto-repara es más barato que una cola para algo que tarda dos segundos.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
MOTOR="/root/clausina/core"
MEDIA="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
BASE_URL="https://panel.clausina.ar/media"
PG=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$PG" ] && { echo "sin contenedor de base" >&2; exit 1; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1" </dev/null; }

filtro="b.og_generado_en IS NULL OR b.og_generado_en < b.actualizado_en"
[ $# -ge 1 ] && filtro="b.id='$1'"

psql "SELECT b.id||'|'||n.slug FROM contenido.beneficio b
        JOIN contenido.negocios n ON n.id=b.negocio_id
       WHERE b.activo AND ($filtro)" > /tmp/og_lista.txt

n=0
while IFS='|' read -r bid slug; do
  [ -z "$bid" ] && continue
  dir="$MEDIA/og/$slug"; mkdir -p "$dir"
  # Nombre con marca de tiempo: el media se sirve con cache de 30 días y WhatsApp además cachea
  # por URL, así que pisar el archivo dejaría la vista previa vieja para siempre.
  base="$bid-$(date +%Y%m%d%H%M%S).jpg"
  if node "$MOTOR/scripts/og_render.js" "$bid" "$dir/$base" </dev/null | grep -q '"ok":true'; then
    psql "UPDATE contenido.beneficio SET og_url='$BASE_URL/og/$slug/$base', og_generado_en=now()
           WHERE id='$bid'" >/dev/null
    echo "$slug · $bid → ok"; n=$((n+1))
  else
    echo "$slug · $bid → falló" >&2
  fi
done < /tmp/og_lista.txt
rm -f /tmp/og_lista.txt
echo "piezas regeneradas: $n"
