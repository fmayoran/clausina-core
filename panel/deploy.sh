#!/usr/bin/env bash
# Deploy del panel (clausina_panel) vía EasyPanel.
#
# El panel YA NO corre como contenedor suelto (`docker run cf-panel`). Hoy es un
# servicio swarm gestionado por EasyPanel: proyecto `clausina`, servicio `panel`,
# imagen `easypanel/clausina/panel`, dominio público https://panel.clausina.ar.
# Source: repo git@github.com:fmayoran/clausina.git (ref main), build por Dockerfile.
#
# OJO: el panel NO auto-despliega con push a GitHub (a diferencia de la landing).
# Hay que disparar el deploy a mano -> esto hace eso: dispara el rebuild en EasyPanel,
# que clona el repo, reconstruye la imagen y recrea el servicio (zero-downtime).
#
# Requiere en /root/clausina/.env: EASYPANEL_URL y EASYPANEL_API_KEY.
set -euo pipefail

ENV_FILE="/root/clausina/.env"
PROJECT="clausina"
SERVICE="panel"

EP_URL=$(grep -E '^EASYPANEL_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ' | sed 's:/*$::')
EP_KEY=$(grep -E '^EASYPANEL_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ')
: "${EP_URL:?falta EASYPANEL_URL en $ENV_FILE}"
: "${EP_KEY:?falta EASYPANEL_API_KEY en $ENV_FILE}"

# Obtener el deploy token del servicio (sobrevive a rotaciones del token).
# OJO: desde la actualización de EasyPanel (jul-2026) la API tRPC exige POST; con GET da 405
# y el script fallaba en silencio (decía "desplegado" sin haber deployado). No volver a GET.
TOKEN=$(curl -fsS -X POST -H "Authorization: Bearer $EP_KEY" -H 'Content-Type: application/json' -d '{}' \
  "$EP_URL/api/trpc/projects.listProjectsAndServices" \
  | python3 -c "import sys,json
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
echo "Deploy disparado (HTTP $HTTP). Esperando a que el contenedor tome la imagen nueva…"

# Verificación REAL: esperar a que el servicio recree la task (si no, el deploy no sirvió).
antes=$(docker service ps clausina_panel --format '{{.ID}}' --filter desired-state=running 2>/dev/null | head -1)
for i in $(seq 1 40); do
  sleep 6
  ahora=$(docker service ps clausina_panel --format '{{.ID}}' --filter desired-state=running 2>/dev/null | head -1)
  if [ -n "$ahora" ] && [ "$ahora" != "$antes" ]; then
    echo "OK: el servicio recreó la task (imagen nueva en marcha)."
    exit 0
  fi
done
echo "AVISO: pasaron ~4 min y el servicio NO recreó la task. Revisá el build en EasyPanel." >&2
exit 1
