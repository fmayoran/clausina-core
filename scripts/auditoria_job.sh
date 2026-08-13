#!/usr/bin/env bash
# Auditoría integral de presencia digital de un negocio — ClaUsina.
# Uso: auditoria_job.sh <negocio_slug> <req_id>
#
# Tres pasos, en este orden:
#   1) Se MIDE. La web se audita contra el sitio vivo; Instagram, sobre la serie que ya tiene la
#      plataforma. Los números salen de scripts propios, no del modelo: un KPI inventado por una
#      IA es peor que no tenerlo.
#   2) Se COMPARA contra el benchmark, que viaja dentro del JSON y se muestra al lado del dato.
#   3) Recién ahí opina el creativo, y sólo sobre los números medidos, con la voz del negocio.
#
# Escribe una fila por canal en contenido.auditorias. No publica nada ni toca la cápsula.
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; rid="${2:-}"
{ [ -z "$slug" ] || [ -z "$rid" ]; } && { echo "uso: auditoria_job.sh <slug> <req_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/auditoria.log"
PG=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$PG" ] && { echo "sin contenedor de base" >&2; exit 1; }
ts(){ date -Is; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1" </dev/null; }
fallar(){ psql "UPDATE contenido.auditoria_req SET estado='error', error=left(\$e\$$1\$e\$,400), procesado_en=now() WHERE id='$rid';" >/dev/null; echo "$1" >&2; exit 1; }

exec 9>"/tmp/auditoria_$rid.lock"; flock -n 9 || exit 0
estado=$(psql "SELECT estado FROM contenido.auditoria_req WHERE id='$rid';")
case "$estado" in pendiente|procesando) ;; *) echo "$(ts) $rid sin estado procesable ($estado)" >> "$LOG"; exit 0;; esac
psql "UPDATE contenido.auditoria_req SET estado='procesando', iniciado_en=now() WHERE id='$rid';" >/dev/null

DIRW="/tmp/auditoria_$rid"; rm -rf "$DIRW"; mkdir -p "$DIRW"
neg=$(psql "SELECT id FROM contenido.negocios WHERE slug='$slug';")
[ -z "$neg" ] && fallar "No existe el negocio $slug."

# El contexto del negocio se regenera antes: las recomendaciones tienen que salir de la identidad
# actual, no de la que quedó de la última corrida.
python3 "$MOTOR/scripts/contexto_a_md.py" "$slug" >> "$LOG" 2>&1

# ── 1) Web ────────────────────────────────────────────────────────────────────────────────────
web=$(psql "SELECT coalesce(dominio_web,'') FROM contenido.negocios WHERE id='$neg';")
if [ -n "$web" ]; then
  python3 "$MOTOR/scripts/auditoria_web.py" "$web" > "$DIRW/web.json" 2>>"$LOG" || echo '{}' > "$DIRW/web.json"
else
  echo '{"error":"el negocio no tiene sitio cargado"}' > "$DIRW/web.json"
fi

# ── 2) Instagram ──────────────────────────────────────────────────────────────────────────────
# Los seguidores no están en la base: se piden a Meta si el negocio tiene la credencial cargada.
# Sin ese dato el engagement sobre seguidores no se puede calcular y se muestra vacío, que es lo
# honesto: estimarlo sobre el alcance daría un número que parece medido y no lo es.
igid=$(psql "SELECT coalesce(meta_ads_ig_id,'') FROM contenido.negocio_perfil WHERE negocio_id='$neg';")
SEG=""
if [ -n "$igid" ]; then
  tok=$(psql "SELECT coalesce(ig_token_enc,'') FROM contenido.negocio_perfil WHERE negocio_id='$neg';")
  if [ -n "$tok" ]; then
    tok=$(TOKEN_ENC="$tok" python3 -c "
import os,sys; sys.path.insert(0,'$MOTOR/scripts')
from ads_crypto import decrypt
try: print(decrypt(os.environ['TOKEN_ENC']))
except Exception: print('')" 2>>"$LOG")
    if [ -n "$tok" ]; then
      SEG=$(curl -s --max-time 20 "https://graph.facebook.com/v21.0/$igid?fields=followers_count&access_token=$tok" \
            | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('followers_count') or '')
except Exception: print('')" 2>/dev/null)
    fi
  fi
fi
IG_SEGUIDORES="$SEG" python3 "$MOTOR/scripts/auditoria_ig.py" "$slug" > "$DIRW/ig.json" 2>>"$LOG" || echo '{}' > "$DIRW/ig.json"

# ── 3) Las recomendaciones, del creativo y sobre los números medidos ──────────────────────────
PROMPT="Sos el DIRECTOR CREATIVO de ClaUsina. Seguí tu skill (/root/.claude/skills/creativo/SKILL.md).

NEGOCIO ACTIVO: '$slug'. Leé su contexto ANTES de escribir nada:
  /root/clausina/marcas/$slug/contexto/CONTEXTO_MARCA.md
  /root/clausina/marcas/$slug/contexto/ESTILO.md
  /root/clausina/marcas/$slug/contexto/REFERENCIAS.md

MEDICIONES YA HECHAS (no las recalcules, no las contradigas):
  Web:       $DIRW/web.json
  Instagram: $DIRW/ig.json
El bloque 'benchmark' del JSON de Instagram es la referencia contra la que se compara.

TAREA: escribir las recomendaciones de la auditoría, en dos archivos separados.

REGLAS:
- Partí del dato. Cada recomendación tiene que poder rastrearse a un número del JSON; si el
  número no está, decí que falta medirlo en vez de suponerlo.
- Comparar contra el benchmark explícitamente: por encima, en rango o por debajo.
- Accionable y priorizado: qué hacer primero y por qué. Nada de 'mejorar la presencia'.
- Si algo NO se puede medir hoy —seguidores, performance real, historias— decilo. Un hueco
  declarado vale más que un consejo apoyado en aire.
- Voz del negocio, sin emojis, español rioplatense.

SALIDA: dos archivos markdown, sin nada más.

$DIRW/reco_web.md — con estas secciones:
## Estado general
## A mejorar
## Nota

$DIRW/reco_ig.md — con estas secciones:
## Estado
## Lectura
## Recomendaciones

Usá '## ' para los títulos, '- ' para las listas y **negrita** para lo importante. Sin encabezado
h1, sin bloques de código. No publiques nada, no toques la base."

timeout 1500 claude -p "$PROMPT" --model sonnet --allowedTools Bash Read Write Glob Grep >> "$LOG" 2>&1

# ── Guardar ───────────────────────────────────────────────────────────────────────────────────
RID="$rid" NEG="$neg" PG="$PG" DIRW="$DIRW" python3 - <<'PY'
import json, os, secrets, subprocess
rid=os.environ["RID"]; neg=os.environ["NEG"]; pg=os.environ["PG"]; dirw=os.environ["DIRW"]
def dq(v):
    t="x"+secrets.token_hex(8); return f"${t}${v}${t}$"
def leer(p, d=None):
    try: return json.load(open(p))
    except Exception: return d
def texto(p):
    try: return open(p, encoding="utf-8").read().strip()
    except Exception: return ""

sql=[]; hechos=[]
web=leer(f"{dirw}/web.json") or {}
if web.get("score") is not None:
    sql.append(f"""INSERT INTO contenido.auditorias (negocio_id, canal, periodo, kpis, recomendaciones)
      VALUES ('{neg}','web','hoy',{dq(json.dumps(web, ensure_ascii=False))}::jsonb,{dq(texto(f'{dirw}/reco_web.md'))});""")
    hechos.append(f"web {web['score']}/100")

ig=leer(f"{dirw}/ig.json") or {}
if ig.get("global"):
    sql.append(f"""INSERT INTO contenido.auditorias (negocio_id, canal, periodo, kpis, recomendaciones)
      VALUES ('{neg}','instagram',{dq(ig.get('periodo') or 'histórico')},{dq(json.dumps(ig, ensure_ascii=False))}::jsonb,{dq(texto(f'{dirw}/reco_ig.md'))});""")
    hechos.append(f"instagram {ig['global']['posts']} posts")

if not sql:
    resumen = "No había nada para auditar: el negocio no tiene sitio cargado ni publicaciones con métricas."
    sql=[f"UPDATE contenido.auditoria_req SET estado='error', error={dq(resumen)}, procesado_en=now() WHERE id='{rid}';"]
else:
    sql.append(f"UPDATE contenido.auditoria_req SET estado='lista', resumen={dq(' · '.join(hechos))}, procesado_en=now() WHERE id='{rid}';")

subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-q","-c","\n".join(sql)],
               stdin=subprocess.DEVNULL)
print("auditoría:", " · ".join(hechos) or "sin datos")
PY

echo "$(ts) auditoria $rid ($slug) terminada" >> "$LOG"
rm -rf "$DIRW"
