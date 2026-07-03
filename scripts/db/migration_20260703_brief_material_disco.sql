-- Material aportado (propuestas y rechazos) pasa de Telegram al media store en disco.
-- Motivo: el Bot API de Telegram descarga archivos de hasta 20MB (getFile), así que
-- los videos grandes que sí se pueden SUBIR (sendDocument, 50MB) no se pueden recuperar
-- para procesarlos. Ahora se guardan en /app/media y se leen del volumen directo.
ALTER TABLE contenido.brief_material ADD COLUMN IF NOT EXISTS media_path text;
ALTER TABLE contenido.brief_material ALTER COLUMN file_id DROP NOT NULL;
