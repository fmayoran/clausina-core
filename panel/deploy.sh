#!/usr/bin/env bash
# Deploy del panel (clausina_panel) vía EasyPanel.
#
# El panel YA NO corre como contenedor suelto (`docker run cf-panel`). Hoy es un
# servicio swarm gestionado por EasyPanel: proyecto `clausina`, servicio `panel`,
# imagen `easypanel/clausina/panel`, dominio público https://panel.clausina.ar.
# Source: repo git@github.com:fmayoran/clausina-core.git (ref main), build por Dockerfile.
#
# OJO: el panel NO auto-despliega con push a GitHub (a diferencia de la landing).
# Hay que disparar el deploy a mano -> esto hace eso: dispara el rebuild en EasyPanel,
# que clona el repo, reconstruye la imagen y recrea el servicio (zero-downtime).
#
# ══ LO QUE ESTE SCRIPT APRENDIÓ A LA MALA ══════════════════════════════════════════
#
# 1. EasyPanel construye LO QUE HAY EN GITHUB, no lo que hay en el disco. Un deploy
#    disparado con cambios sin commitear —o commiteados y sin pushear— reconstruye la
#    versión anterior y dice "OK". Pasó: el push falló por la clave SSH, el deploy se
#    disparó igual y la corrección no llegó, con el script informando éxito. Ahora se
#    comprueba ANTES y, si falta pushear, no se dispara nada.
#
# 2. "El servicio recreó la task" NO es "el servicio corre TU código". Es la misma
#    trampa desde el otro lado. Ahora se verifica contra el commit: EasyPanel informa
#    cuál construyó, y además se compara el contenido real de los archivos dentro del
#    contenedor con los del disco.
#
# 3. Cuatro minutos de espera eran pocos. Con caché el build tarda segundos; sin caché
#    pasa de cinco minutos, y el script se rendía con un AVISO que se leía como fallo
#    cuando el deploy estaba en curso. La espera es de 12 minutos.
#
# Requiere en /root/clausina/.env: EASYPANEL_URL y EASYPANEL_API_KEY.
set -euo pipefail

ENV_FILE="/root/clausina/.env"
PROJECT="clausina"
SERVICE="panel"
ESPERA_MAX=72          # 72 x 10s = 12 minutos

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

# ── 1. Lo que se va a construir es lo que está en GitHub ────────────────────────────
sucio=$(git -C "$REPO" status --porcelain --untracked-files=no)
if [ -n "$sucio" ]; then
  echo "Hay cambios sin commitear en $REPO. EasyPanel construye desde GitHub, así que NO se" >&2
  echo "desplegarían. Commiteá y pusheá primero:" >&2
  echo "$sucio" | sed 's/^/  /' >&2
  exit 1
fi

git -C "$REPO" fetch -q origin main
LOCAL=$(git -C "$REPO" rev-parse HEAD)
REMOTO=$(git -C "$REPO" rev-parse origin/main)
if [ "$LOCAL" != "$REMOTO" ]; then
  echo "El commit local no está en GitHub (local ${LOCAL:0:7}, origin/main ${REMOTO:0:7})." >&2
  echo "Corré 'git -C $REPO push origin main' y volvé a intentar." >&2
  exit 1
fi
echo "Desplegando ${LOCAL:0:7} — $(git -C "$REPO" log -1 --format=%s)"

EP_URL=$(grep -E '^EASYPANEL_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ' | sed 's:/*$::')
EP_KEY=$(grep -E '^EASYPANEL_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ')
: "${EP_URL:?falta EASYPANEL_URL en $ENV_FILE}"
: "${EP_KEY:?falta EASYPANEL_API_KEY en $ENV_FILE}"

# Obtener el deploy token del servicio (sobrevive a rotaciones del token).
# OJO: desde la actualización de EasyPanel (jul-2026) la API tRPC exige POST; con GET da 405
# y el script fallaba en silencio (decía "desplegado" sin haber deployado). No volver a GET.
servicios() {
  curl -fsS -X POST -H "Authorization: Bearer $EP_KEY" -H 'Content-Type: application/json' -d '{}' \
    "$EP_URL/api/trpc/projects.listProjectsAndServices"
}
TOKEN=$(servicios | python3 -c "import sys,json
r=json.load(sys.stdin)
d=r.get('result',{}).get('data',{}).get('json') or r.get('json') or r
print(next(s['token'] for s in d['services']
          if s['projectName']=='$PROJECT' and s['name']=='$SERVICE'))") || {
  echo "No pude obtener el deploy token de $PROJECT/$SERVICE (¿cambió la API de EasyPanel?)" >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "Deploy token vacío para $PROJECT/$SERVICE" >&2; exit 1; }

echo "Disparando deploy de $PROJECT/$SERVICE en EasyPanel..."
HTTP=$(curl -fsS -o /dev/null -w '%{http_code}' \
  -X POST "$EP_URL/api/deploy/$TOKEN" \
  -H 'Content-Type: application/json' -d '{}') || {
  echo "El disparo del deploy falló" >&2; exit 1; }
echo "Deploy disparado (HTTP $HTTP). Esperando a que el contenedor corra ${LOCAL:0:7}…"

# ── 2. Verificación: ¿el contenedor corre ESTE commit? ──────────────────────────────
# Dos comprobaciones, porque miden cosas distintas: EasyPanel dice qué commit construyó,
# y el contenido de los archivos dice qué está corriendo de verdad.
commit_construido() {
  servicios 2>/dev/null | python3 -c "import sys,json
try:
    r=json.load(sys.stdin)
    d=r.get('result',{}).get('data',{}).get('json') or r.get('json') or r
    s=next(x for x in d['services'] if x['projectName']=='$PROJECT' and x['name']=='$SERVICE')
    print((s.get('commit') or {}).get('hash',''))
except Exception: print('')" 2>/dev/null
}
# Huella del código del panel: los archivos versionados, tal como quedaron en el contenedor.
LISTA=$(cd "$REPO/panel" && git ls-files '*.js' '*.html' '*.css' | grep -v '^node_modules/' | sort)
HUELLA_LOCAL=$(cd "$REPO/panel" && printf '%s\n' "$LISTA" | xargs md5sum | md5sum | cut -d' ' -f1)
huella_contenedor() {
  local c
  c=$(docker ps --format '{{.Names}}' | grep clausina_panel | head -1) || return 1
  [ -n "$c" ] || return 1
  printf '%s\n' "$LISTA" | docker exec -i "$c" sh -c 'cd /app && xargs md5sum 2>/dev/null | md5sum' 2>/dev/null | cut -d' ' -f1
}

for i in $(seq 1 $ESPERA_MAX); do
  sleep 10
  if [ "$(huella_contenedor)" = "$HUELLA_LOCAL" ]; then
    hash=$(commit_construido)
    echo "OK: el contenedor corre tu código (${LOCAL:0:7})$([ "$hash" = "$LOCAL" ] && echo ', confirmado por EasyPanel')."
    exit 0
  fi
done

echo "AVISO: pasaron $((ESPERA_MAX/6)) min y el contenedor NO tiene ${LOCAL:0:7}." >&2
echo "El build puede seguir en curso: revisalo en EasyPanel antes de volver a disparar." >&2
exit 1
