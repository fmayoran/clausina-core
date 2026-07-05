#!/usr/bin/env bash
# Limpieza del media store: SOLO la carpeta material/ (no toca marca/, ig/, creativo/, referencias/).
# Borra: (A) material de briefs/piezas TERMINALES (archivo + fila en brief_material) y
#        (B) archivos HUÉRFANOS (sin ninguna fila que los referencie, p.ej. borrados con la ×).
# Por defecto DRY-RUN (solo lista). Con --apply borra de verdad. Poda carpetas vacías.
# Uso: cleanup_media.sh [--apply] [--grace-days N]   (N = gracia para 'procesado'; default 7)
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

MEDIA="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
MATDIR="$MEDIA/material"
CID=$(docker ps -q -f name=crm_pgvector.1.)
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }

APPLY=0; GRACE=7
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1;;
    --grace-days) shift; GRACE="${1:-7}";;
    *) echo "arg desconocido: $1" >&2; exit 2;;
  esac; shift
done
[ -n "$CID" ] || { echo "no encuentro la base (crm_pgvector)"; exit 1; }
[ -d "$MATDIR" ] && [ -n "$(find "$MATDIR" -type f 2>/dev/null | head -1)" ] || { echo "no hay material que limpiar en $MATDIR"; exit 0; }

mode=$([ "$APPLY" = 1 ] && echo "APLICAR (borra)" || echo "DRY-RUN (solo lista)")
echo "== Limpieza media store — modo: $mode · gracia 'procesado': ${GRACE}d =="
human(){ numfmt --to=iec "${1:-0}" 2>/dev/null || echo "${1:-0}B"; }
sz(){ [ -f "$1" ] && stat -c%s "$1" 2>/dev/null || echo 0; }

# --- A) Material de briefs/piezas TERMINALES (borra archivo + fila) ---
termN=0; termB=0
while IFS= read -r mp; do
  [ -z "$mp" ] && continue
  f="$MEDIA/$mp"; b=$(sz "$f"); termB=$((termB+b)); termN=$((termN+1))
  echo "  [terminal] $mp ($(human "$b"))"
  if [ "$APPLY" = 1 ]; then
    rm -f "$f"
    psql "DELETE FROM contenido.brief_material WHERE media_path='$mp'" >/dev/null
  fi
done < <(psql "
  SELECT bm.media_path FROM contenido.brief_material bm JOIN contenido.tg_briefs b ON b.id=bm.brief_id
   WHERE bm.media_path LIKE 'material/req/%'
     AND (b.estado='descartada' OR (b.estado='procesado' AND b.procesado_en < now()-interval '$GRACE days'))
  UNION
  SELECT bm.media_path FROM contenido.brief_material bm JOIN contenido.tg_briefs b ON b.id=bm.brief_id
     JOIN contenido.piezas pz ON pz.id=b.pieza_id JOIN contenido.revisiones r ON r.id=pz.revision_vigente
   WHERE bm.media_path LIKE 'material/pieza/%' AND r.estado IN ('publicada','descartada')")

# --- A2) Taller "En proceso" del bibliotecario/subidas: se depura pasada la gracia. "Terminado" NO. ---
while IFS= read -r mp; do
  [ -z "$mp" ] && continue
  f="$MEDIA/$mp"; b=$(sz "$f"); termB=$((termB+b)); termN=$((termN+1))
  echo "  [taller En proceso] $mp ($(human "$b"))"
  if [ "$APPLY" = 1 ]; then
    rm -f "$f"
    psql "DELETE FROM contenido.biblioteca_item WHERE media_path='$mp'" >/dev/null
  fi
done < <(psql "SELECT media_path FROM contenido.biblioteca_item WHERE carpeta='En proceso' AND creado_en < now()-interval '$GRACE days'")

# --- B) Archivos HUÉRFANOS (sin fila en brief_material que los referencie) ---
refs=$(mktemp)
psql "SELECT media_path FROM contenido.brief_material WHERE media_path IS NOT NULL" | sort -u > "$refs"
orfN=0; orfB=0
while IFS= read -r f; do
  rel="${f#$MEDIA/}"
  if ! grep -qxF "$rel" "$refs"; then
    b=$(sz "$f"); orfB=$((orfB+b)); orfN=$((orfN+1))
    echo "  [huérfano] $rel ($(human "$b"))"
    [ "$APPLY" = 1 ] && rm -f "$f"
  fi
done < <(find "$MATDIR" -type f 2>/dev/null)
rm -f "$refs"

# --- C) Podar carpetas vacías ---
[ "$APPLY" = 1 ] && find "$MATDIR" -mindepth 1 -type d -empty -delete 2>/dev/null

echo "-- Resumen --"
echo "  material terminal: $termN archivo(s) · $(human "$termB")"
echo "  huérfanos:         $orfN archivo(s) · $(human "$orfB")"
echo "  TOTAL a liberar:   $(human $((termB+orfB)))"
[ "$APPLY" = 1 ] && echo "  -> BORRADO aplicado." || echo "  -> DRY-RUN: no se borró nada. Corré con --apply para aplicar."
