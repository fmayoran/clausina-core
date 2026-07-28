#!/usr/bin/env bash
# Corre el verificador de integridad y AVISA a Fer por Telegram solo si algo está roto.
# Silencioso cuando todo está bien: si suena, es porque hay que mirar.
# Anti-spam: no repite el mismo aviso más de una vez cada 6 h.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

MOTOR="/root/clausina/core"
ESTADO="/root/backups/verificacion"
mkdir -p "$ESTADO"
LOG="$ESTADO/verificar.log"
ULTIMO="$ESTADO/ultimo_aviso"

SALIDA=$(python3 "$MOTOR/scripts/verificar_sistema.py" 2>&1)
CODIGO=$?
echo "$(date -Is) exit=$CODIGO" >> "$LOG"
echo "$SALIDA" >> "$LOG"

[ "$CODIGO" -eq 0 ] && exit 0   # todo sano: no molestar

FALLOS=$(echo "$SALIDA" | grep -F "[FALLO]" || true)
HUELLA=$(echo "$FALLOS" | md5sum | cut -d' ' -f1)

# ¿mismo problema avisado hace menos de 6 h? no repetir
if [ -f "$ULTIMO" ]; then
  read -r HUELLA_VIEJA CUANDO < "$ULTIMO" 2>/dev/null || true
  AHORA=$(date +%s)
  if [ "${HUELLA_VIEJA:-}" = "$HUELLA" ] && [ $((AHORA - ${CUANDO:-0})) -lt 21600 ]; then
    echo "$(date -Is) (mismo fallo ya avisado, no repito)" >> "$LOG"; exit 1
  fi
fi

# Credenciales del canal de avisos (mismo bot que usa la operación).
ENVF="/root/clausina/marcas/cortafuego/cortafuego.env"
BOT=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ')
CID=$(docker ps -q -f name=crm_pgvector.1.)
CHAT=$(docker exec -i "$CID" psql -U postgres -d claude -t -A -q -c \
  "SELECT telegram_chat_id FROM contenido.negocios WHERE telegram_chat_id IS NOT NULL LIMIT 1;" 2>/dev/null)

if [ -n "$BOT" ] && [ -n "$CHAT" ]; then
  MSG="⚠️ ClaUsina — revisión automática encontró un problema:

$FALLOS

(Detalle: core/scripts/verificar_sistema.py)"
  curl -s -o /dev/null "https://api.telegram.org/bot$BOT/sendMessage" \
    --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$MSG" \
    && echo "$(date -Is) aviso enviado" >> "$LOG"
  echo "$HUELLA $(date +%s)" > "$ULTIMO"
else
  echo "$(date -Is) NO pude avisar (falta bot o chat_id)" >> "$LOG"
fi
exit 1
