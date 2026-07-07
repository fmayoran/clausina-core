#!/usr/bin/env bash
# Campaña: el creativo PROPONE una campaña de pauta. Mira el contexto de marca + las
# publicaciones ya publicadas (posibles creativos) y deja un BORRADOR en contenido.campanias
# (estado='propuesta'). NO crea nada en Meta, NO publica, NO toca landing/base/git.
# Uso: campania_job.sh <slug> <solicitud_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; sid="${2:-}"
{ [ -z "$slug" ] || [ -z "$sid" ]; } && { echo "uso: campania_job.sh <slug> <solicitud_id>" >&2; exit 2; }

MARCAS="/root/clausina/marcas"
MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/campania.log"
CID=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }

exec 9>"/tmp/camp_${sid}.lock"; flock -n 9 || exit 0

pid=$(psql "SELECT proyecto_id FROM contenido.solicitudes_campania WHERE id='$sid' AND estado IN ('pendiente','procesando') LIMIT 1;")
[ -z "$pid" ] && { echo "$(ts) solicitud $sid sin estado procesable" >> "$LOG"; exit 0; }

REPO="$MARCAS/$slug"
[ -d "$REPO" ] || { echo "$(ts) ERROR: cápsula inexistente $REPO" >> "$LOG"; psql "UPDATE contenido.solicitudes_campania SET estado='error', resumen='Cápsula de marca inexistente.', procesado_en=now() WHERE id='$sid';" >/dev/null; exit 1; }
CHAT=$(psql "SELECT coalesce(telegram_chat_id,'') FROM contenido.proyectos WHERE slug='$slug';")
BOT=$(grep '^TELEGRAM_BOT_TOKEN=' "$REPO/$slug.env" 2>/dev/null | cut -d= -f2-)

echo "$(ts) solicitud $sid ($slug)" >> "$LOG"
psql "UPDATE contenido.solicitudes_campania SET estado='procesando' WHERE id='$sid';" >/dev/null

# Contexto para el creativo: instrucción + marca + moneda + publicaciones disponibles como creativo.
cd "$REPO" || exit 1
bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true
CID="$CID" SID="$sid" PID="$pid" python3 - <<'PY'
import json, os, subprocess
cid=os.environ["CID"]; sid=os.environ["SID"]; pid=os.environ["PID"]
def q(sql):
    return subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-t","-A","-c",sql],
                          capture_output=True, text=True).stdout.strip()
instr = q(f"SELECT coalesce(instruccion,'') FROM contenido.solicitudes_campania WHERE id='{sid}'")
perfil = q(f"SELECT coalesce(pp.brief_md,'')||E'\\n---ESTILO---\\n'||coalesce(pp.estilo_md,'') "
           f"FROM contenido.proyecto_perfil pp WHERE pp.proyecto_id='{pid}'")
brief, _, estilo = perfil.partition('\n---ESTILO---\n')
objetivo = q(f"SELECT coalesce(pp.slogan,'') FROM contenido.proyecto_perfil pp WHERE pp.proyecto_id='{pid}'")
moneda = q(f"SELECT coalesce(data->'cuenta'->>'moneda','USD') FROM contenido.ads_snapshot WHERE proyecto_id='{pid}'") or "USD"
pubs = q("SELECT coalesce(json_agg(t),'[]') FROM ("
         "SELECT pz.id AS pieza_id, pz.numero, r.caption, r.ig_permalink AS permalink, "
         "(SELECT tipo FROM contenido.media WHERE pieza_id=pz.id AND orden=1) AS tipo "
         f"FROM contenido.piezas pz JOIN contenido.revisiones r ON r.pieza_id=pz.id "
         f"WHERE pz.proyecto_id='{pid}' AND pz.canal='instagram' AND r.estado='publicada' "
         "ORDER BY pz.numero DESC LIMIT 20) t")
try: publicaciones=json.loads(pubs)
except Exception: publicaciones=[]
ctx={"instruccion":instr,"objetivo_marca":objetivo,"brief":brief.strip(),"estilo":estilo.strip(),
     "moneda":moneda,"publicaciones":publicaciones}
json.dump(ctx, open(f"/tmp/camp_ctx_{sid}.json","w"), ensure_ascii=False)
print(f"ctx: {len(publicaciones)} publicaciones, moneda {moneda}")
PY

rm -f "/tmp/camp_res_$sid.json"
PROMPT="Sos el ESTRATEGA DE PAUTA del proyecto. Segui EXACTAMENTE $MOTOR/scripts/campania.md. El contexto (pedido, marca, publicaciones disponibles) esta en /tmp/camp_ctx_$sid.json. Escribi el resultado en /tmp/camp_res_$sid.json como indica la skill. Es una PROPUESTA: NO crees nada en Meta, NO publiques, NO toques Instagram/landing/base/git."
timeout 900 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1

if [ ! -s "/tmp/camp_res_$sid.json" ]; then
  echo "$(ts) ERROR: sin resultado $sid" >> "$LOG"
  psql "UPDATE contenido.solicitudes_campania SET estado='error', resumen='El creativo no dejó una propuesta. Probá reformular el pedido.', procesado_en=now() WHERE id='$sid';" >/dev/null
  [ -n "$BOT" ] && curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=El creativo no pudo proponer la campaña. Proba reformulando." -o /dev/null 2>&1
  exit 1
fi

# Insertar el borrador en contenido.campanias (estado='propuesta') y enlazar la solicitud.
res=$(CID="$CID" SID="$sid" PID="$pid" python3 - <<'PY'
import json, os, secrets, subprocess
sid=os.environ["SID"]; cid=os.environ["CID"]; pid=os.environ["PID"]
def psql(sql):
    return subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-t","-A","-c",sql],
                          capture_output=True, text=True)
def dq(v):
    t="x"+secrets.token_hex(8); return f"${t}${v or ''}${t}$"
def upd_sol(sets):
    psql(f"UPDATE contenido.solicitudes_campania SET {sets}, procesado_en=now() WHERE id='{sid}';")
try: d=json.load(open(f"/tmp/camp_res_{sid}.json"))
except Exception as e: d={"error":f"resultado ilegible: {e}"}
err=(d.get("error") or "").strip()
if err:
    upd_sol(f"estado='error', resumen={dq(err[:2000])}"); print("err:"+err[:180]); raise SystemExit

OBJ_OK={"OUTCOME_AWARENESS","OUTCOME_TRAFFIC","OUTCOME_ENGAGEMENT"}
nombre=(d.get("nombre") or "Campaña").strip()[:120]
objetivo=(d.get("objetivo") or "").strip()
if objetivo not in OBJ_OK:
    upd_sol(f"estado='error', resumen={dq('Objetivo inválido: '+objetivo)}"); print("err:objetivo"); raise SystemExit
pieza=(d.get("pieza_id") or "").strip()
pieza_sql = f"'{pieza}'" if pieza and pieza.lower()!="null" else "NULL"
razon=(d.get("razon") or "").strip()[:4000]
resumen=(d.get("resumen") or "").strip()[:600]
aud=json.dumps(d.get("audiencia") or {}, ensure_ascii=False)
pres=json.dumps(d.get("presupuesto") or {}, ensure_ascii=False)
fi=(d.get("fecha_inicio") or "").strip(); ff=(d.get("fecha_fin") or "").strip()
fi_sql=f"'{fi}'" if fi else "NULL"; ff_sql=f"'{ff}'" if ff else "NULL"
url=(d.get("url_destino") or "").strip() or None
cta=(d.get("cta") or "").strip() or None
sql=("INSERT INTO contenido.campanias "
     "(proyecto_id,estado,nombre,objetivo,pieza_id,razon,audiencia,presupuesto,fecha_inicio,fecha_fin,url_destino,cta,resumen) "
     f"VALUES ('{pid}','propuesta',{dq(nombre)},'{objetivo}',{pieza_sql},{dq(razon)},{dq(aud)}::jsonb,{dq(pres)}::jsonb,"
     f"{fi_sql},{ff_sql},{('NULL' if url is None else dq(url))},{('NULL' if cta is None else dq(cta))},{dq(resumen)}) "
     "RETURNING id;")
r=psql(sql)
if r.returncode!=0 or not r.stdout.strip():
    upd_sol(f"estado='error', resumen={dq('No se pudo guardar la propuesta: '+(r.stderr or '').strip()[:400])}")
    print("err:insert "+(r.stderr or '').strip()[:180]); raise SystemExit
camp_id=r.stdout.strip().splitlines()[0]
upd_sol(f"estado='listo', campania_id='{camp_id}', resumen={dq(resumen)}")
print("ok:"+nombre)
PY
)
if [[ "$res" == ok:* ]]; then
  echo "$(ts) propuesta lista $sid" >> "$LOG"
  [ -n "$BOT" ] && curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=El creativo propuso una campaña de pauta: ${res#ok:}. Revisala y aprobala en https://panel.clausina.ar/pauta" -o /dev/null 2>&1
else
  echo "$(ts) error $sid: ${res#err:}" >> "$LOG"
  [ -n "$BOT" ] && curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=El creativo no pudo proponer la campaña: ${res#err:}" -o /dev/null 2>&1
fi
rm -f "/tmp/camp_ctx_$sid.json" "/tmp/camp_res_$sid.json"
echo "$(ts) fin solicitud $sid" >> "$LOG"
