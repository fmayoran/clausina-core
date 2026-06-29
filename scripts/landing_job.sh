#!/usr/bin/env bash
# Job de UN cambio de landing. Extraído verbatim de landing_local.sh.
#   accion='aplicar'  -> cambio APROBADO: draft -> producción (main).
#   accion='procesar' -> cambio PENDIENTE: el creativo edita -> push a draft -> preview.
# Lo invoca el worker; el ruteo/cola lo hace el dispatcher.
# Uso: landing_job.sh <slug> <cambio_id> <aplicar|procesar>
set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

slug="${1:-}"; cid="${2:-}"; accion="${3:-}"
{ [ -z "$slug" ] || [ -z "$cid" ] || [ -z "$accion" ]; } && { echo "uso: landing_job.sh <slug> <cambio_id> <aplicar|procesar>" >&2; exit 2; }

MARCAS="/root/clausina/marcas"
MOTOR="/root/clausina/core"
LOG="$MOTOR/scripts/landing_local.log"
WORKERS_SUBDOMAIN="fernando-mayorano"
CID=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }
fail(){ psql "UPDATE contenido.landing_cambios SET estado='error', actualizado_en=now(), procesado_en=now() WHERE id='$1';" >/dev/null; }

exec 9>"/tmp/cf_landing_${cid}.lock"; flock -n 9 || exit 0
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no"

REPO="$MARCAS/$slug"

if [ "$accion" = "aplicar" ]; then
  # APROBADO -> aplicar el borrador (draft) a producción (main).
  [ -d "$REPO/.git" ] || { psql "UPDATE contenido.landing_cambios SET estado='error',actualizado_en=now() WHERE id='$cid';" >/dev/null; exit 1; }
  cd "$REPO" || exit 1
  git fetch origin >/dev/null 2>&1
  git checkout main >/dev/null 2>&1 && git reset --hard origin/main >/dev/null 2>&1
  if ! git rev-parse --verify origin/draft >/dev/null 2>&1; then
    echo "$(ts) aprobar $cid: no hay draft remoto" >> "$LOG"
    psql "UPDATE contenido.landing_cambios SET estado='error',actualizado_en=now() WHERE id='$cid';" >/dev/null; exit 1
  fi
  git checkout origin/draft -- assets/landing 2>>"$LOG"
  git add -A assets/landing
  if git diff --cached --quiet; then
    psql "UPDATE contenido.landing_cambios SET estado='en_produccion',actualizado_en=now(),procesado_en=now() WHERE id='$cid';" >/dev/null
    echo "$(ts) aprobar $cid: sin diferencias con prod" >> "$LOG"
  else
    git -c user.name="ClaUsina" -c user.email="creativo@clausina.local" commit -q -m "Landing: aprobado cambio $cid"
    asha=$(git rev-parse --short HEAD)
    if git push origin main >> "$LOG" 2>&1; then
      git push origin --delete draft >/dev/null 2>&1 || true
      psql "UPDATE contenido.landing_cambios SET estado='en_produccion',commit_sha='$asha',actualizado_en=now(),procesado_en=now() WHERE id='$cid';" >/dev/null
      echo "$(ts) aprobado $cid -> produccion (sha $asha)" >> "$LOG"
    else
      psql "UPDATE contenido.landing_cambios SET estado='error',actualizado_en=now() WHERE id='$cid';" >/dev/null
      echo "$(ts) aprobar $cid: push a main fallo" >> "$LOG"
    fi
  fi
  exit 0
fi

# accion='procesar': PENDIENTE -> el creativo edita -> push a draft -> preview
psql "SELECT requerimiento FROM contenido.landing_cambios WHERE id='$cid';" > "/tmp/landing_req_$cid.txt"
[ -s "/tmp/landing_req_$cid.txt" ] || { echo "$(ts) requerimiento vacío $cid" >> "$LOG"; fail "$cid"; exit 1; }

[ -d "$REPO/.git" ] || { echo "$(ts) cápsula sin repo git: $REPO" >> "$LOG"; fail "$cid"; exit 1; }
[ -d "$REPO/assets/landing" ] || { echo "$(ts) sin assets/landing en $REPO" >> "$LOG"; fail "$cid"; exit 1; }
PREVIEW="https://draft-$slug.$WORKERS_SUBDOMAIN.workers.dev"

echo "$(ts) cambio $cid (proyecto=$slug)" >> "$LOG"
psql "UPDATE contenido.landing_cambios SET estado='procesando', actualizado_en=now() WHERE id='$cid';" >/dev/null

cd "$REPO" || { fail "$cid"; exit 1; }
git fetch origin >/dev/null 2>&1
git checkout main >/dev/null 2>&1 && git reset --hard origin/main >/dev/null 2>&1
git branch -D draft >/dev/null 2>&1 || true
git checkout -b draft >/dev/null 2>&1 || { echo "$(ts) no pude crear draft" >> "$LOG"; git checkout main >/dev/null 2>&1; fail "$cid"; exit 1; }
bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true

PROMPT="Sos el Director Creativo del proyecto. LEÉ ANTES DE TOCAR NADA: identidad y voz en contexto/CONTEXTO_MARCA.md y el CLAUDE.md del directorio; y el SISTEMA DE DISEÑO de la marca (logo, tokens de color, tipografía self-hosted, layout y reglas) en contexto/ESTILO.md. Trabajás la landing del proyecto según un requerimiento.
El requerimiento está en /tmp/landing_req_$cid.txt: leelo primero.
Reglas DURAS:
- Diseñá con la disciplina del skill frontend-design: decisiones intencionales y distintivas (nada templado), jerarquía por peso y espacio, una pieza-firma, contención (gastar la audacia en un solo lugar), responsive y accesible.
- El SISTEMA DE DISEÑO de contexto/ESTILO.md es la RESTRICCIÓN dura: usá SUS tokens, tipografía y logo; NO inventes paleta ni fuentes nuevas; mantené la identidad de la marca.
- Editá SOLO dentro de assets/landing/. Aplicá el cambio pedido (o rediseñá la sección con criterio); no rompas el sistema.
- Calidad (gate obligatorio): corré 'python3 $MOTOR/scripts/validate_web.py assets/landing' y NO termines hasta que pase (exit 0). Fuentes self-hosted en fonts/ (sin Google Fonts), imágenes WebP/SVG (sin PNG).
- NO uses git (no commit, no push, no cambiar de branch): de eso se encarga el script que te invoca.
- NO publiques nada, NO toques la base, NO uses datos ni voz de otra marca.
Al final resumí en UNA sola línea qué cambiaste."
timeout 1200 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1

if ! python3 "$MOTOR/scripts/validate_web.py" "$REPO/assets/landing" >> "$LOG" 2>&1; then
  echo "$(ts) validate_web FALLO -> error" >> "$LOG"
  git checkout main >/dev/null 2>&1; git branch -D draft >/dev/null 2>&1
  fail "$cid"; exit 1
fi

if git diff --quiet -- assets/landing; then
  echo "$(ts) el creativo no modificó la landing -> error" >> "$LOG"
  git checkout main >/dev/null 2>&1; git branch -D draft >/dev/null 2>&1
  fail "$cid"; exit 1
fi

git add -A assets/landing/
git -c user.name="Creativo ClaUsina" -c user.email="creativo@clausina.local" commit -q -m "Landing (borrador) — cambio $cid"
sha=$(git rev-parse --short HEAD)
if git push -f origin draft >> "$LOG" 2>&1; then
  psql "UPDATE contenido.landing_cambios SET estado='borrador', branch='draft', preview_url='$PREVIEW', commit_sha='$sha', procesado_en=now(), actualizado_en=now() WHERE id='$cid';" >/dev/null
  echo "$(ts) borrador listo $cid -> $PREVIEW (sha $sha)" >> "$LOG"
else
  echo "$(ts) push a draft FALLO" >> "$LOG"; fail "$cid"
fi
git checkout main >/dev/null 2>&1
