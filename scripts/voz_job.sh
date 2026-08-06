#!/usr/bin/env bash
# Transcribir una nota de voz de WhatsApp — ClaUsina v2.0 / F5g.
# Uso: voz_job.sh <id_del_mensaje_en_la_bitacora>
#
# Corre en el HOST y no en el panel porque whisper.cpp está compilado contra glibc y la imagen
# del panel es Alpine: el binario no arranca ahí.
#
# EL AUDIO NO SE GUARDA. Se baja a un temporal, se transcribe y se borra — es la voz de un
# tercero, y para el inbox el texto alcanza. Decisión de Fer (06/08).
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

ID="${1:-}"
[ -z "$ID" ] && { echo "falta el id del mensaje"; exit 2; }

RAIZ=/root/clausina/core
WHISPER=/root/whisper.cpp
MODELO="$WHISPER/models/ggml-base.bin"
BIN="$WHISPER/build/bin/whisper-cli"
TMP=$(mktemp -d /tmp/voz.XXXXXX)
# Pase lo que pase —error, corte, timeout— el audio se va con el temporal.
trap 'rm -rf "$TMP"' EXIT

CID=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$CID" ] && { echo "sin contenedor de base"; exit 1; }
psql() { docker exec -i "$CID" psql -U postgres -d claude -t -A -q -c "$1"; }

# Marcar el pedido antes de empezar: si esto falla a mitad de camino, no se reintenta en bucle.
psql "UPDATE contenido.whatsapp_mensaje SET transcripcion_pedida=true WHERE id=$ID;" >/dev/null

DATOS=$(psql "SELECT m.media_id||E'\t'||n.slug FROM contenido.whatsapp_mensaje m
                JOIN contenido.negocios n ON n.id=m.negocio_id
               WHERE m.id=$ID AND m.media_id IS NOT NULL;")
[ -z "$DATOS" ] && { echo "mensaje $ID sin media_id o sin negocio"; exit 1; }
MEDIA=$(printf '%s' "$DATOS" | cut -f1)
SLUG=$(printf '%s' "$DATOS" | cut -f2)

# El token del negocio, descifrado con la clave de la plataforma.
set -a; . "$RAIZ/plataforma.env" 2>/dev/null; set +a
ENC=$(psql "SELECT pp.wa_token_enc FROM contenido.negocio_perfil pp
              JOIN contenido.negocios n ON n.id=pp.negocio_id WHERE n.slug='$SLUG';")
[ -z "$ENC" ] && { echo "$SLUG sin token de WhatsApp"; exit 1; }
TOKEN=$(python3 "$RAIZ/scripts/ads_crypto.py" decrypt "$ENC" 2>/dev/null)
[ -z "$TOKEN" ] && { echo "no se pudo descifrar el token de $SLUG"; exit 1; }

# La Cloud API da la URL en un paso y el archivo en otro; el segundo también pide el token.
URL=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.facebook.com/v21.0/$MEDIA" | python3 -c \
  'import json,sys; print((json.load(sys.stdin) or {}).get("url",""))' 2>/dev/null)
[ -z "$URL" ] && { echo "sin URL para el media $MEDIA"; exit 1; }

curl -s -H "Authorization: Bearer $TOKEN" -o "$TMP/audio.ogg" "$URL" || { echo "no se bajó el audio"; exit 1; }
[ -s "$TMP/audio.ogg" ] || { echo "audio vacío"; exit 1; }

# whisper quiere wav 16 kHz mono; WhatsApp manda opus.
ffmpeg -nostdin -loglevel error -i "$TMP/audio.ogg" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP/audio.wav" \
  || { echo "ffmpeg falló"; exit 1; }

SEG=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/audio.wav" 2>/dev/null | cut -d. -f1)
# Un audio muy largo bloquearía el worker: se corta y se avisa en vez de colgar la cola.
if [ "${SEG:-0}" -gt 180 ]; then
  psql "UPDATE contenido.whatsapp_mensaje SET texto='[audio de ${SEG}s: demasiado largo para transcribir]' WHERE id=$ID;" >/dev/null
  echo "audio de ${SEG}s, se omite"; exit 0
fi

# -l es fija el idioma: sin esto whisper adivina y con audios cortos se equivoca seguido.
TXT=$("$BIN" -m "$MODELO" -f "$TMP/audio.wav" -t 2 -l es -nt 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//')

if [ -z "$TXT" ]; then
  psql "UPDATE contenido.whatsapp_mensaje SET texto='[audio sin voz reconocible]' WHERE id=$ID;" >/dev/null
  echo "sin texto"; exit 0
fi

# El texto va por base64 para no pelear con comillas ni acentos en la SQL.
B64=$(printf '%s' "$TXT" | base64 -w0)
psql "UPDATE contenido.whatsapp_mensaje
         SET texto = convert_from(decode('$B64','base64'),'UTF8')
       WHERE id=$ID;" >/dev/null

echo "transcripto (${SEG}s): $(printf '%s' "$TXT" | head -c 120)"
