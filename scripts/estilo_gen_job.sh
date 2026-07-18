#!/usr/bin/env bash
# Generar/regenerar el estilo de marca: el director de arte documenta el sistema de diseño a
# partir del brief + lo publicado + Instagram + la paleta. Escribe proyecto_perfil.estilo_md.
# NO publica, NO toca git/landing. Uso: estilo_gen_job.sh <slug> <gen_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; gid="${2:-}"
{ [ -z "$slug" ] || [ -z "$gid" ]; } && { echo "uso: estilo_gen_job.sh <slug> <gen_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/estilo_gen.log"
PG=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1"; }

exec 9>"/tmp/estilo_${gid}.lock"; flock -n 9 || exit 0

estado=$(psql "SELECT estado FROM contenido.marca_gen WHERE id='$gid' AND tipo='estilo';")
case "$estado" in pendiente|procesando) ;; *) echo "$(ts) $gid sin estado procesable ($estado)" >> "$LOG"; exit 0;; esac
pid=$(psql "SELECT proyecto_id FROM contenido.marca_gen WHERE id='$gid';")
[ -z "$pid" ] && exit 0

echo "$(ts) estilo $gid ($slug)" >> "$LOG"
psql "UPDATE contenido.marca_gen SET estado='procesando' WHERE id='$gid';" >/dev/null

SHOTS="/tmp/estilo_feed_$gid"
rm -rf "$SHOTS" "/tmp/estilo_res_$gid.md"; mkdir -p "$SHOTS"

# Contexto: brief + estilo actual + slogan + IG handle + publicaciones (captions).
PG="$PG" PID="$pid" GID="$gid" python3 - <<'PY'
import json, os, subprocess
pg=os.environ["PG"]; pid=os.environ["PID"]; gid=os.environ["GID"]
def q(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True).stdout.strip()
perfil = q(f"SELECT coalesce(pp.brief_md,'')||E'\\n---SLOGAN---\\n'||coalesce(pp.slogan,'')||E'\\n---ESTILO---\\n'||coalesce(pp.estilo_md,'') "
           f"FROM contenido.proyecto_perfil pp WHERE pp.proyecto_id='{pid}'")
brief, _, rest = perfil.partition('\n---SLOGAN---\n')
slogan, _, estilo = rest.partition('\n---ESTILO---\n')
ig = q(f"SELECT coalesce(ig_handle,'') FROM contenido.proyectos WHERE id='{pid}'")
pubs = q("SELECT coalesce(json_agg(t),'[]') FROM ("
         "SELECT pz.numero, r.caption, "
         "(SELECT tipo FROM contenido.media WHERE pieza_id=pz.id AND orden=1) AS tipo "
         f"FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente "
         f"WHERE pz.proyecto_id='{pid}' AND pz.canal='instagram' AND r.estado='publicada' "
         "ORDER BY pz.numero DESC LIMIT 30) t")
try: publicaciones=json.loads(pubs)
except Exception: publicaciones=[]
ctx={"brief":brief.strip(),"slogan":slogan.strip(),"estilo_actual":estilo.strip(),
     "instagram":ig,"publicaciones":publicaciones}
json.dump(ctx, open(f"/tmp/estilo_ctx_{gid}.json","w"), ensure_ascii=False)
print(f"ctx: {len(publicaciones)} publicaciones, ig={ig or '-'}")
PY

# Perfil de IG + imágenes del feed (vía la lente): el estilo se ve, no se deduce.
IG=$(python3 -c "import json;print(json.load(open('/tmp/estilo_ctx_$gid.json')).get('instagram',''))")
if [ -n "$IG" ]; then
  python3 "$MOTOR/scripts/ig_publico.py" "$IG" --media 12 --fotos "$SHOTS" > "/tmp/estilo_ig_$gid.json" 2>>"$LOG" || true
fi

PROMPT="Sos el DIRECTOR DE ARTE de ClaUsina. Segui EXACTAMENTE $MOTOR/scripts/estilo_gen.md. El contexto (brief, slogan, estilo actual si hay, publicaciones con captions) esta en /tmp/estilo_ctx_$gid.json. Si existe /tmp/estilo_ig_$gid.json es el perfil publico de Instagram (datos reales). Si hay imagenes en $SHOTS, ABRILAS CON Read: son el feed real, el estilo se VE. Escribi el resultado en /tmp/estilo_res_$gid.md. Documenta lo que EXISTE, no impongas la estetica de otra marca. No toques la base, ni git, ni publiques nada."
timeout 900 claude -p "$PROMPT" --model sonnet --allowedTools Read Write WebFetch Bash Glob Grep >> "$LOG" 2>&1

# Guardar el estilo en el perfil (fuente de verdad).
res=$(PG="$PG" PID="$pid" GID="$gid" python3 - <<'PY'
import os, secrets, subprocess
pg=os.environ["PG"]; pid=os.environ["PID"]; gid=os.environ["GID"]
def psql(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True)
def dq(v):
    t="x"+secrets.token_hex(8); return f"${t}${v or ''}${t}$"
def fallar(msg):
    psql(f"UPDATE contenido.marca_gen SET estado='error', error={dq(msg[:800])}, procesado_en=now() WHERE id='{gid}';")
    print("err:"+msg[:150])
try:
    txt=open(f"/tmp/estilo_res_{gid}.md", encoding="utf-8").read().strip()
except Exception:
    fallar("El director de arte no dejó resultado. Probá de nuevo."); raise SystemExit
if not txt or txt.startswith("SIN_DATOS"):
    motivo=txt.split(":",1)[1].strip() if ":" in txt else "faltan datos de la marca (brief, publicaciones, IG)"
    fallar("No se pudo generar el estilo: "+motivo); raise SystemExit
if len(txt) < 120:
    fallar("El estilo salió demasiado corto. Probá de nuevo."); raise SystemExit
r=psql(f"UPDATE contenido.proyecto_perfil SET estilo_md={dq(txt)}, actualizado_en=now() WHERE proyecto_id='{pid}';")
if r.returncode!=0:
    fallar("No se pudo guardar el estilo: "+(r.stderr or '').strip()[:300]); raise SystemExit
psql(f"UPDATE contenido.marca_gen SET estado='listo', error=NULL, procesado_en=now() WHERE id='{gid}';")
print("ok")
PY
)
echo "$(ts) estilo $gid -> $res" >> "$LOG"
if [[ "$res" == ok* ]]; then
  rm -rf "$SHOTS" "/tmp/estilo_ctx_$gid.json" "/tmp/estilo_ig_$gid.json" "/tmp/estilo_res_$gid.md"
fi
