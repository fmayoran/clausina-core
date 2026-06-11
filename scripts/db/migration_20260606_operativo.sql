-- Revisiones operativas 06/06/2026:
--  1) numeración de piezas (CF-NNNN) para seguimiento
--  2) vínculo brief -> pieza (correlación requerimiento ↔ publicación)
--  3) tabla de latido de procesos batch (para la barra de status del panel)

-- 1) Numeración secuencial de piezas -----------------------------------------
CREATE SEQUENCE IF NOT EXISTS contenido.pieza_numero_seq;
ALTER TABLE contenido.piezas ADD COLUMN IF NOT EXISTS numero int;
-- backfill por orden de creación (estable)
WITH ord AS (SELECT id, row_number() OVER (ORDER BY creado_en, id) AS rn FROM contenido.piezas WHERE numero IS NULL)
UPDATE contenido.piezas pz SET numero = ord.rn FROM ord WHERE pz.id = ord.id;
SELECT setval('contenido.pieza_numero_seq', GREATEST(COALESCE((SELECT max(numero) FROM contenido.piezas),0),1));
ALTER TABLE contenido.piezas ALTER COLUMN numero SET DEFAULT nextval('contenido.pieza_numero_seq');

-- 2) Vínculo brief -> pieza ---------------------------------------------------
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS pieza_id uuid REFERENCES contenido.piezas(id) ON DELETE SET NULL;

-- 3) Latido de procesos batch -------------------------------------------------
CREATE TABLE IF NOT EXISTS contenido.batch_runs (
  proceso     text PRIMARY KEY,          -- 'correccion' | 'ingesta_briefs' | 'resumen_diario'
  last_run    timestamptz NOT NULL DEFAULT now(),
  last_msg    text,                       -- p.ej. 'sin rechazos' / 'rechazos=1 -> procesado'
  intervalo_s int                         -- cada cuánto corre (para estimar la próxima)
);
INSERT INTO contenido.batch_runs (proceso, intervalo_s) VALUES
  ('correccion', 300), ('ingesta_briefs', 120)
ON CONFLICT (proceso) DO UPDATE SET intervalo_s = EXCLUDED.intervalo_s;
