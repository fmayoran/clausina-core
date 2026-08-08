#!/usr/bin/env bash
# Chequea los servicios de terceros y AVISA por Telegram sólo si alguno está caído.
# Silencioso cuando todo anda: si suena, hay que mirar. Mismo criterio que verificar_job.sh.
# Anti-spam: no repite el mismo aviso más de una vez cada 12 h — un token vencido sigue vencido
# hasta que alguien lo renueve, y recordarlo cada quince minutos es ruido, no información.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

MOTOR="/root/clausina/core"
ESTADO="/root/backups/verificacion"
mkdir -p "$ESTADO"
LOG="$ESTADO/salud_externa.log"
ULTIMO="$ESTADO/ultimo_aviso_externa"

SALIDA=$(python3 "$MOTOR/scripts/salud_externa.py" 2>&1)
CODIGO=$?
echo "$(date -Is) exit=$CODIGO" >> "$LOG"
echo "$SALIDA" >> "$LOG"

python3 "$MOTOR/scripts/salud_externa_guardar.py" >/dev/null 2>&1

[ "$CODIGO" -eq 0 ] && exit 0

CAIDOS=$(echo "$SALIDA" | grep -F "[CAÍDO]" || true)
HUELLA=$(echo "$CAIDOS" | md5sum | cut -d' ' -f1)
if [ -f "$ULTIMO" ]; then
  read -r HUELLA_VIEJA CUANDO < "$ULTIMO" 2>/dev/null || true
  AHORA=$(date +%s)
  if [ "$HUELLA" = "${HUELLA_VIEJA:-}" ] && [ $((AHORA - ${CUANDO:-0})) -lt 43200 ]; then exit 0; fi
fi
echo "$HUELLA $(date +%s)" > "$ULTIMO"

# El aviso va al Telegram de la AGENCIA: un token vencido es un problema de ClaUsina, no algo
# que el dueño del negocio pueda resolver.
set -a; . "$MOTOR/plataforma.env" 2>/dev/null; set +a
BOT="${TELEGRAM_BOT_TOKEN:-}"; CHAT="${TELEGRAM_CHAT_ID:-}"
[ -z "$BOT" ] && { . /root/clausina/marcas/cortafuego/cortafuego.env 2>/dev/null; BOT="${TELEGRAM_BOT_TOKEN:-}"; CHAT="${TELEGRAM_CHAT_ID:-$CHAT}"; }
[ -z "$BOT" ] || [ -z "$CHAT" ] && exit 0

TXT="Servicios externos con problemas:

$CAIDOS

Detalle en panel.clausina.ar/maquinas"
curl -s "https://api.telegram.org/bot$BOT/sendMessage" \
  --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$TXT" -o /dev/null 2>&1
