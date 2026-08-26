#!/usr/bin/env bash
# Destila las correcciones de Fer en propuestas de aprendizaje. NO escribe en el brief: deja
# propuestas en contenido.aprendizaje esperando su visto.
# Uso: aprendizaje_job.sh <slug> <req_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; rid="${2:-}"
{ [ -z "$slug" ] || [ -z "$rid" ]; } && { echo "uso: aprendizaje_job.sh <slug> <req_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"
MARCAS="/root/clausina/marcas"
LOG="$MOTOR/scripts/aprendizaje.log"
CID=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$CID" ] && { echo "sin contenedor de base" >&2; exit 1; }
ts(){ date -Is; }
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -q -c "$1"; }
fallar(){ psql "UPDATE contenido.aprendizaje_req SET estado='error', resumen=left(\$e\$$1\$e\$,400), procesado_en=now() WHERE id='$rid';" >/dev/null; echo "$1" >&2; exit 1; }

exec 9>"/tmp/apr_$rid.lock"; flock -n 9 || exit 0
estado=$(psql "SELECT estado FROM contenido.aprendizaje_req WHERE id='$rid';")
case "$estado" in pendiente|procesando) ;; *) exit 0;; esac
psql "UPDATE contenido.aprendizaje_req SET estado='procesando' WHERE id='$rid';" >/dev/null
echo "$(ts) destilando $slug ($rid)" >> "$LOG"

pid=$(psql "SELECT id FROM contenido.negocios WHERE slug='$slug';")
[ -z "$pid" ] && fallar "negocio inexistente"
REPO="$MARCAS/$slug"; [ -d "$REPO" ] || fallar "sin cápsula para $slug"

rm -f /tmp/apr_ctx.json /tmp/apr_res.json
CID="$CID" PID="$pid" python3 - <<'PY'
import json, os, subprocess
cid=os.environ["CID"]; pid=os.environ["PID"]
def q(sql):
    return subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-t","-A","-c",sql],
                          capture_output=True, text=True).stdout.strip()
corr = q("SELECT COALESCE(json_agg(json_build_object("
         "'pieza','CF-'||lpad(pz.numero::text,4,'0'),'titulo',pz.titulo_interno,"
         "'motivo',left(r.motivo_rechazo,600)) ORDER BY r.creado_en DESC),'[]') "
         "FROM contenido.revisiones r JOIN contenido.piezas pz ON pz.id=r.pieza_id "
         f"WHERE pz.negocio_id='{pid}' AND coalesce(r.motivo_rechazo,'')<>''")
prev = q("SELECT COALESCE(json_agg(json_build_object('texto',texto,'estado',estado)),'[]') "
         f"FROM contenido.aprendizaje WHERE negocio_id='{pid}'")
brief = q(f"SELECT coalesce(brief_md,'') FROM contenido.negocio_perfil WHERE negocio_id='{pid}'")
ctx={"correcciones":json.loads(corr or '[]'), "ya_propuesto":json.loads(prev or '[]'), "brief":brief}
json.dump(ctx, open("/tmp/apr_ctx.json","w"), ensure_ascii=False)
print(f"ctx: {len(ctx['correcciones'])} correcciones, {len(ctx['ya_propuesto'])} propuestas previas")
PY

n_corr=$(python3 -c "import json;print(len(json.load(open('/tmp/apr_ctx.json'))['correcciones']))" 2>/dev/null || echo 0)
if [ "${n_corr:-0}" -lt 3 ]; then
  psql "UPDATE contenido.aprendizaje_req SET estado='listo', resumen='Todavía hay pocas correcciones para encontrar un patrón.', procesado_en=now() WHERE id='$rid';" >/dev/null
  echo "$(ts) $slug: sólo $n_corr correcciones, no alcanza" >> "$LOG"; exit 0
fi

cd "$REPO" || fallar "no pude entrar a la cápsula"
PROMPT="Sos la MEMORIA DEL CREATIVO de este negocio. Segui EXACTAMENTE $MOTOR/scripts/aprendizaje.md. El contexto esta en /tmp/apr_ctx.json. Escribi SOLO /tmp/apr_res.json. NO toques la base, NO publiques, NO edites el brief ni ningun archivo del repo."
timeout 600 claude -p "$PROMPT" --model sonnet --allowedTools Read Write >> "$LOG" 2>&1
rc=$?
if [ $rc -ne 0 ]; then
  msg="la destilación falló (exit $rc)"
  tail -c 20000 "$LOG" 2>/dev/null | grep -qi "session limit\|usage limit\|rate limit" && msg="sin cupo de suscripción; reintentá más tarde"
  fallar "$msg"
fi
[ -s /tmp/apr_res.json ] || fallar "no se generó ninguna propuesta"

CID="$CID" PID="$pid" RID="$rid" python3 - <<'PY'
import json, os, subprocess
cid=os.environ["CID"]; pid=os.environ["PID"]; rid=os.environ["RID"]
def psql(sql):
    return subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-t","-A","-c",sql],
                          capture_output=True, text=True)
def dq(v): return "$q$" + str(v) + "$q$"
try: props=json.load(open("/tmp/apr_res.json"))
except Exception: props=[]
if not isinstance(props, list): props=[]
n=0
for p in props[:5]:
    texto=(p.get("texto") or "").strip()
    ev=p.get("evidencia") or []
    # Sin evidencia no entra: una regla que no se puede rastrear a una corrección real es una
    # opinión del modelo, y eso es justo lo que no queremos meter en el brief.
    if not texto or not ev: continue
    psql("INSERT INTO contenido.aprendizaje (negocio_id,texto,porque,evidencia) VALUES "
         f"('{pid}',{dq(texto[:800])},{dq((p.get('porque') or '')[:600])},{dq(json.dumps(ev,ensure_ascii=False))}::jsonb);")
    n+=1
resumen = f"{n} propuesta(s) de aprendizaje para revisar." if n else "No encontré patrones nuevos que valga la pena proponer."
psql(f"UPDATE contenido.aprendizaje_req SET estado='listo', resumen={dq(resumen)}, procesado_en=now() WHERE id='{rid}';")
print(f"guardadas:{n}")
PY
echo "$(ts) $slug listo" >> "$LOG"
