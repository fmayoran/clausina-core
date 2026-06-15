#!/usr/bin/env bash
# Procesa requerimientos de cambio de LANDING (capacidad de agencia). Cron en el VPS.
# Toma un contenido.landing_cambios pendiente; el creativo (claude -p headless) edita la landing
# de la marca en la branch 'draft'; push -> Cloudflare genera la PREVIEW. NADA va a producción:
# el merge draft->main (producción) lo hace la APROBACIÓN, en otro paso (panel).
# Aislamiento multiproyecto: cada corrida = una sola cápsula (la del proyecto del requerimiento).

set -uo pipefail
export HOME=/root
export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"

MARCAS="/root/claudefolder/marcas"
MOTOR="/root/claudefolder/plataforma"
LOG="$MOTOR/scripts/landing_local.log"
WORKERS_SUBDOMAIN="fernando-mayorano"   # subdominio workers.dev de la cuenta Cloudflare (preview por branch)
CID=$(docker ps -q -f name=crm_pgvector.1.)
ts(){ date -Is; }
psql(){ docker exec -i "$CID" psql -U postgres -d claude -t -A -c "$1"; }
fail(){ psql "UPDATE contenido.landing_cambios SET estado='error', actualizado_en=now(), procesado_en=now() WHERE id='$1';" >/dev/null; }

exec 9>/tmp/cf_landing.lock; flock -n 9 || exit 0

# 1) requerimiento de landing pendiente (el más viejo)
row=$(psql "SELECT row_to_json(t) FROM (SELECT id, proyecto_id FROM contenido.landing_cambios WHERE estado='pendiente' ORDER BY creado_en LIMIT 1) t;")
[ -z "$row" ] && { echo "$(ts) sin requerimientos de landing" >> "$LOG"; exit 0; }
lid=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
pid=$(echo "$row" | python3 -c "import sys,json;print(json.load(sys.stdin)['proyecto_id'])")

# el texto del requerimiento, sin problemas de comillas: a archivo
psql "SELECT requerimiento FROM contenido.landing_cambios WHERE id='$lid';" > /tmp/landing_req.txt
[ -s /tmp/landing_req.txt ] || { echo "$(ts) requerimiento vacío $lid" >> "$LOG"; fail "$lid"; exit 1; }

slug=$(psql "SELECT slug FROM contenido.proyectos WHERE id='$pid';")
[ -z "$slug" ] && { echo "$(ts) sin slug para $pid" >> "$LOG"; fail "$lid"; exit 1; }
REPO="$MARCAS/$slug"
[ -d "$REPO/.git" ] || { echo "$(ts) cápsula sin repo git: $REPO" >> "$LOG"; fail "$lid"; exit 1; }
[ -d "$REPO/assets/landing" ] || { echo "$(ts) sin assets/landing en $REPO" >> "$LOG"; fail "$lid"; exit 1; }
PREVIEW="https://draft-$slug.$WORKERS_SUBDOMAIN.workers.dev"

echo "$(ts) cambio $lid (proyecto=$slug)" >> "$LOG"
psql "UPDATE contenido.landing_cambios SET estado='procesando', actualizado_en=now() WHERE id='$lid';" >/dev/null

# 2) branch 'draft' fresco desde main (descartando cualquier borrador previo)
cd "$REPO" || { fail "$lid"; exit 1; }
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no"
git fetch origin >/dev/null 2>&1
git checkout main >/dev/null 2>&1 && git reset --hard origin/main >/dev/null 2>&1
git branch -D draft >/dev/null 2>&1 || true
git checkout -b draft >/dev/null 2>&1 || { echo "$(ts) no pude crear draft" >> "$LOG"; git checkout main >/dev/null 2>&1; fail "$lid"; exit 1; }
bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true

# 3) el creativo edita la landing (NO toca git ni la base; el script controla eso)
PROMPT="Sos el Director Creativo del proyecto (su identidad, voz y estética están en contexto/CONTEXTO_MARCA.md y el CLAUDE.md del directorio actual). Estás EDITANDO la landing del proyecto según un requerimiento.
El requerimiento está en /tmp/landing_req.txt: leelo primero.
Reglas DURAS:
- Editá SOLO archivos dentro de assets/landing/. RESPETÁ el diseño, la estructura y los tokens actuales de la marca (no rehagas la página de cero; aplicá el cambio pedido).
- Mantené la calidad: corré 'python3 $MOTOR/scripts/validate_web.py assets/landing' y NO termines hasta que pase (exit 0).
- NO uses git (no commit, no push, no cambiar de branch): de eso se encarga el script que te invoca.
- NO publiques nada, NO toques la base, NO uses datos ni voz de otra marca.
Al final resumí en UNA sola línea qué cambiaste."
timeout 1200 claude -p "$PROMPT" --model sonnet --allowedTools "Bash" Read Write Edit Glob Grep >> "$LOG" 2>&1

# 4) gate de calidad (el script lo corre igual, no confía solo en el agente)
if ! python3 "$MOTOR/scripts/validate_web.py" "$REPO/assets/landing" >> "$LOG" 2>&1; then
  echo "$(ts) validate_web FALLO -> error" >> "$LOG"
  git checkout main >/dev/null 2>&1; git branch -D draft >/dev/null 2>&1
  fail "$lid"; exit 1
fi

# 5) ¿hubo cambios?
if git diff --quiet -- assets/landing; then
  echo "$(ts) el creativo no modificó la landing -> error" >> "$LOG"
  git checkout main >/dev/null 2>&1; git branch -D draft >/dev/null 2>&1
  fail "$lid"; exit 1
fi

# 6) commit + push a DRAFT (nunca a main). Force: draft es efímero, se rehace desde main cada vez.
git add -A assets/landing/
git -c user.name="Creativo ClaUsina" -c user.email="creativo@clausina.local" commit -q -m "Landing (borrador) — cambio $lid"
sha=$(git rev-parse --short HEAD)
if git push -f origin draft >> "$LOG" 2>&1; then
  psql "UPDATE contenido.landing_cambios SET estado='borrador', branch='draft', preview_url='$PREVIEW', commit_sha='$sha', procesado_en=now(), actualizado_en=now() WHERE id='$lid';" >/dev/null
  echo "$(ts) borrador listo $lid -> $PREVIEW (sha $sha)" >> "$LOG"
else
  echo "$(ts) push a draft FALLO" >> "$LOG"; fail "$lid"
fi
git checkout main >/dev/null 2>&1
