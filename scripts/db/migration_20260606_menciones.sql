-- Menciones entrantes (06/06/2026): cuando alguien etiqueta a @cortafuego.ar en su post,
-- entra a la cola de requerimientos (origen='mencion', estado='propuesta') para que Fer decida:
-- "Generar publicación" (la activa y entra al circuito) o "Descartar". Fuente: edge /tags de la Graph API,
-- que el panel poolea cada 30 min. (Menciones en comentarios/historias requerirían webhooks — pendiente.)
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS ref_externa text;  -- id externo (ig media id) para dedupe
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS enlace text;       -- permalink de la mención
CREATE INDEX IF NOT EXISTS tg_briefs_ref_externa_idx ON contenido.tg_briefs(ref_externa);
