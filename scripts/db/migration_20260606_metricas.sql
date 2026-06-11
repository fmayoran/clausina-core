-- Métricas de Instagram cacheadas por pieza publicada (06/06/2026).
-- El panel refresca periódicamente (cada 30 min) leyendo insights de graph.instagram.com con el
-- token de la cuenta (mismo que publica; tiene permiso de insights) y las muestra en la columna Publicada.
-- También quedan disponibles para el futuro "modo proactivo" del creativo (proponer según lo que funcionó).
CREATE TABLE IF NOT EXISTS contenido.ig_metricas (
  ig_post_id          text PRIMARY KEY,
  views               int,
  reach               int,
  likes               int,
  comments            int,
  saved               int,
  shares              int,
  total_interactions  int,
  actualizado_en      timestamptz NOT NULL DEFAULT now()
);
