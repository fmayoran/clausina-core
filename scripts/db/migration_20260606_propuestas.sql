-- Propuestas del creativo en la cola de requerimientos (06/06/2026).
-- El creativo propone qué publicar; cada propuesta dice qué material necesita.
-- Fer aporta material (Telegram respondiendo, o subiendo en el panel) -> pasa a 'pendiente'
-- y entra al circuito actual sin cambios. La supervisión manual antes de publicar queda igual.

-- tg_briefs gana: origen, título, qué material necesita, y el message_id de la propuesta en Telegram
-- (para vincular la respuesta con foto/video a la propuesta correcta). estado es text: 'propuesta' es válido.
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'fer';   -- 'fer' | 'creativo'
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS titulo text;
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS requiere_material text;
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS tg_msg_id bigint;

-- Cola de pedidos de propuestas: el panel inserta el pedido (con énfasis), un cron lo elabora
-- con el creativo (Claude headless) e inserta las propuestas resultantes en tg_briefs.
CREATE TABLE IF NOT EXISTS contenido.solicitudes_propuesta (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enfasis     text,
  estado      text NOT NULL DEFAULT 'pendiente',   -- pendiente | procesando | procesado | error
  resultado   text,                                 -- resumen de lo que generó el creativo
  creado_en   timestamptz NOT NULL DEFAULT now(),
  procesado_en timestamptz
);
INSERT INTO contenido.batch_runs (proceso, intervalo_s) VALUES ('propuestas', 180)
ON CONFLICT (proceso) DO UPDATE SET intervalo_s = EXCLUDED.intervalo_s;
