#!/usr/bin/env bash
# Responde UN mensaje del hilo de una pieza. Uso: pieza_chat_job.sh <slug> <mensaje_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; mid="${2:-}"
{ [ -z "$slug" ] || [ -z "$mid" ]; } && { echo "uso: pieza_chat_job.sh <slug> <mensaje_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"; MARCAS="/root/clausina/marcas"
LOG="$MOTOR/scripts/pieza_chat.log"
CID=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$CID" ] && { echo "sin base" >&2; exit 1; }
ts(){ date -Is; }
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -q -c "$1"; }
fallar(){ psql "UPDATE contenido.pieza_chat SET estado='error', error=left(\$e\$$1\$e\$,300), respondido_en=now() WHERE id='$mid';" >/dev/null; echo "$1" >&2; exit 1; }

exec 9>"/tmp/chat_$mid.lock"; flock -n 9 || exit 0
estado=$(psql "SELECT estado FROM contenido.pieza_chat WHERE id='$mid';")
case "$estado" in pendiente|procesando) ;; *) exit 0;; esac
psql "UPDATE contenido.pieza_chat SET estado='procesando' WHERE id='$mid';" >/dev/null

REPO="$MARCAS/$slug"; [ -d "$REPO" ] || fallar "sin cápsula para $slug"
rm -f /tmp/chat_ctx.json /tmp/chat_res.txt

CID="$CID" MID="$mid" SLUG="$slug" MOTOR="$MOTOR" python3 - <<'PY'
import json, os, subprocess
cid=os.environ["CID"]; mid=os.environ["MID"]; slug=os.environ["SLUG"]; MOTOR=os.environ["MOTOR"]
def q(sql):
    return subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-t","-A","-c",sql],
                          capture_output=True, text=True).stdout.strip()
pieza_id = q(f"SELECT pieza_id FROM contenido.pieza_chat WHERE id='{mid}'")
pieza = q("SELECT row_to_json(t) FROM (SELECT 'CF-'||lpad(pz.numero::text,4,'0') AS numero,"
          "pz.titulo_interno AS titulo, pz.estado, r.formato, r.caption,"
          "(SELECT count(*) FROM contenido.media m WHERE m.pieza_id=pz.id) AS medios,"
          "(SELECT tipo::text FROM contenido.media m WHERE m.pieza_id=pz.id ORDER BY orden LIMIT 1) AS tipo "
          "FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente "
          f"WHERE pz.id='{pieza_id}') t")
# EL HILO ENTERO: es lo único que le da continuidad, porque entre llamadas no recuerda nada.
hilo = q("SELECT COALESCE(json_agg(json_build_object('rol',rol,'texto',texto) ORDER BY creado_en),'[]') "
         f"FROM contenido.pieza_chat WHERE pieza_id='{pieza_id}' AND estado<>'error'")
motivos = q("SELECT COALESCE(json_agg(left(motivo_rechazo,400) ORDER BY creado_en),'[]') "
            f"FROM contenido.revisiones WHERE pieza_id='{pieza_id}' AND coalesce(motivo_rechazo,'')<>''")
bit = q("SELECT coalesce(left(bitacora::text,3000),'') FROM contenido.revisiones r "
        f"JOIN contenido.piezas pz ON pz.revision_vigente=r.id WHERE pz.id='{pieza_id}'")
try:
    r=subprocess.run(["python3", f"{MOTOR}/scripts/rendimiento.py", slug, "--json"],
                     capture_output=True, text=True, timeout=60)
    rend=json.loads(r.stdout) if r.returncode==0 and r.stdout.strip() else None
except Exception: rend=None
json.dump({"pieza":json.loads(pieza or '{}'), "hilo":json.loads(hilo or '[]'),
           "motivos":json.loads(motivos or '[]'), "bitacora":bit, "rendimiento":rend},
          open("/tmp/chat_ctx.json","w"), ensure_ascii=False)
print("ctx ok")
PY

cd "$REPO" || fallar "no pude entrar a la cápsula"
PROMPT="Sos el Director Creativo de este negocio (identidad y voz en contexto/CONTEXTO_MARCA.md). Fer te escribio sobre una pieza. Segui EXACTAMENTE $MOTOR/scripts/pieza_chat.md. El contexto y el HILO COMPLETO estan en /tmp/chat_ctx.json: leelo entero. Escribi SOLO /tmp/chat_res.txt. NO modifiques la pieza, NO publiques, NO toques la base ni archivos del repo."
timeout 420 claude -p "$PROMPT" --model sonnet --allowedTools Read Write >> "$LOG" 2>&1
rc=$?
if [ $rc -ne 0 ] || [ ! -s /tmp/chat_res.txt ]; then
  msg="no pude responder"
  [ $rc -eq 124 ] && msg="tardé demasiado en responder"
  tail -c 20000 "$LOG" 2>/dev/null | grep -qi "session limit\|usage limit\|rate limit" && msg="sin cupo de suscripción; probá en un rato"
  fallar "$msg"
fi

CID="$CID" MID="$mid" python3 - <<'PY'
import os, subprocess
cid=os.environ["CID"]; mid=os.environ["MID"]
texto=open("/tmp/chat_res.txt", encoding="utf-8").read().strip()[:4000]
def psql(sql):
    return subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-t","-A","-c",sql],
                          capture_output=True, text=True)
pid=psql(f"SELECT pieza_id FROM contenido.pieza_chat WHERE id='{mid}'").stdout.strip()
psql("INSERT INTO contenido.pieza_chat (pieza_id,rol,texto,estado) VALUES "
     f"('{pid}','creativo',$q${texto}$q$,'listo');")
psql(f"UPDATE contenido.pieza_chat SET estado='listo', respondido_en=now() WHERE id='{mid}';")
print("respondido")
PY
echo "$(ts) chat $mid ok" >> "$LOG"
