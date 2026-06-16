#!/usr/bin/env bash
# Backup diario de la base 'claude' (todo el contenido de la agencia: proyectos, piezas,
# revisiones, landing_cambios, etc.). Local en el VPS + off-site a un repo privado de GitHub.
# Restaurar: docker exec -i <crm_pgvector> pg_restore -U postgres -d claude --clean --if-exists < archivo.dump
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

LOCAL=/root/backups/postgres
OFFSITE=/root/backups/clausina-backups   # clon del repo privado fmayoran/clausina-backups (si existe, se pushea)
LOG="$LOCAL/backup.log"
mkdir -p "$LOCAL"

CID=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$CID" ] && { echo "$(date -Is) ERROR sin contenedor de base" >> "$LOG"; exit 1; }

TS=$(date +%Y%m%d_%H%M)
F="$LOCAL/claude_$TS.dump"
if docker exec -i "$CID" pg_dump -U postgres -d claude -Fc > "$F" 2>>"$LOG" && [ -s "$F" ]; then
  echo "$(date -Is) dump OK $(basename "$F") ($(wc -c <"$F") bytes)" >> "$LOG"
else
  echo "$(date -Is) ERROR dump falló" >> "$LOG"; rm -f "$F"; exit 1
fi

# Retención local: últimos 30 dumps
ls -1t "$LOCAL"/claude_*.dump 2>/dev/null | tail -n +31 | xargs -r rm -f

# Off-site: si está el clon del repo, actualiza claude_latest.dump y commitea (el historial de git = retención diaria)
if [ -d "$OFFSITE/.git" ]; then
  cp "$F" "$OFFSITE/claude_latest.dump"
  cd "$OFFSITE" || exit 0
  git add -A
  if ! git diff --cached --quiet; then
    GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" \
      git -c user.name="ClaUsina Backup" -c user.email="backup@clausina.local" commit -q -m "backup $TS" \
      && GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" git push -q origin main \
      && echo "$(date -Is) off-site push OK" >> "$LOG" \
      || echo "$(date -Is) off-site push FALLÓ" >> "$LOG"
  fi
else
  echo "$(date -Is) off-site no configurado (falta clon en $OFFSITE)" >> "$LOG"
fi
