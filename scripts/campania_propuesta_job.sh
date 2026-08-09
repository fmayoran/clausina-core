#!/usr/bin/env bash
# El creativo trabaja una campaña — ClaUsina v2.0 / F7.
# Uso: campania_propuesta_job.sh <negocio_slug> <propuesta_id>
#
# Dos fases, según la columna 'fase' de la propuesta:
#   plan     → escribe el plan en prosa. Sin acciones: primero se acuerda la estrategia.
#   acciones → baja a acciones concretas el plan que el negocio YA aprobó (editado o no).
# NO crea nada en la campaña: deja el resultado en la propuesta y el panel lo baja a borradores.
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
fase=$(psql "SELECT fase FROM contenido.campania_propuesta WHERE id='$pid';")

DIRW="/tmp/camp_prop_$pid"; rm -rf "$DIRW"; mkdir -p "$DIRW"

# El contexto del negocio se regenera primero: la propuesta tiene que salir de la identidad
# actual, no de la que quedó de la última corrida.
python3 "$MOTOR/scripts/contexto_a_md.py" "$slug" >> "$LOG" 2>&1

# Todo lo que el creativo necesita saber, en un solo archivo: la campaña y lo que el negocio YA
# tiene para enganchar. Sin esto propondría cosas que no existen.
PG="$PG" PID="$pid" SLUG="$slug" DIRW="$DIRW" FASE="$fase" python3 - <<'PY' >> "$LOG" 2>&1
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
# En fase de acciones el enunciado es el plan aprobado, y sólo ese: mandarle además la fila
# anterior completa es repetirle lo mismo dos veces con otro nombre.
prev = "" if os.environ.get("FASE") == "acciones" else q(f"""SELECT coalesce(row_to_json(t)::text,'') FROM (
  SELECT pa.resumen, pa.acciones, p.instruccion AS que_cambiar, p.sobre_accion
    FROM contenido.campania_propuesta p
    JOIN contenido.campania_propuesta pa ON pa.id = p.previa_id
   WHERE p.id='{pid}') t""")
salida = {"campania": camp, "el_negocio_ya_tiene": disponible}
plan = q(f"SELECT coalesce(resumen,'') FROM contenido.campania_propuesta WHERE id='{pid}' AND fase='acciones'")
if plan:
    salida["plan_aprobado"] = plan
if prev:
    salida["propuesta_anterior"] = json.loads(prev)
json.dump(salida, open(f"{dirw}/pedido.json","w"), ensure_ascii=False, indent=1, default=str)
PY
[ -s "$DIRW/pedido.json" ] || fallar "No se pudo armar el contexto de la campaña."

COMUN="Sos el DIRECTOR CREATIVO de ClaUsina. Seguí tu skill (/root/.claude/skills/creativo/SKILL.md).

NEGOCIO ACTIVO: '$slug'. Leé su contexto ANTES de escribir nada:
  /root/clausina/marcas/$slug/contexto/CONTEXTO_MARCA.md
  /root/clausina/marcas/$slug/contexto/ESTILO.md
  /root/clausina/marcas/$slug/contexto/REFERENCIAS.md

La campaña y lo que el negocio YA tiene están en $DIRW/pedido.json."

if [ "$fase" = "acciones" ]; then
  # Segunda fase: el plan ya está acordado (y puede haberlo editado el negocio). Las acciones
  # salen de ESE texto, no de lo que el creativo hubiera propuesto por su cuenta.
  PROMPT="$COMUN

En 'plan_aprobado' está el plan que el negocio APROBÓ. Puede estar editado por ellos: es la
decisión tomada y no se discute.

TAREA: bajar ese plan a ACCIONES concretas. Cada acción es algo que alguien hace, dirigido a UNO
de los públicos de la campaña, y medible.

REGLAS:
- Salí del plan aprobado. No agregues acciones que el plan no menciona ni saques las que sí.
- Enganchá a lo que el negocio YA tiene (beneficios, piezas gráficas). Si hace falta algo que no
  existe, proponelo y marcá que hay que crearlo.
- Cada acción tiene que ser MEDIBLE. Sin link ni código propio, sólo mide alcance: decilo.
- Respetá los turnos, la capacidad y la ventana reales. Nada inventado.

SALIDA: escribí SOLO un JSON en $DIRW/resultado.json:
{
  \"resumen\": \"una línea diciendo cómo bajaste el plan a acciones\",
  \"acciones\": [
    {\"nombre\": \"...\", \"tipo\": \"invitaciones|instagram|pantalla|impreso|pauta|link|otra\",
     \"publico\": \"...\", \"por_que\": \"...\", \"como_se_mide\": \"...\",
     \"enganche\": \"nombre exacto de lo que ya existe, o vacío\",
     \"hay_que_crear\": true|false, \"cuando\": \"...\"}
  ]
}
Entre 4 y 8 acciones. No publiques nada, no toques la base."
else
  # Primera fase: el PLAN en prosa. Sin acciones: primero se acuerda la estrategia.
  PROMPT="$COMUN

TAREA: escribir el PLAN de esta campaña, en prosa. Todavía NO son acciones: es el criterio con
el que se va a atacar el objetivo, para que el negocio lo lea, lo corrija y lo apruebe.

Tiene que decir:
- Cómo leés la campaña: el objetivo, la ventana, y si la meta es alcanzable con lo que hay
  (capacidad, turnos, ticket). Si no lo es, decilo.
- Cómo se ordena el trabajo por PÚBLICO: qué le hablás a cada uno y por qué a ese y no a otro.
- Qué se puede medir y qué no. Decilo explícito: un embudo con huecos honestos vale más que uno
  completo e inventado.
- Qué de lo que el negocio ya tiene encaja, y qué falta crear.

SI EL PEDIDO TRAE 'propuesta_anterior': es una iteración. Partí de ese plan y aplicá SÓLO lo que
dice 'que_cambiar'; lo demás se mantiene. Arrancá diciendo qué cambiaste y por qué.

SALIDA: escribí SOLO un JSON en $DIRW/resultado.json:
{ \"resumen\": \"el plan, en prosa, 3 a 5 párrafos\", \"acciones\": [] }
No propongas acciones todavía. No publiques nada, no toques la base."
fi

timeout 1500 claude -p "$PROMPT" --model sonnet --allowedTools Bash Read Write Glob Grep >> "$LOG" 2>&1

[ -s "$DIRW/resultado.json" ] || fallar "El creativo no dejó una propuesta. Probá de nuevo."

PID="$pid" PG="$PG" DIRW="$DIRW" FASE="$fase" python3 - <<'PY'
import json, os, secrets, subprocess
pid=os.environ["PID"]; pg=os.environ["PG"]; dirw=os.environ["DIRW"]
def dq(v):
    t="x"+secrets.token_hex(8); return f"${t}${v}${t}$"
try:
    d=json.load(open(f"{dirw}/resultado.json"))
except Exception as e:
    d=None
fase = os.environ.get("FASE") or "plan"
if fase == "acciones":
    ok = bool(d) and isinstance(d.get("acciones"), list) and d["acciones"]
    falta = "El creativo no bajó el plan a acciones."
else:
    ok = bool(d) and (d.get("resumen") or "").strip()
    falta = "El creativo no dejó un plan."
if not ok:
    sql=(f"UPDATE contenido.campania_propuesta SET estado='error', "
         f"error={dq(falta)}, procesado_en=now() WHERE id='{pid}';")
elif fase == "acciones":
    # El resumen del plan NO se pisa con la línea de la fase 2: es lo que el negocio aprobó.
    sql=(f"UPDATE contenido.campania_propuesta SET estado='aprobada', "
         f"acciones={dq(json.dumps(d['acciones'], ensure_ascii=False))}::jsonb, "
         f"procesado_en=now() WHERE id='{pid}';")
else:
    sql=(f"UPDATE contenido.campania_propuesta SET estado='lista', "
         f"resumen={dq(d.get('resumen') or '')}, resumen_original={dq(d.get('resumen') or '')}, "
         f"procesado_en=now() WHERE id='{pid}';")
subprocess.run(["docker","exec","-i",pg,"psql","-U","postgres","-d","claude","-q","-c",sql])
print("acciones propuestas:", len((d or {}).get("acciones") or []))
PY
echo "$(ts) propuesta $pid lista" >> "$LOG"
rm -rf "$DIRW"
