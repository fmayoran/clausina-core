#!/usr/bin/env bash
# Levanta Redis como contenedor en el VPS (solo localhost; el worker corre en el host).
# Idempotente: si ya existe el contenedor, no hace nada.
set -euo pipefail

NAME="cf-redis"
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "$NAME ya existe; arrancando si está detenido"
  docker start "$NAME" >/dev/null
else
  # Host 6380 (el 6379 lo usa el Redis del POC) -> 6379 interno. Solo 127.0.0.1 (no expuesto).
  docker run -d --name "$NAME" --restart unless-stopped \
    -p 127.0.0.1:6380:6379 \
    -v cf-redis-data:/data \
    redis:7-alpine redis-server --appendonly yes
  echo "$NAME creado"
fi
docker ps -f name="$NAME" --format '  {{.Names}}  {{.Status}}  {{.Ports}}'
