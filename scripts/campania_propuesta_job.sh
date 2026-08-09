#!/usr/bin/env bash
# El creativo propone las acciones de una campaña — ClaUsina v2.0 / F7.
# Uso: campania_propuesta_job.sh <negocio_slug> <propuesta_id>
#
# NO crea nada: deja acciones sugeridas en la propuesta para que una persona acepte de a una.
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; pid="${2:-}"
{ [ -z "$slug" ] || [ -z "$pid" ]; } && { echo "uso: campania_propuesta_job.sh <slug> <propuesta_id>" >&2; exit 2; }

MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/campania_propuesta.log"
PG=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$PG" ] && { echo "sin contenedor de base" >&2; exit 1; }
ts(){ date -Is; }
psql(){ docker exec -i "$PG" psql -U postgres -d claude -t -A -q -c "$1"; }
fallar(){ psql "UPDATE contenido.campania_propuesta SET estado='error', error=left(\$e\$$1\$e\$,400), procesado_en=now() WHERE id='$pid';" >/dev/null; echo "$1" >&2; exit 1; }

exec 9>"/tmp/camp_prop_$pid.lock"; flock -n 9 || exit 0
estado=$(psql "SELECT estado FROM contenido.campania_propuesta WHERE id='$pid';")
case "$estado" in pendiente|procesando) ;; *) echo "$(ts) $pid sin estado procesable ($estado)" >> "$LOG"; exit 0;; esac
psql "UPDATE contenido.campania_propuesta SET estado='procesando', iniciado_en=now() WHERE id='$pid';" >/dev/null

DIRW="/tmp/camp_prop_$pid"; rm -rf "$DIRW"; mkdir -p "$DIRW"

# El contexto del negocio se regenera primero: la propuesta tiene que salir de la identidad
# actual, no de la que quedó de la última corrida.
python3 "$MOTOR/scripts/contexto_a_md.py" "$slug" >> "$LOG" 2>&1

# Todo lo que el creativo necesita saber, en un solo archivo: la campaña y lo que el negocio YA
# tiene para enganchar. Sin esto propondría cosas que no existen.
PG="$PG" PID="$pid" SLUG="$slug" DIRW="$DIRW" python3 - <<'PY' >> "$LOG" 2>&1
import json, os, subprocess
pg=os.environ["PG"]; pid=os.environ["PID"]; slug=os.environ["SLUG"]; dirw=os.environ["DIRW"]
def q(sql):
    return subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-t","-A","-q","-c",sql],
                          capture_output=True, text=True).stdout.strip()
camp = json.loads(q(f"""SELECT row_to_json(t) FROM (
  SELECT c.nombre, c.objetivo, c.objetivo_tipo, c.meta_valor, c.desde, c.hasta, c.publico,
         c.presupuesto, p.instruccion
    FROM contenido.campania_propuesta p JOIN contenido.campania c ON c.id=p.campania_id
   WHERE p.id='{pid}') t"""))
neg = q(f"SELECT id FROM contenido.negocios WHERE slug='{slug}'")
disponible = {
  "beneficios": json.loads(q(f"SELECT coalesce(json_agg(json_build_object('nombre',nombre,'tipo',tipo,'valor',valor,'condiciones',condiciones)),'[]') FROM contenido.beneficio WHERE negocio_id='{neg}' AND activo")),
  "piezas_graficas": json.loads(q(f"SELECT coalesce(json_agg(json_build_object('numero',numero,'nombre',nombre,'formato',formato)),'[]') FROM contenido.grafica WHERE negocio_id='{neg}' AND estado<>'descartada'")),
  "pantallas": json.loads(q(f"SELECT coalesce(json_agg(json_build_object('nombre',nombre)),'[]') FROM contenido.pantallas") or "[]"),
  "turnos": json.loads(q(f"SELECT coalesce(json_agg(json_build_object('nombre',coalesce(nombre_publico,nombre),'desde',to_char(hora_desde,'HH24:MI'),'dias',dias)),'[]') FROM contenido.turno WHERE negocio_id='{neg}' AND activo")),
  "capacidades": json.loads(q(f"SELECT coalesce(json_agg(capacidad),'[]') FROM contenido.negocio_capacidad WHERE negocio_id='{neg}' AND habilitada")),
}
# Si es una iteración, entra la propuesta anterior completa: el creativo tiene que PARTIR de
# ella y tocar sólo lo que se pidió, no rehacer el plan.
prev = q(f"""SELECT coalesce(row_to_json(t)::text,'') FROM (
  SELECT pa.resumen, pa.acciones, p.instruccion AS que_cambiar, p.sobre_accion
    FROM contenido.campania_propuesta p
    JOIN contenido.campania_propuesta pa ON pa.id = p.previa_id
   WHERE p.id='{pid}') t""")
salida = {"campania": camp, "el_negocio_ya_tiene": disponible}
if prev:
    salida["propuesta_anterior"] = json.loads(prev)
json.dump(salida, open(f"{dirw}/pedido.json","w"), ensure_ascii=False, indent=1, default=str)
PY
[ -s "$DIRW/pedido.json" ] || fallar "No se pudo armar el contexto de la campaña."

PROMPT="Sos el DIRECTOR CREATIVO de ClaUsina. Seguí tu skill (/root/.claude/skills/creativo/SKILL.md).

NEGOCIO ACTIVO: '$slug'. Leé su contexto ANTES de proponer nada:
  /root/clausina/marcas/$slug/contexto/CONTEXTO_MARCA.md
  /root/clausina/marcas/$slug/contexto/ESTILO.md
  /root/clausina/marcas/$slug/contexto/REFERENCIAS.md

La campaña y lo que el negocio YA tiene están en $DIRW/pedido.json.

TAREA: proponer las ACCIONES de esta campaña. Una acción es algo concreto y medible, dirigido a
UNO de los públicos que declara la campaña. No propongas una lista de piezas sueltas: proponé un
plan por público, con un orden y una razón.

SI EL PEDIDO TRAE 'propuesta_anterior': NO empieces de cero. Es una iteración:
- Partí de esas acciones y aplicá SÓLO lo que dice 'que_cambiar'.
- Lo que no se cuestionó se mantiene TAL CUAL, con el mismo nombre — así se ve qué cambió.
- Si 'sobre_accion' trae un número, el pedido es sobre esa acción (por su posición en la lista):
  cambiá esa y dejá el resto intacto.
- En el resumen, arrancá diciendo qué cambiaste respecto de la anterior y por qué.

REGLAS:
- Partí del objetivo, la meta, la ventana y el público de la campaña. Si la meta no es alcanzable
  con lo que proponés, decilo.
- Enganchá a lo que el negocio YA tiene cuando exista (beneficios, piezas gráficas). Si hace falta
  algo que no existe, proponelo igual y marcá que hay que crearlo.
- Cada acción tiene que ser MEDIBLE. Sin link propio ni código propio, sólo mide alcance: decilo.
- Respetá los turnos y la capacidad reales. No invites a un turno que no corre.
- Nada de fechas ni datos inventados: lo que no esté en el contexto, no existe.

SALIDA: escribí SOLO un JSON en $DIRW/resultado.json con esta forma exacta:
{
  \"resumen\": \"tu lectura de la campaña y el criterio del plan, en prosa, 2-3 párrafos\",
  \"acciones\": [
    {\"nombre\": \"...\",
     \"tipo\": \"invitaciones|instagram|pantalla|impreso|pauta|link|otra\",
     \"publico\": \"a cuál de los públicos de la campaña apunta\",
     \"por_que\": \"por qué esta acción para ese público\",
     \"como_se_mide\": \"qué se va a poder contar de esto\",
     \"enganche\": \"nombre exacto de lo que ya existe, o vacío si hay que crearlo\",
     \"hay_que_crear\": true|false,
     \"cuando\": \"en qué momento de la ventana\"}
  ]
}
Entre 4 y 8 acciones. No publiques nada, no toques la base, no crees piezas."

timeout 1500 claude -p "$PROMPT" --model sonnet --allowedTools Bash Read Write Glob Grep >> "$LOG" 2>&1

[ -s "$DIRW/resultado.json" ] || fallar "El creativo no dejó una propuesta. Probá de nuevo."

PID="$pid" PG="$PG" DIRW="$DIRW" python3 - <<'PY'
import json, os, secrets, subprocess
pid=os.environ["PID"]; pg=os.environ["PG"]; dirw=os.environ["DIRW"]
def dq(v):
    t="x"+secrets.token_hex(8); return f"${t}${v}${t}$"
try:
    d=json.load(open(f"{dirw}/resultado.json"))
except Exception as e:
    d=None
if not d or not isinstance(d.get("acciones"), list) or not d["acciones"]:
    sql=(f"UPDATE contenido.campania_propuesta SET estado='error', "
         f"error='La propuesta no tenía acciones utilizables.', procesado_en=now() WHERE id='{pid}';")
else:
    sql=(f"UPDATE contenido.campania_propuesta SET estado='lista', "
         f"resumen={dq(d.get('resumen') or '')}, acciones={dq(json.dumps(d['acciones'], ensure_ascii=False))}::jsonb, "
         f"procesado_en=now() WHERE id='{pid}';")
subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-q","-c",sql])
print("acciones propuestas:", len((d or {}).get("acciones") or []))
PY
echo "$(ts) propuesta $pid lista" >> "$LOG"
rm -rf "$DIRW"
