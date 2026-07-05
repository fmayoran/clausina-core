#!/usr/bin/env bash
# Bibliotecario: procesa UNA solicitud de asset. El creativo genera/edita imagen o video
# con el contexto de marca (Higgsfield/ffmpeg) y deja el resultado en el media store
# (biblioteca/<slug>/). NO publica, NO toca landing/base/git. Lo invoca el worker.
# Uso: bibliotecario_job.sh <slug> <solicitud_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; sid="${2:-}"
{ [ -z "$slug" ] || [ -z "$sid" ]; } && { echo "uso: bibliotecario_job.sh <slug> <solicitud_id>" >&2; exit 2; }

MARCAS="/root/clausina/marcas"
MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/bibliotecario.log"
HOST_MEDIA="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
CID=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }

exec 9>"/tmp/biblio_${sid}.lock"; flock -n 9 || exit 0

row=$(psql "SELECT row_to_json(t) FROM (SELECT id,instruccion,origen_url,origen_tipo,proyecto_id FROM contenido.solicitudes_biblioteca WHERE id='$sid' AND estado IN ('pendiente','procesando') LIMIT 1) t;")
[ -z "$row" ] && { echo "$(ts) solicitud $sid sin estado procesable" >> "$LOG"; exit 0; }

REPO="$MARCAS/$slug"
[ -d "$REPO" ] || { echo "$(ts) ERROR: cápsula inexistente $REPO" >> "$LOG"; psql "UPDATE contenido.solicitudes_biblioteca SET estado='error', procesado_en=now() WHERE id='$sid';" >/dev/null; exit 1; }
CHAT=$(psql "SELECT coalesce(telegram_chat_id,'') FROM contenido.proyectos WHERE slug='$slug';")
BOT=$(grep '^TELEGRAM_BOT_TOKEN=' "$REPO/$slug.env" 2>/dev/null | cut -d= -f2-)

instr=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('instruccion') or '')")
ourl=$(echo "$row"  | python3 -c "import sys,json;print(json.load(sys.stdin).get('origen_url') or '')")
otipo=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin).get('origen_tipo') or '')")

echo "$(ts) solicitud $sid ($slug): $instr" >> "$LOG"
psql "UPDATE contenido.solicitudes_biblioteca SET estado='procesando' WHERE id='$sid';" >/dev/null

# Descargar el asset fuente si es edición (/media -> disco directo; http -> curl).
origen=""
rm -f "/tmp/biblio_src_$sid".*
if [ -n "$ourl" ]; then
  ext="png"; [ "$otipo" = "video" ] && ext="mp4"
  origen="/tmp/biblio_src_$sid.$ext"
  if [[ "$ourl" == /media/* ]] && [ -f "$HOST_MEDIA/${ourl#/media/}" ]; then cp "$HOST_MEDIA/${ourl#/media/}" "$origen"
  else curl -s --max-time 180 "$ourl" -o "$origen" 2>/dev/null || origen=""; fi
  [ -s "$origen" ] || origen=""
fi

rm -f "/tmp/biblio_res_$sid.json"
IN="$instr" O="$origen" OT="$otipo" python3 -c "import json,os;json.dump({'instruccion':os.environ['IN'],'origen':os.environ['O'],'origen_tipo':os.environ['OT']},open('/tmp/biblio_ctx_$sid.json','w'),ensure_ascii=False)"

cd "$REPO" || exit 1
bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true
PROMPT="Sos el BIBLIOTECARIO del proyecto. Segui EXACTAMENTE $MOTOR/scripts/bibliotecario.md. El pedido y el asset fuente estan en /tmp/biblio_ctx_$sid.json. Escribi el resultado en /tmp/biblio_res_$sid.json como indica la skill. Es un ASSET de la biblioteca: NO publiques, NO toques Instagram/landing/base/git."
timeout 1500 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1

if [ ! -s "/tmp/biblio_res_$sid.json" ]; then
  echo "$(ts) ERROR: sin resultado $sid" >> "$LOG"
  psql "UPDATE contenido.solicitudes_biblioteca SET estado='error', procesado_en=now() WHERE id='$sid';" >/dev/null
  [ -n "$BOT" ] && curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=El bibliotecario no pudo completar el pedido. Proba reformulando." -o /dev/null 2>&1
  exit 1
fi

# Copiar el asset generado al media store + actualizar la solicitud (dollar-quoting seguro).
ok=$(CID="$CID" SID="$sid" SLUG="$slug" HOST_MEDIA="$HOST_MEDIA" python3 - <<'PY'
import json, os, secrets, subprocess, shutil, pathlib
sid=os.environ["SID"]; cid=os.environ["CID"]; slug=os.environ["SLUG"]; hm=os.environ["HOST_MEDIA"]
d=json.load(open(f"/tmp/biblio_res_{sid}.json"))
src=(d.get("path") or "").strip()
if not src or not os.path.isfile(src):
    print("0-nofile"); raise SystemExit
tipo=(d.get("tipo") or ("video" if src.lower().endswith((".mp4",".webm",".mov")) else "image")).strip()
resumen=(d.get("resumen") or "").strip()[:2000]
ext=(pathlib.Path(src).suffix.lower().lstrip(".")) or ("mp4" if tipo=="video" else "png")
rel=f"biblioteca/{slug}/{secrets.token_hex(12)}.{ext}"
dst=os.path.join(hm, rel)
os.makedirs(os.path.dirname(dst), exist_ok=True)
shutil.copyfile(src, dst); os.chmod(dst, 0o644)
t=secrets.token_hex(6)
sql=(f"UPDATE contenido.solicitudes_biblioteca SET estado='listo', resultado_path=${t}${rel}${t}$, "
     f"resultado_tipo='{tipo}', resumen=${t}b${resumen}${t}b$, procesado_en=now() WHERE id='{sid}';")
r=subprocess.run(["docker","exec","-i",cid,"psql","-U","postgres","-d","claude","-q","-c",sql],capture_output=True,text=True)
print("1" if not (r.stderr or "").strip() else "0-"+r.stderr.strip())
PY
)
if [[ "$ok" == 1* ]]; then
  echo "$(ts) listo $sid" >> "$LOG"
  [ -n "$BOT" ] && curl -s "https://api.telegram.org/bot$BOT/sendMessage" --data-urlencode "chat_id=$CHAT" --data-urlencode "text=El bibliotecario dejo un asset nuevo en la biblioteca. Miralo en https://panel.clausina.ar" -o /dev/null 2>&1
else
  echo "$(ts) ERROR aplicando resultado $sid: $ok" >> "$LOG"
  psql "UPDATE contenido.solicitudes_biblioteca SET estado='error', procesado_en=now() WHERE id='$sid';" >/dev/null
fi
rm -f "/tmp/biblio_ctx_$sid.json" "/tmp/biblio_res_$sid.json" "/tmp/biblio_src_$sid".*
echo "$(ts) fin solicitud $sid" >> "$LOG"
