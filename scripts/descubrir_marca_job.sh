#!/usr/bin/env bash
# Descubrimiento de marca: el analista lee la presencia digital PÚBLICA (web + IG + búsqueda)
# y deja una base de identidad en contenido.marca_descubrimiento (estado='listo', resultado jsonb).
# Corre antes de que la marca exista: NO hay cápsula, NO toca la DB de contenido, NO publica.
# Uso: descubrir_marca_job.sh <descubrimiento_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

did="${1:-}"
[ -z "$did" ] && { echo "uso: descubrir_marca_job.sh <descubrimiento_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/descubrir_marca.log"
PG=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1"; }

exec 9>"/tmp/desc_${did}.lock"; flock -n 9 || exit 0

estado=$(psql "SELECT estado FROM contenido.marca_descubrimiento WHERE id='$did';")
case "$estado" in pendiente|procesando) ;; *) echo "$(ts) $did sin estado procesable ($estado)" >> "$LOG"; exit 0;; esac

echo "$(ts) descubrimiento $did" >> "$LOG"
psql "UPDATE contenido.marca_descubrimiento SET estado='procesando' WHERE id='$did';" >/dev/null

# Contexto para el analista.
PG="$PG" DID="$did" python3 - <<'PY'
import json, os, subprocess
pg=os.environ["PG"]; did=os.environ["DID"]
def q(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True).stdout.strip()
row=q("SELECT coalesce(nombre,'')||'|#|'||coalesce(web,'')||'|#|'||coalesce(instagram,'')||'|#|'||coalesce(notas,'') "
      f"FROM contenido.marca_descubrimiento WHERE id='{did}'")
nombre, web, ig, notas = (row.split('|#|') + ['','','',''])[:4]
json.dump({"nombre":nombre,"web":web,"instagram":ig,"notas":notas},
          open(f"/tmp/desc_ctx_{did}.json","w"), ensure_ascii=False)
print(f"ctx: {nombre or '(sin nombre)'} web={web or '-'} ig={ig or '-'}")
PY

# Dossier: bajamos nosotros el sitio (WebFetch respeta robots.txt y casi toda web de marca
# bloquea crawlers de IA -> el análisis volvía vacío). Ver web_dossier.py.
DOS="/tmp/desc_web_$did.md"
SHOT="/tmp/desc_shot_$did.png"
WEB=$(python3 -c "import json;print(json.load(open('/tmp/desc_ctx_$did.json')).get('web',''))")
IG=$(python3 -c "import json;print(json.load(open('/tmp/desc_ctx_$did.json')).get('instagram',''))")
python3 "$MOTOR/scripts/web_dossier.py" --web "$WEB" --ig "$IG" --out "$DOS" --shot "$SHOT" >> "$LOG" 2>&1 || echo "" > "$DOS"

rm -f "/tmp/desc_res_$did.json"
PROMPT="Sos el ANALISTA DE MARCA de ClaUsina. Segui EXACTAMENTE $MOTOR/scripts/descubrir_marca.md. El pedido (nombre, web, instagram, notas) esta en /tmp/desc_ctx_$did.json y el DOSSIER ya bajado del sitio esta en $DOS: leelo PRIMERO, es tu fuente principal. Si existe la captura de la home $SHOT, ABRILA CON Read: es la unica forma de ver la identidad visual real (tipografia, imaginario, uso del color). Usa WebSearch para completar lo que falte. Escribi el resultado en /tmp/desc_res_$did.json con el formato que indica la skill. Solo LEES fuentes publicas: no toques la base, ni git, ni publiques nada, ni crees la marca."
timeout 600 claude -p "$PROMPT" --model sonnet --allowedTools WebFetch WebSearch Read Write >> "$LOG" 2>&1

PG="$PG" DID="$did" python3 - <<'PY'
import json, os, secrets, subprocess
pg=os.environ["PG"]; did=os.environ["DID"]
def psql(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True)
def dq(v):
    t="x"+secrets.token_hex(8); return f"${t}${v or ''}${t}$"
def fallar(msg):
    psql(f"UPDATE contenido.marca_descubrimiento SET estado='error', error={dq(msg[:1000])}, procesado_en=now() WHERE id='{did}';")
    print("err:"+msg[:160])

try:
    d=json.load(open(f"/tmp/desc_res_{did}.json"))
except Exception as e:
    fallar(f"El analista no dejó un resultado legible ({e}). Probá de nuevo o cargá los datos a mano."); raise SystemExit

err=(d.get("error") or "").strip()
if err:
    fallar(err); raise SystemExit

# Normalización defensiva: el wizard confía en la forma, no en el criterio del modelo.
CAPS_OK={"estilo","instagram","pauta","pantalla","web"}
d["capacidades_sugeridas"]=[c for c in (d.get("capacidades_sugeridas") or []) if c in CAPS_OK]
if d.get("web_modo") not in ("administrada","referencia"):
    d["web_modo"]="referencia"
if d.get("confianza") not in ("alta","media","baja"):
    d["confianza"]="media"
for k in ("nombre","slug","slogan","resumen","brief_md","estilo_md"):
    d[k]=(d.get(k) or "").strip()
if not isinstance(d.get("identidad"), dict): d["identidad"]={}
for k in ("hallazgos","fuentes","paleta","otras_redes"):
    if not isinstance(d.get(k), list): d[k]=[]

r=psql(f"UPDATE contenido.marca_descubrimiento SET estado='listo', resultado={dq(json.dumps(d, ensure_ascii=False))}::jsonb, "
       f"error=NULL, procesado_en=now() WHERE id='{did}';")
if r.returncode!=0:
    fallar("No se pudo guardar el análisis: "+(r.stderr or "").strip()[:300]); raise SystemExit
print("ok:"+(d.get("nombre") or "marca"))
PY

rm -f "/tmp/desc_ctx_$did.json" "/tmp/desc_res_$did.json" "/tmp/desc_web_$did.md" "$SHOT" "/tmp/desc_shot_$did.html"
echo "$(ts) fin descubrimiento $did" >> "$LOG"
