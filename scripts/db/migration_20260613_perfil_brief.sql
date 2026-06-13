-- Simplificar el perfil: todo al brief; campos sueltos solo slogan + logo (la marca/nombre vive en proyectos). 2026-06-13
BEGIN;

ALTER TABLE contenido.proyecto_perfil ADD COLUMN IF NOT EXISTS slogan text;
ALTER TABLE contenido.proyecto_perfil ADD COLUMN IF NOT EXISTS logo text;

-- Fusionar las secciones estructuradas dentro de brief_md (markdown con encabezados; saltea las vacías).
UPDATE contenido.proyecto_perfil SET brief_md = concat_ws(E'\n\n',
  CASE WHEN propuesta_valor       IS NOT NULL THEN E'## Propuesta de valor\n'||propuesta_valor END,
  CASE WHEN publico               IS NOT NULL THEN E'## Público objetivo\n'||publico END,
  CASE WHEN tono                  IS NOT NULL THEN E'## Tono y voz\n'||tono END,
  CASE WHEN lineamientos_visuales IS NOT NULL THEN E'## Lineamientos visuales\n'||lineamientos_visuales END,
  CASE WHEN hacer                 IS NOT NULL THEN E'## Hacer\n'||hacer END,
  CASE WHEN evitar                IS NOT NULL THEN E'## Evitar\n'||evitar END,
  CASE WHEN productos_servicios   IS NOT NULL THEN E'## Productos / servicios\n'||productos_servicios END,
  CASE WHEN datos_clave           IS NOT NULL THEN E'## Datos clave\n'||datos_clave END,
  CASE WHEN nullif(brief_md,'')   IS NOT NULL THEN brief_md END
);

-- Slogan + logo por proyecto.
UPDATE contenido.proyecto_perfil pp SET
  slogan = 'Pará. Comé. Seguí.',
  logo = 'interior-graficas/entregables/Logo.png (oficial; transparentes cortafuego_logo_blanco/negro). NUNCA inventar ni regenerar.'
FROM contenido.proyectos p WHERE p.id=pp.proyecto_id AND p.slug='cortafuego';

UPDATE contenido.proyecto_perfil pp SET
  slogan = 'Una nueva forma de vivir Ranelagh',
  logo = 'Isotipo: 4 líneas convergentes (dorado/azul/verde/rojo) sobre blanco. PENDIENTE el archivo oficial.'
FROM contenido.proyectos p WHERE p.id=pp.proyecto_id AND p.slug='ardora';

-- Quitar las columnas estructuradas (su contenido quedó en brief_md).
ALTER TABLE contenido.proyecto_perfil
  DROP COLUMN propuesta_valor, DROP COLUMN publico, DROP COLUMN tono, DROP COLUMN lineamientos_visuales,
  DROP COLUMN hacer, DROP COLUMN evitar, DROP COLUMN productos_servicios, DROP COLUMN datos_clave;

COMMIT;
