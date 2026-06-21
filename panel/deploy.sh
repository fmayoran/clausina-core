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
# Requiere en /root/claudefolder/.env: EASYPANEL_URL y EASYPANEL_API_KEY.
set -euo pipefail

ENV_FILE="/root/claudefolder/.env"
PROJECT="clausina"
SERVICE="panel"

EP_URL=$(grep -E '^EASYPANEL_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ' | sed 's:/*$::')
EP_KEY=$(grep -E '^EASYPANEL_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"' ')
: "${EP_URL:?falta EASYPANEL_URL en $ENV_FILE}"
: "${EP_KEY:?falta EASYPANEL_API_KEY en $ENV_FILE}"

# Obtener el deploy token del servicio (sobrevive a rotaciones del token).
TOKEN=$(curl -fsS -H "Authorization: Bearer $EP_KEY" \
  "$EP_URL/api/trpc/projects.listProjectsAndServices" \
  | python3 -c "import sys,json
r=json.load(sys.stdin)
d=r.get('result',{}).get('data',{}).get('json') or r.get('json') or r
print(next(s['token'] for s in d['services']
          if s['projectName']=='$PROJECT' and s['name']=='$SERVICE'))")

[ -n "$TOKEN" ] || { echo "No pude obtener el deploy token de $PROJECT/$SERVICE" >&2; exit 1; }

echo "Disparando deploy de $PROJECT/$SERVICE en EasyPanel..."
HTTP=$(curl -fsS -o /dev/null -w '%{http_code}' \
  -X POST "$EP_URL/api/deploy/$TOKEN" \
  -H 'Content-Type: application/json' -d '{}')

echo "Deploy disparado (HTTP $HTTP). Seguí el progreso en EasyPanel o con:"
echo "  docker service ps clausina_panel"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://panel.clausina.ar/"
