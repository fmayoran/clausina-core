#!/usr/bin/env bash
# Regenera marcas/<slug>/contexto/CONTEXTO_MARCA.md desde el perfil en la base (fuente de verdad).
# Lo corren los crons antes de generar, para que el creativo use siempre el perfil actual del panel.
set -uo pipefail
SLUG="${1:?uso: perfil_a_md.sh <slug>}"
OUT="/root/claudefolder/marcas/$SLUG/contexto/CONTEXTO_MARCA.md"
CID=$(docker ps -q -f name=crm_pgvector.1.)
[ -z "$CID" ] && { echo "sin contenedor de base"; exit 1; }
mkdir -p "$(dirname "$OUT")"
docker exec -i "$CID" psql -U postgres -d claude -At -v slug="$SLUG" >"$OUT" <<'SQL'
SELECT format(
E'# %s — Perfil de marca\n'
 '> Generado desde la base (fuente de verdad). Editar en cortafuego.ar/panel/perfil, NO a mano.\n\n'
 '## Propuesta de valor\n%s\n\n'
 '## Público objetivo\n%s\n\n'
 '## Tono y voz\n%s\n\n'
 '## Lineamientos visuales\n%s\n\n'
 '## Hacer\n%s\n\n'
 '## Evitar\n%s\n\n'
 '## Productos / servicios\n%s\n\n'
 '## Datos clave\n%s\n\n'
 '## Brief\n%s\n',
 pr.nombre, coalesce(pp.propuesta_valor,''), coalesce(pp.publico,''), coalesce(pp.tono,''),
 coalesce(pp.lineamientos_visuales,''), coalesce(pp.hacer,''), coalesce(pp.evitar,''),
 coalesce(pp.productos_servicios,''), coalesce(pp.datos_clave,''), coalesce(pp.brief_md,''))
FROM contenido.proyectos pr
LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id = pr.id
WHERE pr.slug = :'slug';
SQL
[ -s "$OUT" ] && echo "perfil -> $OUT ($(wc -l <"$OUT") líneas)" || { echo "vacío, no escribo"; exit 1; }
