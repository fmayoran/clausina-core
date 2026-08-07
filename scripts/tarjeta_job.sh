#!/usr/bin/env bash
# Tarjeta de una reserva: dibujarla y mandarla por WhatsApp — ClaUsina v2.0 / F5g.
# Uso: tarjeta_job.sh <reserva_id>
#
# Corre en el HOST porque el navegador está acá. La imagen queda en el media store bajo
# `tarjetas/`, que es carpeta pública: Meta baja la foto por link desde afuera, así que no puede
# estar detrás de la sesión del panel. Lo que se ve ahí es lo mismo que el cliente ya tiene en su
# chat, y la URL lleva el uuid de la reserva.
set -uo pipefail
export HOME=/root
export PATH="/usr/local/bin:/usr/bin:/bin"

RID="${1:-}"
[ -z "$RID" ] && { echo "falta el id de la reserva" >&2; exit 2; }

MOTOR="/root/clausina/core"
MEDIA_HOST="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
BASE_URL="https://panel.clausina.ar/media"
PG=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$PG" ] && { echo "sin contenedor de base" >&2; exit 1; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1"; }
fallar(){ psql "UPDATE contenido.tarjeta_req SET estado='error', error=left('$1',300), hecho_en=now() WHERE reserva_id='$RID';" >/dev/null; echo "$1" >&2; exit 1; }

DATOS=$(psql "SELECT t.wa_id||'|'||n.slug||'|'||t.negocio_id FROM contenido.tarjeta_req t
                JOIN contenido.negocios n ON n.id=t.negocio_id
               WHERE t.reserva_id='$RID' AND t.estado='pendiente';")
[ -z "$DATOS" ] && { echo "sin pedido pendiente para $RID"; exit 0; }
IFS='|' read -r WA SLUG NEG <<< "$DATOS"

# Nombre único por reserva: si la reserva cambia y se vuelve a dibujar, cambia el archivo. Un
# nombre estable se quedaría pegado en el cache de Meta con la versión vieja.
STAMP=$(date +%s)
DIR="$MEDIA_HOST/tarjetas"
mkdir -p "$DIR"
PNG="$DIR/${RID}-${STAMP}.png"

OUT=$(node "$MOTOR/scripts/tarjeta_render.js" "$RID" "$SLUG" "$PNG" 2>&1) || fallar "render: $(printf '%s' "$OUT" | tail -c 200 | tr "'" ' ')"
[ -s "$PNG" ] || fallar "el render no dejó imagen"
chmod 644 "$PNG"
URL="$BASE_URL/tarjetas/${RID}-${STAMP}.png"

# El envío lo hace el panel: ahí están el token descifrado del negocio y la bitácora del chat.
ENVIO=$(docker exec -i "$(docker ps -q -f name=clausina_panel | head -1)" node -e '
  const db = require("/app/db"), wa = require("/app/whatsapp");
  (async () => {
    const [neg, waId, url] = process.argv.slice(1);
    const c = await db.getWhatsappNegocio(neg, true);
    if (!c || !c.wa_phone_id || !c.token) return process.stdout.write(JSON.stringify({ ok: false, motivo: "sin_configurar" }));
    const r = await wa.enviarImagen(waId, url, "", { phone_id: c.wa_phone_id, token: c.token });
    // La bitácora es la misma que la del texto: el inbox tiene que mostrar la conversación
    // completa, no la mitad que pasó por el webhook.
    if (r.ok) await db.logWhatsapp({ negocio_id: neg, wa_id: waId, direccion: "saliente",
                                     tipo: "image", texto: url, mensaje_id: r.id || null });
    process.stdout.write(JSON.stringify(r));
  })().catch(e => { process.stdout.write(JSON.stringify({ ok: false, motivo: e.message })); });
' "$NEG" "$WA" "$URL" 2>&1)

case "$ENVIO" in
  *'"ok":true'*) psql "UPDATE contenido.tarjeta_req SET estado='lista', url='$URL', hecho_en=now() WHERE reserva_id='$RID';" >/dev/null
                 echo "tarjeta enviada: $URL" ;;
  *)             fallar "envio: $(printf '%s' "$ENVIO" | tail -c 200 | tr "'" ' ')" ;;
esac
