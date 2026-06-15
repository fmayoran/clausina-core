#!/usr/bin/env bash
# Rutina local de auto-corrección de rechazos (multiproyecto).
# Corre en el VPS por cron (cada 5 min) sobre la suscripción de Claude Code (sin costo de API).
# Estrategia: chequeo barato por curl; solo invoca a Claude si hay rechazos pendientes.
# Aislamiento: rutea por proyecto (cada corrida de Claude = una sola cápsula) filtrando por revision_id.

set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

N="https://crm-n8n.dhmtev.easypanel.host"
MARCAS="/root/claudefolder/marcas"
MOTOR="/root/claudefolder/plataforma"
LOG="$MOTOR/scripts/rutina_local.log"
ts(){ date -Is; }

# Evitar corridas solapadas (si una tarda más que el intervalo)
exec 9>/tmp/cf_rutina_local.lock
flock -n 9 || exit 0

CID=$(docker ps -q -f name=crm_pgvector.1.)
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }
hb(){ docker exec -i "$CID" psql -U postgres -d claude -q -c "INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) VALUES('correccion',now(),\$m\$$1\$m\$) ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;" >/dev/null 2>&1; }

# 1) Chequeo barato: ¿hay rechazos pendientes? (no invoca a Claude)
pend=$(curl -s --max-time 25 "$N/webhook/cf-rechazos-pendientes" 2>/dev/null || echo "[]")
n=$(printf '%s' "$pend" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
if [ "${n:-0}" -eq 0 ]; then
  echo "$(ts) sin rechazos" >> "$LOG"; hb "sin rechazos"; exit 0
fi
echo "$(ts) rechazos=$n -> ruteo por proyecto" >> "$LOG"
hb "rechazos=$n -> corrigiendo"

# 2) Rutear por proyecto. La cola = revisión rechazada, vigente de su pieza, no derivada a Fer.
COLA="contenido.revisiones r JOIN contenido.piezas pz ON pz.id=r.pieza_id AND pz.revision_vigente=r.id JOIN contenido.proyectos p ON p.id=pz.proyecto_id WHERE r.estado='rechazada' AND r.derivado_en IS NULL"
mapfile -t SLUGS < <(psql "SELECT DISTINCT p.slug FROM $COLA")
[ "${#SLUGS[@]}" -eq 0 ] && { echo "$(ts) cola vacía en base (divergía del webhook), nada que hacer" >> "$LOG"; exit 0; }

for slug in "${SLUGS[@]}"; do
  [ -z "$slug" ] && continue
  REPO="$MARCAS/$slug"
  [ -d "$REPO" ] || { echo "$(ts) sin cápsula para $slug, salteo" >> "$LOG"; continue; }
  REVIDS=$(psql "SELECT string_agg(r.id::text, ', ') FROM $COLA AND p.slug='$slug'")
  [ -z "$REVIDS" ] && continue
  NOMBRE=$(psql "SELECT nombre FROM contenido.proyectos WHERE slug='$slug';"); [ -z "$NOMBRE" ] && NOMBRE="$slug"
  cd "$REPO" || continue
  bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true
  echo "$(ts) -> $slug (revisiones: $REVIDS)" >> "$LOG"
  PROMPT=$(cat <<EOF
Sos el Director Creativo del proyecto (su identidad, voz y estética están en contexto/CONTEXTO_MARCA.md y el CLAUDE.md del directorio actual). Corrés como rutina automática NO interactiva en el VPS.
Procesá rechazos siguiendo EXACTAMENTE $MOTOR/scripts/rutina_regenerar_rechazos.md.
Base n8n: $N

IMPORTANTE (aislamiento multiproyecto): procesá ÚNICAMENTE las revisiones cuyo revision_id esté en esta lista: $REVIDS. Son de ESTA marca. Cualquier otro item que devuelva el webhook NO es de esta marca: ignoralo.
En cada llamada a cf-avisar incluí el campo "marca":"$NOMBRE".

Pasos:
1. GET /webhook/cf-rechazos-pendientes (cada item trae pieza_id, revision_id, titulo_interno, CANAL, asset_ig, media_tipo, poster_url, caption, web_*, daypart, clima, transito, momento, duracion_s, motivo_rechazo, intentos). Filtrá a los revision_id de la lista de arriba.
2. Por cada rechazo (de la lista): si intentos>=5 → cf-avisar + cf-marcar-procesado. Si no, RUTEÁ por "canal":
   A) canal='instagram' → clasificá el motivo:
      - TEXTO (copy/caption/título/tono/datos): reescribí el copy y reenviá con cf-crear-pendiente + "pieza_id" (SIN "media", reusa la imagen) → cf-pub-notify?token=<token>.
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
done
hb "corrección terminada"
