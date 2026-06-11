#!/usr/bin/env bash
# Deploy del panel: rebuild de la imagen + recrear el contenedor en el VPS.
# El contenedor cf-panel corre por `docker run` (no EasyPanel): red easypanel-crm (DB) + easypanel
# (para que el Nginx de la landing lo proxee en cortafuego.ar/panel). Credenciales en /root/cf-panel.env.
set -euo pipefail
cd "$(dirname "$0")"
docker build -q -t cf-panel . >/dev/null
docker rm -f cf-panel >/dev/null 2>&1 || true
docker run -d --name cf-panel --restart unless-stopped --network easypanel-crm \
  --env-file /root/claudefolder/plataforma/plataforma.env \
  --env-file /root/claudefolder/marcas/cortafuego/cortafuego.env \
  --env-file /root/claudefolder/marcas/ardora/ardora.env \
  cf-panel >/dev/null
docker network connect easypanel cf-panel 2>/dev/null || true
echo "cf-panel desplegado ($(docker ps -q -f name=cf-panel))"
