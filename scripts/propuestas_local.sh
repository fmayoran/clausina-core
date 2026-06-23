#!/usr/bin/env bash
# Pedidos de propuestas del creativo. Cron en el VPS (cada ~3 min).
# El panel inserta un pedido en contenido.solicitudes_propuesta (con énfasis); acá el creativo
# (Claude Code headless, sobre la suscripción) elabora propuestas y las carga en la cola de
# requerimientos vía propuestas_publicar.py. NADA se publica: quedan como 'propuesta' esperando
# que Fer aporte material. El resto del circuito (aprobación manual) no cambia.
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

MARCAS="/root/clausina/marcas"
MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/propuestas_local.log"
CID=$(docker ps -q -f name=crm_pgvector.1.)
# REPO/BOT/CHAT se resuelven por proyecto del pedido (multiproyecto): cada corrida = una cápsula.
ts(){ date -Is; }
psqlc(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }
hb(){ psqlc "INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) VALUES('propuestas',now(),\$m\$$1\$m\$) ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;" >/dev/null 2>&1; }

exec 9>/tmp/cf_propuestas.lock; flock -n 9 || exit 0

row=$(psqlc "SELECT row_to_json(t) FROM (SELECT id,enfasis,canal,cantidad,proyecto_id FROM contenido.solicitudes_propuesta WHERE estado='pendiente' ORDER BY creado_en LIMIT 1) t;")
[ -z "$row" ] && { echo "$(ts) sin pedidos" >> "$LOG"; hb "sin pedidos"; exit 0; }

sid=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
enfasis=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('enfasis') or '')")
canal=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('canal') or 'instagram')")
cantidad=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('cantidad') or 5)")
pid=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('proyecto_id') or '')")

# --- resolver el proyecto del pedido: cápsula y secretos de ESA marca (aislamiento multiproyecto) ---
slug=$(psqlc "SELECT slug FROM contenido.proyectos WHERE id='$pid';")
# Sin proyecto resoluble no se asume ninguna marca: se marca error (multi-marca, agnóstico).
[ -z "$slug" ] && { echo "$(ts) ERROR: pedido $sid sin proyecto resoluble (pid='$pid')" >> "$LOG"; psqlc "UPDATE contenido.solicitudes_propuesta SET estado='error', procesado_en=now() WHERE id='$sid';" >/dev/null; exit 1; }
pid=$(psqlc "SELECT id FROM contenido.proyectos WHERE slug='$slug';")   # normaliza si vino vacío
CHAT=$(psqlc "SELECT coalesce(telegram_chat_id,'') FROM contenido.proyectos WHERE slug='$slug';")
REPO="$MARCAS/$slug"
[ -d "$REPO" ] || { echo "$(ts) ERROR: cápsula inexistente $REPO" >> "$LOG"; psqlc "UPDATE contenido.solicitudes_propuesta SET estado='error', procesado_en=now() WHERE id='$sid';" >/dev/null; exit 1; }
BOT=$(grep '^TELEGRAM_BOT_TOKEN=' "$REPO/$slug.env" 2>/dev/null | cut -d= -f2-)
echo "$(ts) pedido $sid (proyecto=$slug) enfasis='$enfasis' cantidad=$cantidad" >> "$LOG"
hb "elaborando propuestas"
psqlc "UPDATE contenido.solicitudes_propuesta SET estado='procesando' WHERE id='$sid';" >/dev/null

# Contexto: últimas publicadas (para no repetir y mantener coherencia)
recientes=$(psqlc "SELECT COALESCE(json_agg(json_build_object('titulo',titulo_interno,'caption',left(caption,200))),'[]'::json) FROM (SELECT pz.titulo_interno, r.caption FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente WHERE pz.proyecto_id='$pid' AND r.estado='publicada' ORDER BY r.publicado_en DESC LIMIT 10) s;")
rm -f /tmp/propuestas.json /tmp/prop_ctx.json
E="$enfasis" R="$recientes" CN="$canal" QT="$cantidad" python3 -c "import json,os;json.dump({'enfasis':os.environ['E'],'canal':os.environ['CN'],'cantidad':int(os.environ['QT']),'recientes':json.loads(os.environ['R'])},open('/tmp/prop_ctx.json','w'),ensure_ascii=False)"

cd "$REPO" || exit 1
bash "$MOTOR/scripts/perfil_a_md.sh" "$(basename "$REPO")" >/dev/null 2>&1 || true
PROMPT="Sos el Director Creativo del proyecto. Su identidad, voz y estética están en contexto/CONTEXTO_MARCA.md y en el CLAUDE.md del proyecto (directorio actual): leelos y respetalos; NO uses contexto de otra marca. Generá propuestas para la cola de requerimientos, siguiendo $MOTOR/scripts/propuestas_creativo.md.
Contexto en /tmp/prop_ctx.json: 'enfasis' (qué destacar; puede estar vacío), 'canal' (instagram=publicaciones de feed, o aviso=spots para la pantalla de calle DOOH 2:3), 'cantidad' (EXACTAMENTE cuántas propuestas generar) y 'recientes' (últimas publicaciones, para no repetir).
Proponé para el CANAL indicado. Escribí EXCLUSIVAMENTE el archivo /tmp/propuestas.json (array de objetos). NO publiques, NO toques la base, NO mandes mails: solo escribí el archivo."
timeout 900 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1

if [ ! -s /tmp/propuestas.json ]; then
  echo "$(ts) ERROR: no se generó propuestas.json" >> "$LOG"
  psqlc "UPDATE contenido.solicitudes_propuesta SET estado='error', procesado_en=now() WHERE id='$sid';" >/dev/null
  hb "error (sin propuestas)"
  exit 1
fi

n=$(python3 "$MOTOR/scripts/propuestas_publicar.py" "$CID" "$CHAT" "$BOT" "$canal" "$pid" 2>>"$LOG")
echo "$(ts) propuestas cargadas: $n" >> "$LOG"
psqlc "UPDATE contenido.solicitudes_propuesta SET estado='procesado', procesado_en=now(), resultado='$n propuestas' WHERE id='$sid';" >/dev/null
# aviso a Fer
curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=El creativo cargó $n propuestas nuevas en la cola. Revisalas en https://panel.clausina.ar" -o /dev/null 2>&1
hb "$n propuestas cargadas"
echo "$(ts) fin pedido $sid" >> "$LOG"
