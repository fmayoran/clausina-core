-- Migración pantallas (programación multi-proyecto) — 2026-06-12
-- La pantalla es un activo COMPARTIDO del paseo: un programa mezcla avisos aprobados de
-- distintos proyectos (Cortafuego + Ardora + futuros). Por eso los `programas` dejan de
-- colgar de `proyecto_id` y pasan a colgar de una `pantalla`. La aprobación de avisos sigue
-- siendo por marca (piezas.proyecto_id), pero la programación es a nivel pantalla.

BEGIN;

-- 1) entidad pantalla (hoy una: la del Paseo Ardora, con su player VNNOX y su resolución)
CREATE TABLE IF NOT EXISTS contenido.pantallas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  nombre text NOT NULL,
  vnnox_player_ids text[] DEFAULT '{}',   -- player(s) de VNNOX de ESTA pantalla
  ancho int,                              -- resolución real del LED (pendiente de confirmar)
  alto int,
  activo boolean DEFAULT true,
  creado_en timestamptz DEFAULT now()
);

INSERT INTO contenido.pantallas (slug, nombre, vnnox_player_ids)
SELECT 'paseo-ardora', 'Pantalla Paseo Ardora', ARRAY['dba8454dfe6c5a6d593893754693e04a']
WHERE NOT EXISTS (SELECT 1 FROM contenido.pantallas WHERE slug='paseo-ardora');

-- 2) programas pasan a colgar de la pantalla
ALTER TABLE contenido.programas ADD COLUMN IF NOT EXISTS pantalla_id uuid REFERENCES contenido.pantallas(id);
UPDATE contenido.programas SET pantalla_id = (SELECT id FROM contenido.pantallas WHERE slug='paseo-ardora')
  WHERE pantalla_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_programas_pantalla ON contenido.programas(pantalla_id);

-- 3) sacar el scoping viejo por proyecto (los programas ya no son por marca)
DROP INDEX IF EXISTS contenido.idx_programas_proyecto;
ALTER TABLE contenido.programas DROP COLUMN IF EXISTS proyecto_id;

COMMIT;
