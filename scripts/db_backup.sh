#!/usr/bin/env bash
# Respaldo diario de ClaUsina: base 'claude' + material irreemplazable del media store.
# Off-site a un repo privado de GitHub (fmayoran/clausina-backups) — el respaldo tiene que vivir
# FUERA de este disco: si muere el VPS, el dump local se va con él.
#
# Restaurar la base:
#   docker exec -i <crm_pgvector> pg_restore -U postgres -d claude --clean --if-exists < db/claude_latest.dump
# Restaurar el material:
#   cp -r media/* /var/lib/docker/volumes/clausina_panel_clausina-media/_data/
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"

LOCAL=/root/backups/postgres
OFFSITE=/root/backups/clausina-backups
MEDIA=/var/lib/docker/volumes/clausina_panel_clausina-media/_data
LOG="$LOCAL/backup.log"
mkdir -p "$LOCAL"
ts(){ date -Is; }

CID=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$CID" ] && { echo "$(ts) ERROR sin contenedor de base" >> "$LOG"; exit 1; }

# --- 0) Higiene: podar tablas de historial ANTES del dump (para no respaldar basura) ---
# Lección del sqlite de n8n (993 MB): toda tabla que sólo crece termina siendo un problema.
# job_runs es historial de diagnóstico; 30 días alcanza de sobra.
PODA=$(docker exec -i "$CID" psql -U postgres -d claude -t -A -q -c \
  "WITH d AS (DELETE FROM contenido.job_runs WHERE creado_en < now()-interval '30 days' RETURNING 1) SELECT count(*) FROM d;" 2>>"$LOG")
[ -n "${PODA:-}" ] && [ "${PODA:-0}" != "0" ] && echo "$(ts) poda job_runs: $PODA fila(s)" >> "$LOG"
PODA_WA=$(docker exec -i "$CID" psql -U postgres -d claude -t -A -q -c \
  "WITH d AS (DELETE FROM contenido.whatsapp_mensaje WHERE creado_en < now()-interval '90 days' RETURNING 1) SELECT count(*) FROM d;" 2>>"$LOG")
[ -n "${PODA_WA:-}" ] && [ "${PODA_WA:-0}" != "0" ] && echo "$(ts) poda whatsapp_mensaje: $PODA_WA fila(s)" >> "$LOG"

# --- 1) Dump de la base ---
TS=$(date +%Y%m%d_%H%M)
F="$LOCAL/claude_$TS.dump"
if docker exec -i "$CID" pg_dump -U postgres -d claude -Fc > "$F" 2>>"$LOG" && [ -s "$F" ]; then
  echo "$(ts) dump OK $(basename "$F") ($(wc -c <"$F") bytes)" >> "$LOG"
else
  echo "$(ts) ERROR dump falló" >> "$LOG"; rm -f "$F"; exit 1
fi

# Retención local: últimos 30 dumps
ls -1t "$LOCAL"/claude_*.dump 2>/dev/null | tail -n +31 | xargs -r rm -f

# --- 2) Off-site (base + media) ---
if [ ! -d "$OFFSITE/.git" ]; then
  echo "$(ts) ERROR off-site no configurado (falta el clon en $OFFSITE) — EL RESPALDO NO SALE DEL VPS" >> "$LOG"
  exit 1
fi

mkdir -p "$OFFSITE/db" "$OFFSITE/media"
cp "$F" "$OFFSITE/db/claude_latest.dump"

# Media: solo lo IRREEMPLAZABLE (lo subió alguien y no se puede volver a generar).
# grafica/ y manual/ quedan fuera a propósito: el sistema los vuelve a producir.
for d in biblioteca material marca avisos ig referencias; do
  [ -d "$MEDIA/$d" ] && rsync -a --delete "$MEDIA/$d/" "$OFFSITE/media/$d/" 2>>"$LOG"
done

cd "$OFFSITE" || exit 1
git add -A
if git diff --cached --quiet; then
  echo "$(ts) off-site sin cambios" >> "$LOG"
  exit 0
fi

GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" \
  git -c user.name="ClaUsina Backup" -c user.email="backup@clausina.local" commit -q -m "respaldo $TS"
if GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" git push -q origin main 2>>"$LOG"; then
  # Verificar de VERDAD que llegó: que el remoto tenga el commit que acabamos de hacer.
  # (un push que "no falla" no garantiza que el respaldo esté afuera).
  LOCAL_SHA=$(git rev-parse HEAD)
  REMOTE_SHA=$(GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)
  if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    echo "$(ts) off-site OK (verificado en el remoto: ${LOCAL_SHA:0:8})" >> "$LOG"
  else
    echo "$(ts) ERROR off-site: el push dijo OK pero el remoto NO tiene el commit" >> "$LOG"; exit 1
  fi
else
  echo "$(ts) ERROR off-site push FALLÓ" >> "$LOG"; exit 1
fi
