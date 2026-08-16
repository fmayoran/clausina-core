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
psql "UPDATE contenido.grafica_version SET estado='procesando', iniciado_en=now() WHERE id='$vid';" >/dev/null
echo "$(ts) grafica $vid ($slug)" >> "$LOG"

DIRW="/tmp/graf_$vid"; rm -rf "$DIRW"; mkdir -p "$DIRW"

# ¿Es sólo un reencuadre? Se lee acá arriba porque cambia lo que hay que hacer: un reencuadre
# trabaja sobre el diseño ANTERIOR, que ya tiene su foto embebida. Generar una imagen nueva sería
# cambiarle justo la foto que se está encuadrando, y gastar créditos para tirarla.
AJUSTE=$(psql "SELECT coalesce(ajuste::text,'') FROM contenido.grafica_version WHERE id='$vid';")

# 1) Fondo generado con IA, si la pieza lo pide y todavía no tiene uno.
modo=$(psql "SELECT fondo_modo FROM contenido.grafica WHERE id='$gid';")
fondo=$(psql "SELECT coalesce(fondo_url,'') FROM contenido.grafica WHERE id='$gid';")
modo_d=$(psql "SELECT coalesce(fondo_dorso_modo,'') FROM contenido.grafica WHERE id='$gid';")
fondo_d=$(psql "SELECT coalesce(fondo_dorso_url,'') FROM contenido.grafica WHERE id='$gid';")
# El fondo se genera DESPUES del contexto (lo necesita para leer el pedido y el estilo):
# aca solo se deja constancia de que hay que generarlo.
{ [ "$modo" = "generar" ] && [ -z "$fondo" ]; } && echo "$(ts) hay que generar el fondo del frente" >> "$LOG"
{ [ "$modo_d" = "generar" ] && [ -z "$fondo_d" ]; } && echo "$(ts) hay que generar el fondo del dorso" >> "$LOG"

# 2) Contexto para el director de arte (formato, mensaje, estilo, datos, fondo, iteración).
PG="$PG" GID="$gid" VID="$vid" SLUG="$slug" DIRW="$DIRW" python3 - <<'PY' >> "$LOG" 2>&1
import json, os, subprocess
pg=os.environ["PG"]; gid=os.environ["GID"]; vid=os.environ["VID"]; dirw=os.environ["DIRW"]
def q(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True).stdout.strip()
g = json.loads(q(f"SELECT row_to_json(t) FROM (SELECT nombre, formato, ancho_mm, alto_mm, mensaje, "
                 f"mensaje_dorso, caras, fondo_modo, fondo_url, fondo_prompt, datos "
                 f"FROM contenido.grafica WHERE id='{gid}') t"))
neg = json.loads(q(f"SELECT row_to_json(t) FROM (SELECT n.nombre, n.slug, n.dominio_web, n.ig_handle, n.email, "
                   f"n.whatsapp, p.logo, p.logo_claro, p.slogan, p.estilo_md FROM contenido.negocios n "
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
  "caras": int(g.get("caras") or 1),
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
if g.get("fondo_dorso_url"): ctx["fondo_dorso_url"] = g["fondo_dorso_url"]
if g.get("fondo_dorso_prompt"): ctx["fondo_dorso_prompt"] = g["fondo_dorso_prompt"]
json.dump(ctx, open(f"/tmp/graf_ctx_{vid}.json","w"), ensure_ascii=False)
print(f"ctx: {g['formato']} {ctx['ancho_mm']}x{ctx['alto_mm']}mm (sangre {sangre}) iter={ctx['iteracion']}")
PY
[ -s "/tmp/graf_ctx_$vid.json" ] || fallar "No se pudo armar el contexto de la pieza."

# 3) Fondo con IA (ahora que el contexto existe). Puede haber dos: el de cada cara.
#    Una funcion y no dos copias: el prompt y el manejo del archivo son identicos, y solo cambia
#    de que campo del contexto sale el pedido y en cual se deja la URL.
generar_fondo(){   # $1 = frente|dorso
  local cara="$1" campo_prompt campo_url base
  if [ "$cara" = "dorso" ]; then campo_prompt="fondo_dorso_prompt"; campo_url="fondo_dorso_url"; base="fondo-dorso";
  else campo_prompt="fondo_prompt"; campo_url="fondo_url"; base="fondo"; fi
  local P="Sos el BIBLIOTECARIO de ClaUsina. Lee $MOTOR/scripts/higgsfield/README.md. Genera UNA imagen de fondo para el $cara de una pieza grafica impresa del negocio '$slug'. El pedido y el estilo de marca estan en /tmp/graf_ctx_$vid.json (campos '$campo_prompt', 'mensaje', 'mensaje_dorso', 'estilo_md', 'formato'). La imagen debe: ser apta como FONDO (sin texto, sin logos, composicion con aire donde despues ira el titulo), respetar la estetica del estilo de marca, y usar la mayor resolucion disponible. Guardala en $DIRW/$base.jpg (o .png). No publiques nada, no toques la base."
  timeout 900 claude -p "$P" --model sonnet --allowedTools Bash Read Write >> "$LOG" 2>&1
  local BG ext rel url
  BG=$(ls "$DIRW/$base".* 2>/dev/null | head -1)
  if [ -n "$BG" ] && [ -s "$BG" ]; then
    ext="${BG##*.}"; rel="grafica/$slug/$base-$vid.$ext"
    mkdir -p "$MEDIA_HOST/grafica/$slug"; cp "$BG" "$MEDIA_HOST/$rel"
    url="$BASE_URL/$rel"
    psql "UPDATE contenido.grafica SET $campo_url='$url' WHERE id='$gid';" >/dev/null
    # Comillas simples adentro: el snippet va entre comillas simples de bash, y escapar comillas
    # dobles ahí produce una barra literal que Python rechaza.
    CTXV="$vid" CAMPO="$campo_url" URLV="$url" python3 -c 'import json,os
p = "/tmp/graf_ctx_" + os.environ["CTXV"] + ".json"
d = json.load(open(p)); d[os.environ["CAMPO"]] = os.environ["URLV"]
json.dump(d, open(p,"w"), ensure_ascii=False)'
    echo "$(ts) fondo de $cara generado: $url" >> "$LOG"
  else
    echo "$(ts) aviso: no se pudo generar el fondo de $cara, se disena sin el" >> "$LOG"
  fi
}
if [ -z "$AJUSTE" ]; then
  [ "$modo" = "generar" ] && [ -z "$fondo" ] && generar_fondo frente
  [ "$modo_d" = "generar" ] && [ -z "$fondo_d" ] && generar_fondo dorso
fi

# 4) Si es iteración, pasarle el HTML de la versión anterior.
ANT=$(psql "SELECT coalesce(html_url,'') FROM contenido.grafica_version WHERE grafica_id='$gid' AND estado='lista' ORDER BY nro DESC LIMIT 1;")
PREV=""
if [ -n "$ANT" ]; then
  rel="${ANT#$BASE_URL/}"
  [ -f "$MEDIA_HOST/$rel" ] && { cp "$MEDIA_HOST/$rel" "$DIRW/anterior.html"; PREV=" La version anterior esta en $DIRW/anterior.html: PARTI DE ESE DISEÑO y aplica SOLO el cambio pedido. Lo que el pedido no menciona queda IDENTICO, incluida la cara que no se toca."; }
# Con dos caras hay que recordarlo con el HTML anterior delante: iterando sobre una pieza de
# frente y dorso, el diseño volvia con UNA sola .lienzo y el dorso desaparecia sin aviso.
[ "$(python3 -c "import json;print(json.load(open('/tmp/graf_ctx_$vid.json'))['caras'])")" = "2" ] &&
  PREV="$PREV La pieza tiene DOS caras: el HTML tiene que salir con las DOS .lienzo, siempre, aunque el cambio sea de una sola." 
fi

rm -f "/tmp/graf_res_$vid.html"

# ── Atajo: si la versión sólo pide reencuadrar la foto, no hace falta el director de arte ──────
# Es una propiedad de CSS. Pedírsela a un modelo cuesta minutos, gasta cupo de sesión y a veces no
# acierta: en G-0003 hicieron falta ocho versiones para mover una foto, y dos murieron sin cupo.
if [ -n "$AJUSTE" ]; then
  [ -f "$DIRW/anterior.html" ] || fallar "No hay un diseño anterior para ajustar."
  # Dos ajustes determinísticos, los dos sin director de arte: reencuadrar la foto de una cara, o
  # cambiar el tamaño de la pieza entera. El segundo se reconoce por la marca 'reformato'.
  if echo "$AJUSTE" | grep -q '"reformato"'; then
    # Un reformato parte del diseño COMO FUE DIBUJADO, no de una copia ya escalada: encadenar
    # escalas apila CSS y multiplica errores. Se busca la última versión que no sea, ella misma,
    # un reformato. Los reencuadres sí valen como base: no tocan el tamaño.
    BASE=$(psql "SELECT coalesce(html_url,'') FROM contenido.grafica_version
                  WHERE grafica_id='$gid' AND estado='lista' AND html_url IS NOT NULL
                    AND (ajuste IS NULL OR ajuste->'reformato' IS NULL)
                  ORDER BY nro DESC LIMIT 1;")
    if [ -n "$BASE" ]; then
      relb="${BASE#$BASE_URL/}"
      [ -f "$MEDIA_HOST/$relb" ] && cp "$MEDIA_HOST/$relb" "$DIRW/anterior.html"
      echo "$(ts) reformato desde $BASE" >> "$LOG"
    fi
    RE=$(node "$MOTOR/scripts/grafica_reformato.js" "$DIRW/anterior.html" "/tmp/graf_res_$vid.html" \
         "$(python3 -c "import json;print(json.load(open('/tmp/graf_ctx_$vid.json'))['ancho_mm'])")" \
         "$(python3 -c "import json;print(json.load(open('/tmp/graf_ctx_$vid.json'))['alto_mm'])")" </dev/null)
    echo "$(ts) reformato: $RE" >> "$LOG"
    echo "$RE" | grep -q '"ok":true' || fallar "No se pudo cambiar el tamaño de la pieza."
  else
    RE=$(node "$MOTOR/scripts/grafica_encuadre.js" "$DIRW/anterior.html" "/tmp/graf_res_$vid.html" "$AJUSTE" </dev/null)
    echo "$(ts) encuadre: $RE" >> "$LOG"
    echo "$RE" | grep -q '"ok":true' || fallar "No se pudo reencuadrar esa cara."
  fi
else

PROMPT="Sos el DIRECTOR DE ARTE de ClaUsina. Segui EXACTAMENTE $MOTOR/scripts/grafica_gen.md. El contexto (formato, medidas con sangre, mensaje, estilo_md del negocio, datos de contacto, fondo) esta en /tmp/graf_ctx_$vid.json. Si hay fondo_url, USALO como imagen de fondo.$PREV Escribi UNA sola pagina HTML autocontenida en /tmp/graf_res_$vid.html, a la medida exacta que indica el contexto. No toques la base, ni git, ni publiques nada."
timeout 900 claude -p "$PROMPT" --model sonnet --allowedTools Read Write >> "$LOG" 2>&1
fi
[ -s "/tmp/graf_res_$vid.html" ] || fallar "El director de arte no dejó un diseño. Suele ser un límite temporal de uso; probá de nuevo."

# 4b) QR: si la pieza lo pidió, lo generamos y lo metemos en el hueco que dejó el diseño.
QRES=$(python3 "$MOTOR/scripts/grafica_qr.py" "/tmp/graf_res_$vid.html" "/tmp/graf_ctx_$vid.json" 2>&1)
echo "$(ts) qr: $QRES" >> "$LOG"
echo "$QRES" | grep -q '"ok": *false' && echo "$(ts) AVISO: el QR no se pudo insertar" >> "$LOG"

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
RJSON=$(node "$MOTOR/scripts/grafica_render.js" "$dir/$base.html" "$dir/$base.pdf" "$dir/$base.png" "$W" "$H" 2>>"$LOG")
echo "$RJSON" >> "$LOG"
echo "$RJSON" | grep -q '"ok":true' || fallar "No se pudo renderizar la pieza (PDF/PNG)."
# Guarda: una pieza de dos caras que vuelve con una es una cara perdida, no una versión nueva.
# Guardarla igual deja la pieza mutilada y nadie se entera hasta mandarla a imprimir.
CARAS_PIDE=$(python3 -c "import json;print(json.load(open('/tmp/graf_ctx_$vid.json'))['caras'])")
CARAS_HAY=$(echo "$RJSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('caras',0))")
[ "$CARAS_PIDE" = "2" ] && [ "$CARAS_HAY" != "2" ] &&
  fallar "El diseño volvió con una sola cara y la pieza tiene dos. No se guardó para no perder el dorso; probá de nuevo."
# Dorso: el renderer lo escribe como <base>-dorso.png si la pieza tiene 2 caras.
DORSO_SQL="png_dorso_url=NULL"
if [ -s "$dir/$base-dorso.png" ]; then DORSO_SQL="png_dorso_url='$BASE_URL/$rel/$base-dorso.png'"; fi
# La copia liviana para la pantalla; si no salió, la grilla cae al PNG grande.
PREV_SQL="png_prev_url=NULL"
if [ -s "$dir/$base-prev.jpg" ]; then PREV_SQL="png_prev_url='$BASE_URL/$rel/$base-prev.jpg'"; fi

psql "UPDATE contenido.grafica_version SET estado='lista', error=NULL, procesado_en=now(),
        html_url='$BASE_URL/$rel/$base.html', pdf_url='$BASE_URL/$rel/$base.pdf',
        png_url='$BASE_URL/$rel/$base.png', $DORSO_SQL, $PREV_SQL
      WHERE id='$vid';" >/dev/null
psql "UPDATE contenido.grafica SET version_actual=$nro, estado='lista', actualizado_en=now() WHERE id='$gid';" >/dev/null
echo "$(ts) grafica $vid lista (v$nro)" >> "$LOG"
rm -rf "$DIRW" "/tmp/graf_ctx_$vid.json" "/tmp/graf_res_$vid.html"
