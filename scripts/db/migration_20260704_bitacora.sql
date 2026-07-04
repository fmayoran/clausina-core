-- Bitácora de generación por revisión: relato de alto nivel que escribe el creativo
-- (qué entendió, cómo lo resolvió, qué herramientas usó) para que Fer revise cómo se
-- armó cada pieza desde el panel (botón "Cómo se generó" en pendiente de aprobación).
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS bitacora text;
