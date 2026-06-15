-- Nuevo estado para revisiones que fueron 'publicada' pero quedaron superadas por una
-- revisión más nueva (corrección re-publicada). Evita que el feed de novedades (filtra
-- estado='publicada') muestre versiones viejas duplicadas. Aditivo, no afecta lo existente.
ALTER TYPE contenido.estado_pub ADD VALUE IF NOT EXISTS 'reemplazada';
