-- Material múltiple + comentarios por requerimiento, y cantidad de propuestas (19/06/2026).
-- Antes: una propuesta tenía un solo media_file_id y al aportarlo se disparaba la generación.
-- Ahora: Fer abre una ventana, aporta VARIOS materiales (con preview), deja comentarios para el
-- creativo y recién con el botón "Generar publicación" el requerimiento pasa a 'pendiente'.
-- El media_file_id de tg_briefs queda como fallback/back-compat (Telegram: responder con una foto).

-- Cantidad de propuestas a generar por pedido (antes fijo en 3-5). El cron la pasa al creativo.
ALTER TABLE contenido.solicitudes_propuesta ADD COLUMN IF NOT EXISTS cantidad int NOT NULL DEFAULT 5;

-- Nota general de Fer al creativo sobre el material aportado (la lee el pipeline al generar).
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS comentarios text;

-- Varios materiales (foto/video) por requerimiento. orden = secuencia para carrusel.
CREATE TABLE IF NOT EXISTS contenido.brief_material (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id   uuid NOT NULL REFERENCES contenido.tg_briefs(id) ON DELETE CASCADE,
  file_id    text NOT NULL,                 -- file_id de Telegram (token server-side al proxiar/descargar)
  media_type text NOT NULL DEFAULT 'photo', -- 'photo' | 'video'
  filename   text,
  orden      int NOT NULL DEFAULT 0,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brief_material_brief_idx ON contenido.brief_material (brief_id, orden);
