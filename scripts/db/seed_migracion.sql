-- Cortafuego — Migración del registro actual (CALENDARIO_CONTENIDO.md) a la tabla.
-- Idempotente: no duplica si el ig_post_id ya existe.
-- Ejecutar con: docker exec -i crm_pgvector psql -U postgres -d claude < seed_migracion.sql

INSERT INTO cortafuego.publicaciones
  (titulo_interno, canal, asset_ig, caption, web_titulo, web_tags, estado, ig_post_id, publicado_en, aprobado_por, notas)
SELECT * FROM (VALUES
  (
    'Piquillín y Chañar — Dos leñas. Una sola brasa.',
    'ambos',
    'https://cortafuego.ar/publicaciones/Ploteo1_ig.jpg',
    $cap$Dos leñas. Una sola brasa.
Piquillín y chañar, de la Patagonia argentina.
El fuego te espera.

CORTAFUEGO · Asador Urbano · Ranelagh

#cortafuego #asadorurbano #fuego #leña #ranelagh$cap$,
    'Dos leñas. Una sola brasa.',
    ARRAY['Leña','El Fuego','Origen'],
    'publicada'::cortafuego.estado_publicacion,
    '18007479638868630',
    '2026-05-31'::timestamptz,
    'Fer',
    'Migrada desde CALENDARIO_CONTENIDO.md'
  ),
  (
    'Un sabor que nos define — carne / origen',
    'ambos',
    'https://cortafuego.ar/publicaciones/Ploteo2_ig.jpg',
    $cap$Un sabor que nos define.
Nuestra carne nace en La Adela, sur de La Pampa, a las puertas de la Patagonia.
Trazabilidad de origen. Calidad de exportación, estándar Cuota Hilton. Bienestar animal certificado por SENASA.
Del campo a nuestro fuego.

CORTAFUEGO · Asador Urbano · Ranelagh

#cortafuego #asadorurbano #carne #parrilla #ranelagh #berazategui$cap$,
    'Un sabor que nos define.',
    ARRAY['Carne','Origen','Trazabilidad'],
    'publicada'::cortafuego.estado_publicacion,
    '18013948613704463',
    '2026-05-31'::timestamptz,
    'Fer',
    'Migrada desde CALENDARIO_CONTENIDO.md'
  )
) AS nuevas(titulo_interno, canal, asset_ig, caption, web_titulo, web_tags, estado, ig_post_id, publicado_en, aprobado_por, notas)
WHERE NOT EXISTS (
  SELECT 1 FROM cortafuego.publicaciones p WHERE p.ig_post_id = nuevas.ig_post_id
);
