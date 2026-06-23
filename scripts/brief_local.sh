#!/usr/bin/env bash
# Handler de "briefs por voz" (multiproyecto). Corre por cron en el VPS.
# Toma un brief pendiente (audio + media opcional que Fer mandó por Telegram), lo transcribe
# (whisper.cpp local), y le pasa todo a Claude Code headless para que arme la pieza pendiente.
# NADA se publica: termina en pendiente_aprobacion y Fer aprueba.

set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

MARCAS="/root/claudefolder/marcas"
MOTOR="/root/claudefolder/core"
LOG="$MOTOR/scripts/brief_local.log"
WHISPER="/root/whisper.cpp/build/bin/whisper-cli"
MODEL="/root/whisper.cpp/models/ggml-base.bin"
CID=$(docker ps -q -f name=crm_pgvector.1.)
# REPO/BOT se resuelven por proyecto del brief (multiproyecto): cada corrida = una sola cápsula.
ts(){ date -Is; }
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }
hb(){ psql "INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) VALUES('ingesta_briefs',now(),\$m\$$1\$m\$) ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;" >/dev/null 2>&1; }

exec 9>/tmp/cf_brief.lock; flock -n 9 || exit 0

# 1) brief pendiente (el más viejo), como JSON
row=$(psql "SELECT row_to_json(t) FROM (SELECT id,chat_id,voice_file_id,media_file_id,media_type,texto,comentarios,canal_destino,proyecto_id FROM contenido.tg_briefs WHERE estado='pendiente' ORDER BY creado_en LIMIT 1) t;")
[ -z "$row" ] && { echo "$(ts) sin briefs" >> "$LOG"; hb "sin requerimientos en cola"; exit 0; }

bid=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
chat=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin)['chat_id'])")
voice=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('voice_file_id') or '')")
media=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('media_file_id') or '')")
mtype=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('media_type') or '')")
btext=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('texto') or '')")
comentarios=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('comentarios') or '')")
canal=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('canal_destino') or 'instagram')")
pid=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('proyecto_id') or '')")

# --- resolver el proyecto del brief: cápsula y secretos de ESA marca (aislamiento multiproyecto) ---
slug=$(psql "SELECT slug FROM contenido.proyectos WHERE id='$pid';")
# Sin proyecto resoluble no se asume ninguna marca: se marca error (multi-marca, agnóstico).
[ -z "$slug" ] && { echo "$(ts) ERROR: brief $bid sin proyecto resoluble (pid='$pid')" >> "$LOG"; psql "UPDATE contenido.tg_briefs SET estado='error', procesado_en=now() WHERE id='$bid';" >/dev/null; exit 1; }
NOMBRE=$(psql "SELECT nombre FROM contenido.proyectos WHERE slug='$slug';"); [ -z "$NOMBRE" ] && NOMBRE="$slug"
REPO="$MARCAS/$slug"
[ -d "$REPO" ] || { echo "$(ts) ERROR: cápsula inexistente $REPO" >> "$LOG"; psql "UPDATE contenido.tg_briefs SET estado='error', procesado_en=now() WHERE id='$bid';" >/dev/null; exit 1; }
BOT=$(grep '^TELEGRAM_BOT_TOKEN=' "$REPO/$slug.env" 2>/dev/null | cut -d= -f2-)
echo "$(ts) brief $bid (proyecto=$slug voice=${voice:+si} media=$mtype canal=$canal)" >> "$LOG"
hb "procesando requerimiento $bid"
psql "UPDATE contenido.tg_briefs SET estado='procesando' WHERE id='$bid';" >/dev/null

dl(){ # file_id -> ruta local descargada (echo); requiere extensión por content
  local fid="$1" out="$2"
  local fp=$(curl -s "https://api.telegram.org/bot$BOT/getFile?file_id=$fid" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['file_path'])" 2>/dev/null)
  [ -z "$fp" ] && return 1
  curl -s "https://api.telegram.org/file/bot$BOT/$fp" -o "$out"
}

# 2) transcribir audio
transcript=""
if [ -n "$voice" ]; then
  if dl "$voice" /tmp/brief_voice.oga; then
    ffmpeg -v error -i /tmp/brief_voice.oga -ar 16000 -ac 1 /tmp/brief_voice.wav -y
    transcript=$("$WHISPER" -m "$MODEL" -f /tmp/brief_voice.wav -l es -nt 2>/dev/null | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  fi
fi

# 3) descargar media adjunta (legacy: el único media_file_id del brief, p.ej. respuesta por Telegram)
medialocal=""
if [ -n "$media" ]; then
  ext="jpg"; [ "$mtype" = "video" ] && ext="mp4"
  if dl "$media" "/tmp/brief_media.$ext"; then medialocal="/tmp/brief_media.$ext"; fi
fi

# 3b) descargar TODOS los materiales aportados desde el panel (galería brief_material, en orden).
rm -f /tmp/brief_mat_*.jpg /tmp/brief_mat_*.mp4
mats=$(psql "SELECT COALESCE(json_agg(json_build_object('file_id',file_id,'media_type',media_type) ORDER BY orden, creado_en),'[]') FROM contenido.brief_material WHERE brief_id='$bid';")
matlines=""
i=0
while IFS=$'\t' read -r fid mt; do
  [ -z "$fid" ] && continue
  ext="jpg"; [ "$mt" = "video" ] && ext="mp4"
  out="/tmp/brief_mat_$i.$ext"
  if dl "$fid" "$out"; then matlines+="$out|$mt"$'\n'; fi
  i=$((i+1))
done < <(echo "$mats" | python3 -c "import sys,json
for m in json.load(sys.stdin):
    print((m.get('file_id') or '')+'\t'+(m.get('media_type') or 'photo'))")
matlist=$(printf '%s' "$matlines" | python3 -c "import sys,json
out=[]
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    p,t=line.split('|',1); out.append({'path':p,'media_type':t})
print(json.dumps(out,ensure_ascii=False))")
[ -z "$matlist" ] && matlist="[]"

# 4) contexto para Claude (las env vars van ANTES de python3: si van después, bash las pasa como
#    argumentos y os.environ falla -> brief_ctx.json no se escribe. Bug corregido 05/06/2026.)
#    'materiales' = lista (panel, varios). 'media' = único legacy (Telegram). 'comentarios' = nota de Fer.
rm -f /tmp/brief_ctx.json
T="$transcript" B="$btext" M="$medialocal" MT="$mtype" C="$chat" I="$bid" MATS="$matlist" CM="$comentarios" \
python3 -c "import json,os;json.dump({'brief':(os.environ['T']+' '+os.environ['B']).strip(),'media':os.environ['M'],'media_type':os.environ['MT'],'materiales':json.loads(os.environ['MATS']),'comentarios':os.environ['CM'],'chat_id':os.environ['C'],'brief_id':os.environ['I']},open('/tmp/brief_ctx.json','w'),ensure_ascii=False)"
echo "$(ts) transcript: $transcript | materiales: $(echo "$matlist" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')" >> "$LOG"

# guarda: sin contexto no invocamos al agente; marcamos error para reintentar/avisar
if [ ! -s /tmp/brief_ctx.json ]; then
  echo "$(ts) ERROR: no se generó brief_ctx.json" >> "$LOG"
  psql "UPDATE contenido.tg_briefs SET estado='error', procesado_en=now() WHERE id='$bid';" >/dev/null
  exit 1
fi

# 5) Claude Code arma la pieza — ruteo por canal del requerimiento
cd "$REPO" || exit 1
bash "$MOTOR/scripts/perfil_a_md.sh" "$(basename "$REPO")" >/dev/null 2>&1 || true
if [ "$canal" = "aviso" ]; then
  PROMPT="Procesá un requerimiento de AVISO de pantalla (DOOH) siguiendo EXACTAMENTE $MOTOR/scripts/brief_aviso.md. Los datos están en /tmp/brief_ctx.json: leelo primero (incluye 'materiales': lista de archivos aportados, 'media': adjunto legacy, y 'comentarios': indicaciones de Fer, que debés respetar). Producí un spot 2:3 mudo de ~10s con la estética de marca, guardá mp4+poster en assets/landing/publicaciones/ (commit+push, verificá 200), registralo con cf-crear-pendiente (canal_pieza='aviso' + tags de contexto + brief_id) y avisá con cf-avisar. NUNCA uses cf-pub-notify ni publiques. Si falta material que no podés generar, avisá con cf-avisar. En cada cf-avisar incluí el campo \"marca\":\"$NOMBRE\". Resumí en una línea."
else
  PROMPT="Procesá un brief dictado por Fer siguiendo EXACTAMENTE $MOTOR/scripts/brief_dictado.md. Los datos del brief están en /tmp/brief_ctx.json: leelo primero. Incluye 'materiales' (lista de archivos aportados desde el panel, en orden; usalos TODOS — si son varios fotos en Instagram, armá carrusel), 'media' (adjunto único legacy, fallback si 'materiales' está vacío), 'comentarios' (indicaciones de Fer sobre el material: respetalas), 'texto', 'chat_id' y 'brief_id'. Acondicioná la media si hace falta, redactá el copy con la voz de marca, insertá la pieza pendiente vía cf-crear-pendiente y notificá con cf-pub-notify. NUNCA publiques en Instagram. Si falta material o algo no se entiende, avisá a Fer con cf-avisar. En cada cf-avisar incluí el campo \"marca\":\"$NOMBRE\". Resumí en una línea."
fi
timeout 1200 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1
rc=$?

# 6) marcar procesado
if [ $rc -eq 0 ]; then psql "UPDATE contenido.tg_briefs SET estado='procesado', procesado_en=now(), transcripcion=left(\$tr\$$transcript\$tr\$,4000) WHERE id='$bid';" >/dev/null
else psql "UPDATE contenido.tg_briefs SET estado='error', procesado_en=now() WHERE id='$bid';" >/dev/null
  curl -s -X POST -H "Content-Type: application/json" -d "{\"asunto\":\"Brief con error\",\"cuerpo\":\"No pude procesar un brief por voz. Revisá el log.\",\"marca\":\"$NOMBRE\"}" "https://crm-n8n.dhmtev.easypanel.host/webhook/cf-avisar" >/dev/null 2>&1
fi
echo "$(ts) fin brief $bid (rc=$rc)" >> "$LOG"
