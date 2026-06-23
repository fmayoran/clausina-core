#!/usr/bin/env bash
# Mantiene el panel de ClaUsina (app EasyPanel) conectado a la red de la base.
# EasyPanel recrea el contenedor en cada deploy y pierde la red easypanel-crm; esto lo reconecta.
# Idempotente: si ya está conectado, no hace nada. Pensado para correr por cron cada minuto.
cid=$(docker ps -q -f name=clausina_panel) || exit 0
[ -z "$cid" ] && exit 0
docker network inspect easypanel-crm --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -q clausina_panel && exit 0
docker network connect easypanel-crm "$cid" 2>/dev/null \
  && echo "$(date -Is) reconectado easypanel-crm" >> /root/claudefolder/core/scripts/clausina_net.log
