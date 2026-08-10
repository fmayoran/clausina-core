#!/usr/bin/env bash
# Rehace los PNG de las piezas ya generadas, a la resolución de imprenta actual.
# Uso: grafica_repng.sh [slug]        (sin slug: todos los negocios)
#
# El diseño no se toca: se vuelve a fotografiar el HTML que ya está guardado, así que no
# interviene el creativo ni se gasta un solo crédito. Los archivos viejos NO se pisan —sale un
# nombre nuevo— porque el media se sirve con cache de 30 días y el navegador seguiría mostrando
# el anterior.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
MOTOR="/root/clausina/core"
MEDIA="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
BASE_URL="https://panel.clausina.ar/media"
PG=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$PG" ] && { echo "sin contenedor de base" >&2; exit 1; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1" </dev/null; }

filtro=""
[ $# -ge 1 ] && filtro="AND n.slug='$1'"

psql "SELECT v.id||'|'||n.slug||'|'||g.numero||'|'||v.nro||'|'||g.ancho_mm||'|'||g.alto_mm||'|'||coalesce(v.html_url,'')
        FROM contenido.grafica_version v
        JOIN contenido.grafica g ON g.id=v.grafica_id
        JOIN contenido.negocios n ON n.id=g.negocio_id
       WHERE v.estado='lista' AND v.png_url IS NOT NULL AND v.html_url IS NOT NULL $filtro
       ORDER BY n.slug, g.numero, v.nro" > /tmp/repng_lista.txt
total=$(grep -c . /tmp/repng_lista.txt); hechas=0
echo "$total versión(es) para rehacer"
while IFS='|' read -r vid slug numero nro W H html; do
  [ -z "$vid" ] && continue
  arch="$MEDIA/${html#$BASE_URL/}"
  [ -s "$arch" ] || { echo "falta el html de $slug G-$numero v$nro"; continue; }
  num=$(printf "G-%04d" "$numero")
  dir="$MEDIA/grafica/$slug"; rel="grafica/$slug"
  base="${num}-v${nro}-$(date +%Y%m%d%H%M%S)"
  # Sin </dev/null, node se come el resto de la lista que alimenta el while y sólo procesa una.
  r=$(node "$MOTOR/scripts/grafica_render.js" "$arch" "/tmp/repng_$vid.pdf" "$dir/$base.png" "$W" "$H" </dev/null)
  echo "$slug $num v$nro -> $r"
  echo "$r" | grep -q '"ok":true' || continue
  dorso="png_dorso_url=NULL"
  [ -s "$dir/$base-dorso.png" ] && dorso="png_dorso_url='$BASE_URL/$rel/$base-dorso.png'"
  prev="png_prev_url=NULL"
  [ -s "$dir/$base-prev.jpg" ] && prev="png_prev_url='$BASE_URL/$rel/$base-prev.jpg'"
  # El PDF no se toca: ya sale a tamaño físico real y con la imagen a su resolución nativa.
  psql "UPDATE contenido.grafica_version SET png_url='$BASE_URL/$rel/$base.png', $dorso, $prev WHERE id='$vid';" >/dev/null
  rm -f "/tmp/repng_$vid.pdf"
  hechas=$((hechas+1))
done < /tmp/repng_lista.txt
echo "listo: $hechas de $total"
rm -f /tmp/repng_lista.txt
