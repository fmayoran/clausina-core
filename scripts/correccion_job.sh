#!/usr/bin/env bash
# Job de corrección de UNA marca. Extraído verbatim del cuerpo por-slug de rutina_local.sh
# (mismo PROMPT, misma lógica de material). Lo invoca el worker (workers/handlers/correccion.py)
# en vez del cron. El ruteo/cola lo hace el dispatcher; acá solo se procesa el slug recibido.
#
# Uso: correccion_job.sh <slug> [revision_ids]
#   <slug>          marca a procesar (cápsula en marcas/<slug>/)
#   [revision_ids]  lista "id, id, ..." (opcional; si falta se deriva de la base)

set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"
[ -z "$slug" ] && { echo "uso: correccion_job.sh <slug> [revision_ids]" >&2; exit 2; }

N="https://crm-n8n.dhmtev.easypanel.host"
MARCAS="/root/clausina/marcas"
MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/rutina_local.log"
ts(){ date -Is; }

# Evitar corridas solapadas de la misma marca.
exec 9>"/tmp/cf_correccion_${slug}.lock"
flock -n 9 || { echo "$(ts) $slug ya en proceso, salteo" >> "$LOG"; exit 0; }

CID=$(docker ps -q -f name=crm_pgvector.1.)
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }
hb(){ docker exec -i "$CID" psql -U postgres -d claude -q -c "INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) VALUES('correccion',now(),\$m\$$1\$m\$) ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;" >/dev/null 2>&1; }

# Cola = revisión rechazada, vigente de su pieza, no derivada a Fer.
COLA="contenido.revisiones r JOIN contenido.piezas pz ON pz.id=r.pieza_id AND pz.revision_vigente=r.id JOIN contenido.proyectos p ON p.id=pz.proyecto_id WHERE r.estado='rechazada' AND r.derivado_en IS NULL"

REPO="$MARCAS/$slug"
[ -d "$REPO" ] || { echo "$(ts) sin cápsula para $slug, salteo" >> "$LOG"; exit 0; }

REVIDS="${2:-}"
[ -z "$REVIDS" ] && REVIDS=$(psql "SELECT string_agg(r.id::text, ', ') FROM $COLA AND p.slug='$slug'")
[ -z "$REVIDS" ] && { echo "$(ts) $slug sin rechazos en base, nada que hacer" >> "$LOG"; exit 0; }

NOMBRE=$(psql "SELECT nombre FROM contenido.proyectos WHERE slug='$slug';"); [ -z "$NOMBRE" ] && NOMBRE="$slug"
cd "$REPO" || exit 1
bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true

# Material que Fer aportó AL RECHAZAR (galería brief_material de las piezas rechazadas de esta marca).
# Se descarga con el bot de la marca (mismo file_id que sube el panel) y se inyecta al prompt por pieza_id.
BOT=$(grep '^TELEGRAM_BOT_TOKEN=' "$REPO/$slug.env" 2>/dev/null | cut -d= -f2-)
dl(){ local fid="$1" out="$2"; local fp=$(curl -s "https://api.telegram.org/bot$BOT/getFile?file_id=$fid" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['file_path'])" 2>/dev/null); [ -z "$fp" ] && return 1; curl -s "https://api.telegram.org/file/bot$BOT/$fp" -o "$out"; }
# Preferimos el media store en disco (media_path, sin límite de tamaño); Telegram (file_id) queda como legacy.
HOST_MEDIA="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
rm -f /tmp/fix_mat_*
MATCTX=""; mi=0
while IFS=$'\t' read -r pieza fid mt mpath; do
  [ -z "$fid$mpath" ] && continue
  if [ -n "$mpath" ]; then ext="${mpath##*.}"; else ext="jpg"; [ "$mt" = "video" ] && ext="mp4"; fi
  out="/tmp/fix_mat_$mi.$ext"
  if [ -n "$mpath" ] && [ -f "$HOST_MEDIA/$mpath" ]; then cp "$HOST_MEDIA/$mpath" "$out" && MATCTX+="- pieza_id=$pieza -> $out ($mt)"$'\n'
  elif [ -n "$fid" ] && [ -n "$BOT" ] && dl "$fid" "$out"; then MATCTX+="- pieza_id=$pieza -> $out ($mt)"$'\n'; fi
  mi=$((mi+1))
done < <(psql "SELECT b.pieza_id::text || E'\t' || COALESCE(bm.file_id,'') || E'\t' || COALESCE(bm.media_type,'photo') || E'\t' || COALESCE(bm.media_path,'')
               FROM contenido.brief_material bm
               JOIN contenido.tg_briefs b ON b.id=bm.brief_id
               JOIN contenido.piezas pz ON pz.id=b.pieza_id
               JOIN contenido.revisiones r ON r.id=pz.revision_vigente
               JOIN contenido.proyectos p ON p.id=pz.proyecto_id
               WHERE r.estado='rechazada' AND r.derivado_en IS NULL AND p.slug='$slug'
               ORDER BY bm.orden, bm.creado_en")
[ -n "$MATCTX" ] && echo "$(ts)    material aportado al rechazo ($mi archivo/s)" >> "$LOG"
echo "$(ts) -> $slug (revisiones: $REVIDS)" >> "$LOG"
hb "$slug: corrigiendo"
PROMPT=$(cat <<EOF
Sos el Director Creativo del proyecto (su identidad, voz y estética están en contexto/CONTEXTO_MARCA.md y el CLAUDE.md del directorio actual). Corrés como rutina automática NO interactiva en el VPS.
Procesá rechazos siguiendo EXACTAMENTE $MOTOR/scripts/rutina_regenerar_rechazos.md.
Base n8n: $N

IMPORTANTE (aislamiento multiproyecto): procesá ÚNICAMENTE las revisiones cuyo revision_id esté en esta lista: $REVIDS. Son de ESTA marca. Cualquier otro item que devuelva el webhook NO es de esta marca: ignoralo.
En cada llamada a cf-avisar incluí el campo "marca":"$NOMBRE".
${MATCTX:+
MATERIAL APORTADO POR FER AL RECHAZAR (ya descargado en el VPS, agrupado por pieza_id):
$MATCTX
Cuando corrijas una pieza que figure acá, USÁ ese material: son imágenes/clips que Fer sumó al rechazar para que los incorpores (p.ej. una mejor foto del plato, otro encuadre, el logo, un clip). Para correcciones VISUALES partí de esos archivos (solos o combinados con la media actual) en vez de inventar. Si el material claramente no aplica al motivo, ignoralo.
}
Pasos:
1. GET /webhook/cf-rechazos-pendientes (cada item trae pieza_id, revision_id, titulo_interno, CANAL, asset_ig, media_tipo, poster_url, caption, web_*, daypart, clima, transito, momento, duracion_s, motivo_rechazo, intentos). Filtrá a los revision_id de la lista de arriba.
2. Por cada rechazo (de la lista): si intentos>=5 → cf-avisar + cf-marcar-procesado. Si no, RUTEÁ por "canal":
   A) canal='instagram' → clasificá el motivo:
      - ANTES de clasificar: si el motivo pide quitar/no usar/cambiar una FRASE, palabra o dato puntual, descargá asset_ig y FIJATE si está EN LA IMAGEN (muchas piezas tienen el texto horneado en el arte). Si está en la imagen → es VISUAL EDITABLE (reescribir solo el caption NO lo saca; hay que rehornear el arte). Ante la duda, VISUAL.
      - TEXTO (copy/caption/título/tono/datos, y NO está en la imagen): reescribí el copy y reenviá con cf-crear-pendiente + "pieza_id" (SIN "media", reusa la imagen) → cf-pub-notify?token=<token>.
      - VISUAL EDITABLE (tipografía/colores, "el texto tapa la comida", "sacá/borrá X", "más cinematográfico", reencuadre): editá la pieza — Higgsfield nano_banana y/o rehorneá el texto con la tipografía/colores de la marca ($MOTOR/scripts/higgsfield/README.md), acondicioná 9:16, subí (commit+push, verificá 200) y reenviá con cf-crear-pendiente + "pieza_id" + el "media" nuevo (+ "formato") → cf-pub-notify?token=<token>.
      - Material que NO tenés o intentos>=5: NO inventes; cf-avisar + cf-marcar-procesado?id=<revision_id>.
   B) canal='aviso' → sos el EDITOR DE VIDEO (leé $MOTOR/scripts/brief_aviso.md y el skill /editor): regenerá el SPOT 2:3 mudo (~10s) según el motivo, guardá mp4+poster en assets/landing/publicaciones/ (commit+push, verificá 200), y reenviá con cf-crear-pendiente + "pieza_id" + el media nuevo (url pública de la landing de la marca) + tags (daypart/clima/transito/momento/duracion_s) + "formato":"feed". NO uses cf-pub-notify. Avisá con cf-avisar. Logo: solo el oficial de la marca.
3. Resumí en UNA línea qué hiciste.

Tono y reglas de copy: tomalos del contexto de marca (contexto/CONTEXTO_MARCA.md). No uses datos ni voz de otra marca. NUNCA publiques en Instagram.
Armá cada body JSON inline en el -d de un único curl (sin pipes ni archivos).
EOF
)
timeout 1200 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1
echo "$(ts) fin $slug (exit $?)" >> "$LOG"
hb "$slug: corrección terminada"
