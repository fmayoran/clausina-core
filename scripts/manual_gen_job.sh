#!/usr/bin/env bash
# Generar el manual de marca: el diseñador editorial convierte el estilo_md en un HTML autocontenido,
# que se guarda en el media store (online) y se renderiza a PDF. Guarda las URLs en el perfil.
# NO publica, NO toca git. Uso: manual_gen_job.sh <slug> <gen_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; gid="${2:-}"
{ [ -z "$slug" ] || [ -z "$gid" ]; } && { echo "uso: manual_gen_job.sh <slug> <gen_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/manual_gen.log"
MEDIA_HOST="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
BASE_URL="https://panel.clausina.ar/media"
PG=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1"; }

exec 9>"/tmp/manual_${gid}.lock"; flock -n 9 || exit 0

estado=$(psql "SELECT estado FROM contenido.negocio_gen WHERE id='$gid' AND tipo='manual';")
case "$estado" in pendiente|procesando) ;; *) echo "$(ts) $gid sin estado procesable ($estado)" >> "$LOG"; exit 0;; esac
pid=$(psql "SELECT negocio_id FROM contenido.negocio_gen WHERE id='$gid';")
[ -z "$pid" ] && exit 0

echo "$(ts) manual $gid ($slug)" >> "$LOG"
psql "UPDATE contenido.negocio_gen SET estado='procesando' WHERE id='$gid';" >/dev/null
rm -f "/tmp/manual_res_$gid.html"

# Versión y fecha para control: cada manual generado incrementa la versión de la marca.
ver=$(( $(psql "SELECT coalesce(manual_version,0) FROM contenido.negocio_perfil WHERE negocio_id='$pid';") + 1 ))
fecha=$(date +%d/%m/%Y)

# Contexto: nombre, slogan, brief, estilo_md, logo, paleta.
PG="$PG" PID="$pid" GID="$gid" VER="v$ver" FECHA="$fecha" python3 - <<'PY'
import json, os, subprocess
pg=os.environ["PG"]; pid=os.environ["PID"]; gid=os.environ["GID"]
def q(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True).stdout.strip()
row=q("SELECT coalesce(p.nombre,'')||E'\\n---S---\\n'||coalesce(pp.slogan,'')||E'\\n---L---\\n'||coalesce(pp.logo,'')"
      "||E'\\n---B---\\n'||coalesce(pp.brief_md,'')||E'\\n---E---\\n'||coalesce(pp.estilo_md,'') "
      f"FROM contenido.negocios p JOIN contenido.negocio_perfil pp ON pp.negocio_id=p.id WHERE p.id='{pid}'")
nombre, _, r1 = row.partition('\n---S---\n')
slogan, _, r2 = r1.partition('\n---L---\n')
logo,   _, r3 = r2.partition('\n---B---\n')
brief,  _, estilo = r3.partition('\n---E---\n')
json.dump({"nombre":nombre.strip(),"slogan":slogan.strip(),"logo":logo.strip(),
           "brief":brief.strip(),"estilo_md":estilo.strip(),
           "version":os.environ.get("VER",""),"fecha":os.environ.get("FECHA","")},
          open(f"/tmp/manual_ctx_{gid}.json","w"), ensure_ascii=False)
print("estilo_len="+str(len(estilo.strip())))
PY

PROMPT="Sos el DISEÑADOR EDITORIAL de ClaUsina. Segui EXACTAMENTE $MOTOR/scripts/manual_gen.md. El contexto (nombre, slogan, brief, estilo_md, logo, paleta) esta en /tmp/manual_ctx_$gid.json. Escribi UNA sola pagina HTML autocontenida en /tmp/manual_res_$gid.html, aplicando la identidad de la marca al propio manual. No toques la base, ni git, ni publiques nada."
timeout 900 claude -p "$PROMPT" --model sonnet --allowedTools Read Write >> "$LOG" 2>&1

# Versión y fecha: los reemplazamos nosotros (control). Placeholders si el modelo cooperó; si no,
# un sello fijo antes de </body> garantiza que la info de control SIEMPRE esté.
if [ -s "/tmp/manual_res_$gid.html" ]; then
  VER="v$ver" FECHA="$fecha" python3 - "$gid" <<'PY'
import os, re, sys
gid=sys.argv[1]; ver=os.environ["VER"]; fecha=os.environ["FECHA"]
p=f"/tmp/manual_res_{gid}.html"; h=open(p, encoding="utf-8").read()
tuvo = "{{VERSION}}" in h or "{{FECHA}}" in h
h = h.replace("{{VERSION}}", ver).replace("{{FECHA}}", fecha)
if not tuvo:  # el modelo no puso los placeholders: sello fijo, discreto, visible también en PDF
    sello=(f'<div style="position:fixed;bottom:8mm;right:10mm;font:600 9px/1 monospace;'
           f'letter-spacing:.08em;color:#888;opacity:.85;z-index:9999">{ver} · {fecha}</div>')
    h = re.sub(r"</body>", sello + "</body>", h, count=1, flags=re.I) if "</body>" in h.lower() else h+sello
open(p,"w",encoding="utf-8").write(h)
PY
fi

if [ ! -s "/tmp/manual_res_$gid.html" ] || grep -q "^SIN_ESTILO" "/tmp/manual_res_$gid.html" 2>/dev/null; then
  # Causa más común de "sin resultado": límite temporal de uso de la suscripción (claude -p).
  msg="El creativo no pudo generar el manual. Suele ser un límite temporal de uso; probá de nuevo en unos minutos."
  grep -qi "session limit\|usage limit\|rate limit" "$LOG" 2>/dev/null && msg="Se alcanzó el límite de uso de la suscripción. Reintentá cuando se reinicie."
  psql "UPDATE contenido.negocio_gen SET estado='error', error='$msg', procesado_en=now() WHERE id='$gid';" >/dev/null
  echo "$(ts) manual $gid sin resultado" >> "$LOG"
  rm -f "/tmp/manual_ctx_$gid.json" "/tmp/manual_res_$gid.html"; exit 1
fi

# Publicar: HTML + PDF en el media store, con timestamp (anti-cache) para que la URL nueva pise.
stamp=$(date +%Y%m%d%H%M%S)
dir="$MEDIA_HOST/manual/$slug"
rel="manual/$slug"
mkdir -p "$dir"
cp "/tmp/manual_res_$gid.html" "$dir/manual-$stamp.html"
pdf_ok=0
if node "$MOTOR/scripts/manual_pdf.js" "$dir/manual-$stamp.html" "$dir/manual-$stamp.pdf" >> "$LOG" 2>&1; then
  [ -s "$dir/manual-$stamp.pdf" ] && pdf_ok=1
fi

HTML_URL="$BASE_URL/$rel/manual-$stamp.html"
PDF_URL="$BASE_URL/$rel/manual-$stamp.pdf"
PG="$PG" PID="$pid" GID="$gid" HTMLU="$HTML_URL" PDFU="$PDF_URL" POK="$pdf_ok" VER="$ver" python3 - <<'PY'
import os, secrets, subprocess
pg=os.environ["PG"]; pid=os.environ["PID"]; gid=os.environ["GID"]
htmlu=os.environ["HTMLU"]; pdfu=os.environ["PDFU"] if os.environ["POK"]=="1" else None
def psql(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],capture_output=True,text=True)
def dq(v):
    t="x"+secrets.token_hex(8); return "NULL" if v is None else f"${t}${v}${t}$"
psql(f"UPDATE contenido.negocio_perfil SET manual_html_url={dq(htmlu)}, manual_pdf_url={dq(pdfu)}, manual_version={int(os.environ['VER'])}, manual_generado_en=now() WHERE negocio_id='{pid}';")
psql(f"UPDATE contenido.negocio_gen SET estado='listo', error=NULL, procesado_en=now() WHERE id='{gid}';")
print("ok")
PY

echo "$(ts) manual $gid listo (pdf=$pdf_ok)" >> "$LOG"
rm -f "/tmp/manual_ctx_$gid.json" "/tmp/manual_res_$gid.html"
