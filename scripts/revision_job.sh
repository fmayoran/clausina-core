#!/usr/bin/env bash
# Job de REVISIÓN de concepto de una propuesta (loop "pedir nueva versión").
# El creativo reescribe el TEXTO/concepto de la propuesta (tg_briefs) incorporando
# los comentarios de Fer y la deja de nuevo en estado 'propuesta' para re-revisar.
# SOLO texto: NO genera la pieza, NO publica, NO toca git ni producción.
# Lo invoca el worker (handlers/revision.py); el ruteo/cola lo hace el dispatcher.
# Uso: revision_job.sh <slug> <brief_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; bid="${2:-}"
{ [ -z "$slug" ] || [ -z "$bid" ]; } && { echo "uso: revision_job.sh <slug> <brief_id>" >&2; exit 2; }

MARCAS="/root/clausina/marcas"
MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/propuestas_local.log"
CID=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psqlc(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }
hb(){ psqlc "INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) VALUES('propuestas',now(),\$m\$$1\$m\$) ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;" >/dev/null 2>&1; }

exec 9>"/tmp/cf_revision_${bid}.lock"; flock -n 9 || exit 0

# Brief en estado procesable (revisar). Lo tomamos y marcamos 'revisando' (transitorio).
row=$(psqlc "SELECT row_to_json(t) FROM (SELECT id,titulo,texto,comentarios,canal_destino,negocio_id FROM contenido.tg_briefs WHERE id='$bid' AND estado='revisar' LIMIT 1) t;")
[ -z "$row" ] && { echo "$(ts) revisión $bid sin estado procesable" >> "$LOG"; exit 0; }

pid=$(psqlc "SELECT id FROM contenido.negocios WHERE slug='$slug';")
CHAT=$(psqlc "SELECT coalesce(telegram_chat_id,'') FROM contenido.negocios WHERE slug='$slug';")
NOMBRE=$(psqlc "SELECT nombre FROM contenido.negocios WHERE slug='$slug';"); [ -z "$NOMBRE" ] && NOMBRE="$slug"
REPO="$MARCAS/$slug"
[ -d "$REPO" ] || { echo "$(ts) ERROR: cápsula inexistente $REPO" >> "$LOG"; psqlc "UPDATE contenido.tg_briefs SET estado='propuesta' WHERE id='$bid';" >/dev/null; exit 1; }
BOT=$(grep '^TELEGRAM_BOT_TOKEN=' "$REPO/$slug.env" 2>/dev/null | cut -d= -f2-)

echo "$(ts) revisión $bid (proyecto=$slug)" >> "$LOG"
hb "preparando nueva versión"
psqlc "UPDATE contenido.tg_briefs SET estado='revisando' WHERE id='$bid' AND estado='revisar';" >/dev/null

# Contexto para el creativo: concepto actual + comentarios de Fer.
CONCEPTO=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('texto') or '')")
TITULO=$(echo "$row"  | python3 -c "import sys,json;print(json.load(sys.stdin).get('titulo') or '')")
COMENT=$(echo "$row"  | python3 -c "import sys,json;print(json.load(sys.stdin).get('comentarios') or '')")
CANAL=$(echo "$row"   | python3 -c "import sys,json;print(json.load(sys.stdin).get('canal_destino') or 'instagram')")
rm -f "/tmp/rev_out_$bid.json"
TT="$TITULO" CO="$CONCEPTO" CM="$COMENT" CN="$CANAL" python3 -c "import json,os;json.dump({'titulo':os.environ['TT'],'concepto':os.environ['CO'],'comentarios':os.environ['CM'],'canal':os.environ['CN']},open('/tmp/rev_ctx_$bid.json','w'),ensure_ascii=False)"

cd "$REPO" || exit 1
bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true

PROMPT="Sos el Director Creativo del proyecto (identidad, voz y estética en contexto/CONTEXTO_MARCA.md y el CLAUDE.md del directorio actual: leelos y respetalos; NO uses contexto de otra marca). Corrés como rutina automática NO interactiva en el VPS.
Ya habías propuesto un CONCEPTO para el canal indicado y Fer te pide AJUSTARLO (NO empezar de cero): conservá lo que funciona y aplicá SUS comentarios.
Datos en /tmp/rev_ctx_$bid.json: 'titulo' y 'concepto' (la propuesta actual), 'comentarios' (lo que Fer quiere cambiar) y 'canal' (instagram=feed, o aviso=spot DOOH 2:3).
Reescribí la propuesta incorporando los comentarios, en el MISMO formato y nivel de detalle que una propuesta de la cola (seguí el estilo de $MOTOR/scripts/propuestas_creativo.md). Es SOLO el concepto en texto: NO generes imágenes ni video, NO publiques, NO toques la base, NO toques git.
Escribí EXCLUSIVAMENTE el archivo /tmp/rev_out_$bid.json con un único objeto JSON: {\"titulo\":\"...\",\"texto\":\"...\"} (titulo corto; texto = el concepto reescrito)."
timeout 600 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1

if [ ! -s "/tmp/rev_out_$bid.json" ]; then
  echo "$(ts) ERROR: revisión sin salida $bid" >> "$LOG"
  psqlc "UPDATE contenido.tg_briefs SET estado='propuesta' WHERE id='$bid';" >/dev/null
  hb "error en revisión"
  [ -n "$BOT" ] && curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=No pude preparar la nueva versión de la propuesta. Probá de nuevo desde el panel." -o /dev/null 2>&1
  exit 1
fi

# Aplica la nueva versión de forma segura (dollar-quoting con tag aleatorio; el texto puede ser multilínea).
ok=$(CID="$CID" BID="$bid" python3 - <<'PY'
import json, os, secrets, subprocess
bid = os.environ["BID"]; cid = os.environ["CID"]
d = json.load(open(f"/tmp/rev_out_{bid}.json"))
tit = (d.get("titulo") or "").strip()[:200]
txt = (d.get("texto") or "").strip()
if not txt:
    print("0"); raise SystemExit
t1 = "q" + secrets.token_hex(6); t2 = "q" + secrets.token_hex(6)
sql = (f"UPDATE contenido.tg_briefs SET titulo=${t1}${tit}${t1}$, texto=${t2}${txt}${t2}$, "
       f"estado='propuesta', comentarios=NULL, procesado_en=now() "
       f"WHERE id='{bid}' AND estado='revisando';")
r = subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-q","-t","-A",
                    "-c", sql + " SELECT 'done';"], capture_output=True, text=True)
print("1" if "done" in (r.stdout or "") else "0")
PY
)

if [ "$ok" = "1" ]; then
  echo "$(ts) nueva versión lista $bid" >> "$LOG"
  hb "nueva versión lista"
  [ -n "$BOT" ] && curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=El creativo dejó una nueva versión de la propuesta. Revisala en https://panel.clausina.ar" -o /dev/null 2>&1
else
  echo "$(ts) ERROR: no se aplicó la revisión $bid" >> "$LOG"
  psqlc "UPDATE contenido.tg_briefs SET estado='propuesta' WHERE id='$bid' AND estado='revisando';" >/dev/null
  hb "error aplicando revisión"
fi
rm -f "/tmp/rev_ctx_$bid.json" "/tmp/rev_out_$bid.json"
echo "$(ts) fin revisión $bid" >> "$LOG"
