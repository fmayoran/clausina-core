#!/usr/bin/env bash
# Diseñar una versión de pieza gráfica: (fondo IA si corresponde) -> director de arte -> PDF+PNG.
# Itera sobre la versión anterior cuando hay instrucción de cambio. NO publica nada.
# Uso: grafica_gen_job.sh <negocio_slug> <version_id>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; vid="${2:-}"
{ [ -z "$slug" ] || [ -z "$vid" ]; } && { echo "uso: grafica_gen_job.sh <slug> <version_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/grafica_gen.log"
MEDIA_HOST="/var/lib/docker/volumes/clausina_panel_clausina-media/_data"
BASE_URL="https://panel.clausina.ar/media"
PG=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1"; }
fallar(){ psql "UPDATE contenido.grafica_version SET estado='error', error='$1', procesado_en=now() WHERE id='$vid';" >/dev/null; echo "$(ts) $vid ERROR: $1" >> "$LOG"; exit 1; }

exec 9>"/tmp/graf_${vid}.lock"; flock -n 9 || exit 0

estado=$(psql "SELECT estado FROM contenido.grafica_version WHERE id='$vid';")
case "$estado" in pendiente|procesando) ;; *) echo "$(ts) $vid sin estado procesable ($estado)" >> "$LOG"; exit 0;; esac
gid=$(psql "SELECT grafica_id FROM contenido.grafica_version WHERE id='$vid';")
[ -z "$gid" ] && exit 0
psql "UPDATE contenido.grafica_version SET estado='procesando' WHERE id='$vid';" >/dev/null
echo "$(ts) grafica $vid ($slug)" >> "$LOG"

DIRW="/tmp/graf_$vid"; rm -rf "$DIRW"; mkdir -p "$DIRW"

# 1) Fondo generado con IA, si la pieza lo pide y todavía no tiene uno.
modo=$(psql "SELECT fondo_modo FROM contenido.grafica WHERE id='$gid';")
fondo=$(psql "SELECT coalesce(fondo_url,'') FROM contenido.grafica WHERE id='$gid';")
if [ "$modo" = "generar" ] && [ -z "$fondo" ]; then
  echo "$(ts) generando fondo con IA" >> "$LOG"
  PROMPT_BG="Sos el BIBLIOTECARIO de ClaUsina. Leé $MOTOR/scripts/higgsfield/README.md. Generá UNA imagen de fondo para una pieza gráfica impresa del negocio '$slug'. El pedido y el estilo de marca están en /tmp/graf_ctx_$vid.json (campos 'fondo_prompt', 'mensaje', 'estilo_md', 'formato'). La imagen debe: ser apta como FONDO (sin texto, sin logos, composición con aire donde después irá el título), respetar la estética del estilo de marca, y usar la mayor resolución disponible. Guardala en $DIRW/fondo.jpg (o .png). No publiques nada, no toques la base."
  # el contexto se arma abajo, pero el fondo lo necesita: lo generamos después del contexto
fi

# 2) Contexto para el director de arte (formato, mensaje, estilo, datos, fondo, iteración).
PG="$PG" GID="$gid" VID="$vid" SLUG="$slug" DIRW="$DIRW" python3 - <<'PY' >> "$LOG" 2>&1
import json, os, subprocess
pg=os.environ["PG"]; gid=os.environ["GID"]; vid=os.environ["VID"]; dirw=os.environ["DIRW"]
def q(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True).stdout.strip()
g = json.loads(q(f"SELECT row_to_json(t) FROM (SELECT nombre, formato, ancho_mm, alto_mm, mensaje, "
                 f"fondo_modo, fondo_url, fondo_prompt, datos FROM contenido.grafica WHERE id='{gid}') t"))
neg = json.loads(q(f"SELECT row_to_json(t) FROM (SELECT n.nombre, n.slug, n.dominio_web, n.ig_handle, n.email, "
                   f"n.whatsapp, p.logo, p.slogan, p.estilo_md FROM contenido.negocios n "
                   f"LEFT JOIN contenido.negocio_perfil p ON p.negocio_id=n.id "
                   f"WHERE n.id=(SELECT negocio_id FROM contenido.grafica WHERE id='{gid}')) t"))
cont = q(f"SELECT coalesce(json_agg(json_build_object('nombre',nombre,'rol',rol,'whatsapp',whatsapp,'email',email)),'[]') "
         f"FROM contenido.negocio_contacto WHERE negocio_id=(SELECT negocio_id FROM contenido.grafica WHERE id='{gid}')")
ver = json.loads(q(f"SELECT row_to_json(t) FROM (SELECT nro, instruccion FROM contenido.grafica_version WHERE id='{vid}') t"))

# Sangre y zona de seguridad según el tamaño: los formatos grandes llevan más.
W=float(g["ancho_mm"]); H=float(g["alto_mm"]); grande = max(W,H) > 700
sangre = 10 if grande else 3
seguridad = (40 if grande else 8) + sangre

ctx = {
  "formato": g["formato"],
  "ancho_mm": round(W + 2*sangre, 2),      # medidas FINALES con sangre incluida
  "alto_mm":  round(H + 2*sangre, 2),
  "medida_final_mm": f"{W:g} x {H:g}",
  "sangre_mm": sangre, "seguridad_mm": seguridad,
  "gran_formato": grande,
  "mensaje": g.get("mensaje") or "",
  "datos": g.get("datos") or {},
  "fondo_prompt": g.get("fondo_prompt") or "",
  "negocio": {k: neg.get(k) for k in ("nombre","dominio_web","ig_handle","email","whatsapp","logo","slogan")},
  "estilo_md": neg.get("estilo_md") or "",
  "contactos": json.loads(cont or "[]"),
  "iteracion": ver.get("nro", 1) > 1,
  "instruccion": ver.get("instruccion") or "",
}
# Fondo ya elegido (biblioteca/subido) o el que generará la IA
if g.get("fondo_url"): ctx["fondo_url"] = g["fondo_url"]
json.dump(ctx, open(f"/tmp/graf_ctx_{vid}.json","w"), ensure_ascii=False)
print(f"ctx: {g['formato']} {ctx['ancho_mm']}x{ctx['alto_mm']}mm (sangre {sangre}) iter={ctx['iteracion']}")
PY
[ -s "/tmp/graf_ctx_$vid.json" ] || fallar "No se pudo armar el contexto de la pieza."

# 3) Fondo con IA (ahora que el contexto existe).
if [ "$modo" = "generar" ] && [ -z "$fondo" ]; then
  timeout 900 claude -p "$PROMPT_BG" --model sonnet --allowedTools Bash Read Write >> "$LOG" 2>&1
  BG=$(ls "$DIRW"/fondo.* 2>/dev/null | head -1)
  if [ -n "$BG" ] && [ -s "$BG" ]; then
    ext="${BG##*.}"; rel="grafica/$slug/fondo-$vid.$ext"
    mkdir -p "$MEDIA_HOST/grafica/$slug"; cp "$BG" "$MEDIA_HOST/$rel"
    url="$BASE_URL/$rel"
    psql "UPDATE contenido.grafica SET fondo_url='$url' WHERE id='$gid';" >/dev/null
    python3 - "$vid" "$url" <<'PY'
import json,sys
p=f"/tmp/graf_ctx_{sys.argv[1]}.json"; d=json.load(open(p)); d["fondo_url"]=sys.argv[2]
json.dump(d, open(p,"w"), ensure_ascii=False)
PY
    echo "$(ts) fondo generado: $url" >> "$LOG"
  else
    echo "$(ts) aviso: no se pudo generar el fondo, se diseña sin él" >> "$LOG"
  fi
fi

# 4) Si es iteración, pasarle el HTML de la versión anterior.
ANT=$(psql "SELECT coalesce(html_url,'') FROM contenido.grafica_version WHERE grafica_id='$gid' AND estado='lista' ORDER BY nro DESC LIMIT 1;")
PREV=""
if [ -n "$ANT" ]; then
  rel="${ANT#$BASE_URL/}"
  [ -f "$MEDIA_HOST/$rel" ] && { cp "$MEDIA_HOST/$rel" "$DIRW/anterior.html"; PREV=" La version anterior esta en $DIRW/anterior.html: PARTI DE ESE DISEÑO y aplica SOLO el cambio pedido."; }
fi

rm -f "/tmp/graf_res_$vid.html"
PROMPT="Sos el DIRECTOR DE ARTE de ClaUsina. Segui EXACTAMENTE $MOTOR/scripts/grafica_gen.md. El contexto (formato, medidas con sangre, mensaje, estilo_md del negocio, datos de contacto, fondo) esta en /tmp/graf_ctx_$vid.json. Si hay fondo_url, USALO como imagen de fondo.$PREV Escribi UNA sola pagina HTML autocontenida en /tmp/graf_res_$vid.html, a la medida exacta que indica el contexto. No toques la base, ni git, ni publiques nada."
timeout 900 claude -p "$PROMPT" --model sonnet --allowedTools Read Write >> "$LOG" 2>&1
[ -s "/tmp/graf_res_$vid.html" ] || fallar "El director de arte no dejó un diseño. Suele ser un límite temporal de uso; probá de nuevo."

# 5) Render: PDF (imprenta) + PNG (preview).
W=$(python3 -c "import json;print(json.load(open('/tmp/graf_ctx_$vid.json'))['ancho_mm'])")
H=$(python3 -c "import json;print(json.load(open('/tmp/graf_ctx_$vid.json'))['alto_mm'])")
nro=$(psql "SELECT nro FROM contenido.grafica_version WHERE id='$vid';")
num=$(printf "G-%04d" "$(psql "SELECT numero FROM contenido.grafica WHERE id='$gid';")")
stamp=$(date +%Y%m%d%H%M%S)
dir="$MEDIA_HOST/grafica/$slug"; rel="grafica/$slug"
mkdir -p "$dir"
base="${num}-v${nro}-$stamp"
cp "/tmp/graf_res_$vid.html" "$dir/$base.html"
if ! node "$MOTOR/scripts/grafica_render.js" "$dir/$base.html" "$dir/$base.pdf" "$dir/$base.png" "$W" "$H" >> "$LOG" 2>&1; then
  fallar "No se pudo renderizar la pieza (PDF/PNG)."
fi

psql "UPDATE contenido.grafica_version SET estado='lista', error=NULL, procesado_en=now(),
        html_url='$BASE_URL/$rel/$base.html', pdf_url='$BASE_URL/$rel/$base.pdf', png_url='$BASE_URL/$rel/$base.png'
      WHERE id='$vid';" >/dev/null
psql "UPDATE contenido.grafica SET version_actual=$nro, estado='lista', actualizado_en=now() WHERE id='$gid';" >/dev/null
echo "$(ts) grafica $vid lista (v$nro)" >> "$LOG"
rm -rf "$DIRW" "/tmp/graf_ctx_$vid.json" "/tmp/graf_res_$vid.html"
