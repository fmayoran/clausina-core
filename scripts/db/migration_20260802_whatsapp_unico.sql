-- Un número de WhatsApp no puede estar en dos usuarios.
--
-- Pasó de verdad: dos usuarios tenían cargada la misma línea (una con el 9 y otra sin él, por
-- eso no se veía). Cuando llegue un mensaje de ese número el sistema no puede saber de quién es.
--
-- La comparación va por los últimos 10 dígitos, igual que la búsqueda: si sólo miráramos el
-- string completo, `+549...` y `+54...` pasarían como distintos y el problema volvería.
--
-- Esto es la garantía dura. El panel además chequea antes de guardar para dar un mensaje
-- entendible en vez de un error de base.

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuario_wa_unico
  ON contenido.usuario (right(whatsapp_norm, 10))
  WHERE whatsapp_norm IS NOT NULL;

COMMENT ON INDEX contenido.idx_usuario_wa_unico IS
  'Un número, un usuario. Si alguien deja de usar una línea, hay que vaciarle el campo para liberarla.';
