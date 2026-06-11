-- Migración: cortafuego.publicaciones (modelo viejo, 1 tabla) → contenido (modelo nuevo).
-- Cada publicación vieja → 1 pieza + 1 revisión (nro 1) + media (si tiene asset). Proyecto: cortafuego.
-- Idempotente: solo migra publicaciones cuyo token aún no exista en contenido.revisiones.
-- Ejecutar con: docker exec -i crm_pgvector psql -U postgres -d claude -v ON_ERROR_STOP=1 < migracion_contenido.sql

BEGIN;

-- Proyecto cortafuego (idempotente)
INSERT INTO contenido.proyectos (slug, nombre, ig_user_id, ig_handle, dominio_web)
VALUES ('cortafuego','Cortafuego — Asador Urbano','27632458043024661','@cortafuego.ar','cortafuego.ar')
ON CONFLICT (slug) DO NOTHING;

-- Mapa old_id → nuevos ids, solo de lo no migrado aún
CREATE TEMP TABLE _map ON COMMIT DROP AS
SELECT p.id AS old_id, gen_random_uuid() AS pieza_id, gen_random_uuid() AS rev_id
FROM cortafuego.publicaciones p
WHERE NOT EXISTS (SELECT 1 FROM contenido.revisiones r WHERE r.token = p.token);

-- Piezas
INSERT INTO contenido.piezas (id, proyecto_id, titulo_interno, notas, creado_en)
SELECT m.pieza_id,
       (SELECT id FROM contenido.proyectos WHERE slug='cortafuego'),
       p.titulo_interno, p.notas, p.creado_en
FROM _map m JOIN cortafuego.publicaciones p ON p.id = m.old_id;

-- Revisiones (el trigger sync_pieza setea piezas.revision_vigente y piezas.estado)
INSERT INTO contenido.revisiones
  (id, pieza_id, nro, estado, canal, caption, web_titulo, web_copy, web_tags,
   token, motivo_rechazo, aprobado_por, aprobado_en, ig_post_id, publicado_en, creado_en)
SELECT m.rev_id, m.pieza_id, 1,
       p.estado::text::contenido.estado_pub,
       p.canal::contenido.canal,
       p.caption, p.web_titulo, p.web_copy, p.web_tags,
       p.token, p.motivo_rechazo, p.aprobado_por, p.aprobado_en,
       p.ig_post_id, p.publicado_en, p.creado_en
FROM _map m JOIN cortafuego.publicaciones p ON p.id = m.old_id;

-- Media (solo si hay asset; orden 1)
INSERT INTO contenido.media (pieza_id, orden, tipo, url, poster_url)
SELECT m.pieza_id, 1,
       COALESCE(p.tipo_media,'image')::contenido.tipo_media,
       p.asset_ig, p.poster_url
FROM _map m JOIN cortafuego.publicaciones p ON p.id = m.old_id
WHERE p.asset_ig IS NOT NULL;

COMMIT;
