#!/usr/bin/env bash
# Rutina local de auto-corrección de rechazos de Cortafuego.
# Corre en el VPS por cron (cada 5 min) sobre la suscripción de Claude Code (sin costo de API).
# Estrategia: chequeo barato por curl; solo invoca a Claude si hay rechazos pendientes.
# Reemplaza a la rutina /schedule de la nube (que el sandbox de red bloqueaba).

set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

N="https://crm-n8n.dhmtev.easypanel.host"
REPO="/root/claudefolder/marcas/cortafuego"
MOTOR="/root/claudefolder/plataforma"
LOG="$MOTOR/scripts/rutina_local.log"
ts(){ date -Is; }

# Evitar corridas solapadas (si una tarda más que el intervalo)
exec 9>/tmp/cf_rutina_local.lock
flock -n 9 || exit 0

# Latido para la barra de status del panel (sin password: conexión local trust dentro del contenedor)
CID=$(docker ps -q -f name=crm_pgvector.1.)
hb(){ docker exec -i "$CID" psql -U postgres -d claude -q -c "INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) VALUES('correccion',now(),\$m\$$1\$m\$) ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;" >/dev/null 2>&1; }

# 1) Chequeo barato: ¿hay rechazos pendientes? (no invoca a Claude)
pend=$(curl -s --max-time 25 "$N/webhook/cf-rechazos-pendientes" 2>/dev/null || echo "[]")
n=$(printf '%s' "$pend" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
if [ "${n:-0}" -eq 0 ]; then
  echo "$(ts) sin rechazos" >> "$LOG"
  hb "sin rechazos"
  exit 0
fi

echo "$(ts) rechazos=$n -> invoco Claude Code" >> "$LOG"
hb "rechazos=$n -> corrigiendo"

# 2) Hay trabajo: Claude Code headless procesa según la doc. Herramientas acotadas a curl + lectura.
cd "$REPO" || exit 1
read -r -d '' PROMPT <<'EOF'
Sos el Director Creativo de Cortafuego corriendo como rutina automática NO interactiva en el VPS.
Procesá los rechazos pendientes siguiendo EXACTAMENTE $MOTOR/scripts/rutina_regenerar_rechazos.md.
Base n8n: https://crm-n8n.dhmtev.easypanel.host

Pasos:
1. GET /webhook/cf-rechazos-pendientes (cada item trae pieza_id, revision_id, titulo_interno, CANAL, asset_ig, media_tipo, poster_url, caption, web_*, daypart, clima, transito, momento, duracion_s, motivo_rechazo, intentos).
2. Por cada rechazo: si intentos>=5 → cf-avisar + cf-marcar-procesado. Si no, RUTEÁ por "canal":
   A) canal='instagram' → clasificá el motivo:
      - TEXTO (copy/caption/título/tono/datos): reescribí el copy y reenviá con cf-crear-pendiente + "pieza_id" (SIN "media", reusa la imagen) → cf-pub-notify?token=<token>.
      - VISUAL EDITABLE (tipografía/colores, "el texto tapa la comida", "sacá/borrá X", "más cinematográfico", reencuadre): editá la pieza — Higgsfield nano_banana y/o rehorneá el texto de marca ($MOTOR/scripts/higgsfield/README.md), acondicioná 9:16, subí (commit+push, verificá 200) y reenviá con cf-crear-pendiente + "pieza_id" + el "media" nuevo (+ "formato") → cf-pub-notify?token=<token>.
      - Material que NO tenés o intentos>=5: NO inventes; cf-avisar + cf-marcar-procesado?id=<revision_id>.
   B) canal='aviso' → sos el EDITOR DE VIDEO (leé $MOTOR/scripts/brief_aviso.md y el skill /editor): regenerá el SPOT 2:3 mudo (~10s) según el motivo, guardá mp4+poster en assets/landing/publicaciones/ (commit+push, verificá 200), y reenviá con cf-crear-pendiente + "pieza_id" + el media nuevo (url pública "https://cortafuego.ar/publicaciones/...") + tags (daypart/clima/transito/momento/duracion_s) + "formato":"feed". NO uses cf-pub-notify. Avisá con cf-avisar (revisar en /panel/avisos). Logo: solo el oficial.
3. Resumí en UNA línea qué hiciste.

Reglas de tono (leé contexto/CONTEXTO_MARCA.md): voseo rioplatense, sin emojis, frases cortas e imperativas,
"Av. Valentín Vergara" siempre completa, hashtags locales (#ranelagh #berazategui). El slogan
"Pará. Comé. Seguí." NO es genérico (es del mediodía express). NUNCA publiques en Instagram.
Armá cada body JSON inline en el -d de un único curl (sin pipes ni archivos).
EOF

timeout 1200 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1
rc=$?
echo "$(ts) fin corrida (exit $rc)" >> "$LOG"
hb "corrección terminada (rc=$rc)"
