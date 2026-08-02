#!/usr/bin/env bash
# Agrega o actualiza variables de entorno de un servicio en EasyPanel SIN pisar las demás.
#
# Por qué existe: `services.app.updateEnv` reemplaza el bloque ENTERO. Mandar sólo las variables
# nuevas borraría el resto — en el panel eso significa perder APP_ENC_KEY, PANEL_SECRET y las
# credenciales de base. Este script lee lo que hay, fusiona, y escribe todo de vuelta.
#
# Las variables se leen por STDIN (una KEY=VALOR por línea) para que los secretos no queden
# en la lista de procesos ni en el historial del shell.
#
# Uso:
#   printf 'FOO=1\nBAR=2\n' | servicio_env.sh clausina panel --dry-run   # muestra qué haría
#   printf 'FOO=1\n'        | servicio_env.sh clausina panel             # aplica
#   printf 'FOO=1\n'        | servicio_env.sh clausina panel --deploy    # aplica y deploya
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
set -a; source .env 2>/dev/null; set +a

PROY="${1:?uso: servicio_env.sh <proyecto> <servicio> [--dry-run|--deploy]}"
SERV="${2:?falta el servicio}"
MODO="${3:-}"
EP="${EASYPANEL_URL:?falta EASYPANEL_URL}"; KEY="${EASYPANEL_API_KEY:?falta EASYPANEL_API_KEY}"
RESP="/root/backups/easypanel-env"; mkdir -p "$RESP"

NUEVAS=$(cat)   # STDIN
[ -n "$NUEVAS" ] || { echo "ERROR: no llegó ninguna variable por STDIN"; exit 2; }

# La API ya no acepta GET: todo va por POST con {"json":{...}}
ACTUAL=$(curl -s -m 20 -X POST "$EP/api/trpc/services.app.inspectService" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"json\":{\"projectName\":\"$PROY\",\"serviceName\":\"$SERV\"}}")
echo "$ACTUAL" | grep -q '"json"' || { echo "ERROR: no pude leer el servicio $PROY/$SERV"; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
echo "$ACTUAL" > "$RESP/${PROY}-${SERV}-${STAMP}.json"
chmod 600 "$RESP/${PROY}-${SERV}-${STAMP}.json"

FUSION=$(ACTUAL="$ACTUAL" NUEVAS="$NUEVAS" python3 <<'PY'
import json, os
env = json.loads(os.environ['ACTUAL'])['json'].get('env') or ''
orden, valores = [], {}
for linea in env.split('\n'):
    if '=' in linea:
        k = linea.split('=', 1)[0]
        if k not in valores: orden.append(k)
        valores[k] = linea
    elif linea.strip():
        orden.append(None); valores[None] = linea   # comentarios / líneas sueltas

cambios = []
for linea in os.environ['NUEVAS'].split('\n'):
    if '=' not in linea: continue
    k = linea.split('=', 1)[0].strip()
    cambios.append(('actualiza' if k in valores else 'agrega', k))
    if k not in valores: orden.append(k)
    valores[k] = f"{k}={linea.split('=', 1)[1]}"

print(json.dumps({
    'env': '\n'.join(valores[k] for k in orden),
    'cambios': cambios,
    'antes': len([k for k in valores if k]),
}))
PY
)

python3 -c "
import json,sys
d=json.loads(sys.argv[1])
for accion,k in d['cambios']: print(f'  {accion}: {k}')
print(f\"  total de variables tras la fusión: {len(d['env'].splitlines())}\")" "$FUSION"
echo "  respaldo: $RESP/${PROY}-${SERV}-${STAMP}.json"

if [ "$MODO" = "--dry-run" ]; then echo "  (dry-run: no se escribió nada)"; exit 0; fi

BODY=$(FUSION="$FUSION" PROY="$PROY" SERV="$SERV" python3 -c "
import json, os
print(json.dumps({'json': {'projectName': os.environ['PROY'], 'serviceName': os.environ['SERV'],
                           'env': json.loads(os.environ['FUSION'])['env']}}))")

OUT=$(curl -s -m 30 -X POST "$EP/api/trpc/services.app.updateEnv" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' --data "$BODY")
if echo "$OUT" | grep -qi 'error'; then echo "  FALLÓ: $(echo "$OUT" | head -c 200)"; exit 1; fi
echo "  entorno actualizado"

if [ "$MODO" = "--deploy" ]; then
  TOK=$(echo "$ACTUAL" | python3 -c "import sys,json;print(json.load(sys.stdin)['json'].get('token',''))")
  [ -n "$TOK" ] || { echo "  aviso: sin token de deploy; deployá desde EasyPanel"; exit 0; }
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "$EP/api/deploy/$TOK")
  echo "  deploy disparado (HTTP $code)"
fi
