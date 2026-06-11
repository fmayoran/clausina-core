-- Migración multimarca — 2026-06-10
-- Objetivo: que la plataforma aísle el contexto de cada marca (multi-tenant).
-- Hoy SOLO contenido.piezas tiene proyecto_id; revisiones/media/programa_items
-- heredan por FK. Estas 6 tablas no cuelgan de ningún proyecto y mezclarían marcas:
--   programas, solicitudes_propuesta, tg_briefs, tg_pending, batch_runs, ig_metricas
-- Además: campo `unidad` en piezas (para Ardora: paseo|deportivo|residencial|distrito)
-- y alta de la 2da marca (Ardora) inactiva hasta terminar el onboarding.
-- Es aditiva (columnas nullable + backfill a Cortafuego) y no afecta los flujos actuales.

BEGIN;

-- 1) proyecto_id en las tablas hoy sin scope de marca
ALTER TABLE contenido.programas             ADD COLUMN IF NOT EXISTS proyecto_id uuid REFERENCES contenido.proyectos(id);
ALTER TABLE contenido.solicitudes_propuesta ADD COLUMN IF NOT EXISTS proyecto_id uuid REFERENCES contenido.proyectos(id);
ALTER TABLE contenido.tg_briefs             ADD COLUMN IF NOT EXISTS proyecto_id uuid REFERENCES contenido.proyectos(id);
ALTER TABLE contenido.tg_pending            ADD COLUMN IF NOT EXISTS proyecto_id uuid REFERENCES contenido.proyectos(id);
ALTER TABLE contenido.batch_runs            ADD COLUMN IF NOT EXISTS proyecto_id uuid REFERENCES contenido.proyectos(id);
ALTER TABLE contenido.ig_metricas           ADD COLUMN IF NOT EXISTS proyecto_id uuid REFERENCES contenido.proyectos(id);

-- 2) backfill: todo lo existente es de Cortafuego
DO $$
DECLARE cf uuid;
BEGIN
  SELECT id INTO cf FROM contenido.proyectos WHERE slug='cortafuego';
  UPDATE contenido.programas             SET proyecto_id=cf WHERE proyecto_id IS NULL;
  UPDATE contenido.solicitudes_propuesta SET proyecto_id=cf WHERE proyecto_id IS NULL;
  UPDATE contenido.tg_briefs             SET proyecto_id=cf WHERE proyecto_id IS NULL;
  UPDATE contenido.tg_pending            SET proyecto_id=cf WHERE proyecto_id IS NULL;
  UPDATE contenido.batch_runs            SET proyecto_id=cf WHERE proyecto_id IS NULL;
  UPDATE contenido.ig_metricas           SET proyecto_id=cf WHERE proyecto_id IS NULL;
END $$;

-- 3) índices para el filtrado por marca
CREATE INDEX IF NOT EXISTS idx_programas_proyecto   ON contenido.programas(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_proyecto ON contenido.solicitudes_propuesta(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_tgbriefs_proyecto    ON contenido.tg_briefs(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_tgpending_proyecto   ON contenido.tg_pending(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_batchruns_proyecto   ON contenido.batch_runs(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_igmetricas_proyecto  ON contenido.ig_metricas(proyecto_id);

-- 4) unidad de negocio en la pieza (Ardora). NULL en Cortafuego (negocio único).
--    Valores previstos: 'paseo' | 'deportivo' | 'residencial' | 'distrito'
ALTER TABLE contenido.piezas ADD COLUMN IF NOT EXISTS unidad text;

-- 5) alta de Ardora — INACTIVA hasta terminar el onboarding (no la levantan los crons)
INSERT INTO contenido.proyectos (id, slug, nombre, ig_handle, dominio_web, activo)
SELECT gen_random_uuid(), 'ardora', 'Ardora — Distrito', '@ardora.ar', 'ardora.ar', false
WHERE NOT EXISTS (SELECT 1 FROM contenido.proyectos WHERE slug='ardora');

COMMIT;
