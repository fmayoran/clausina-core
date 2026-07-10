#!/usr/bin/env bash
# Scaffold de la cápsula de una marca (artefacto DERIVADO de la DB). Idempotente.
# Crea marcas/<slug>/ con: contexto/CONTEXTO_MARCA.md (desde el perfil), <slug>.env vacío
# y un CLAUDE.md fino. NO es el repo de la landing (eso es la capacidad Web, aparte).
# Uso: scaffold_marca.sh <slug>
set -uo pipefail
slug="${1:-}"
[ -z "$slug" ] && { echo "uso: scaffold_marca.sh <slug>" >&2; exit 2; }
# Seguridad: slug válido (lo mismo que valida el panel).
case "$slug" in
  *[!a-z0-9-]*|"" ) echo "slug inválido: $slug" >&2; exit 2 ;;
esac

MARCAS="/root/clausina/marcas"
MOTOR="/root/clausina/core"
REPO="$MARCAS/$slug"
CID=$(docker ps -q -f name=crm_pgvector.1.)

# La marca tiene que existir en la DB (la cápsula deriva de ahí).
nombre=$(docker exec -i "$CID" psql -U postgres -d claude -t -A -c "SELECT nombre FROM contenido.proyectos WHERE slug='$slug'")
[ -z "$nombre" ] && { echo "la marca '$slug' no existe en la DB" >&2; exit 1; }

mkdir -p "$REPO/contexto" "$REPO/assets/landing"
[ -f "$REPO/$slug.env" ] || {
  printf '# Secretos de la cápsula %s (Telegram/mail y lo que aún no migró a la DB).\n# Los tokens administrables (IG, Meta Ads) viven CIFRADOS en el perfil (DB), no acá.\n' "$slug" > "$REPO/$slug.env"
  chmod 600 "$REPO/$slug.env"
}
# .gitignore mínimo (secretos y media pesada fuera del repo)
[ -f "$REPO/.gitignore" ] || printf '%s.env\n*.env\nassets/landing/publicaciones/*.mp4\n' "$slug" > "$REPO/.gitignore"

# Contexto de marca desde la base (fuente de verdad).
bash "$MOTOR/scripts/perfil_a_md.sh" "$slug" >/dev/null 2>&1 || true

# CLAUDE.md fino de la cápsula (lo específico de la marca; el motor vive en el CLAUDE.md raíz).
if [ ! -f "$REPO/CLAUDE.md" ]; then
  cat > "$REPO/CLAUDE.md" <<EOF
# $nombre — cápsula

Cápsula de la marca **$nombre** (slug \`$slug\`). Generada por el alta de marca del panel.

- Contexto/voz de marca: \`contexto/CONTEXTO_MARCA.md\` (se regenera desde el perfil en la DB; editar en el panel, NO a mano).
- Secretos de la cápsula: \`$slug.env\` (Telegram/mail). Los tokens de IG/Meta Ads viven cifrados en el perfil.
- El motor y las reglas compartidas están en el CLAUDE.md raíz del contenedor.
EOF
fi

echo "cápsula lista: $REPO"
