-- Normalización de números de WhatsApp.
--
-- El problema, encontrado en datos reales antes de conectar nada: la misma línea estaba cargada
-- de tres formas distintas (`+5491150466474`, `+541150466474`, `5491161735082`). WhatsApp entrega
-- el remitente en UN solo formato canónico, así que una búsqueda literal le habría dicho
-- "no tenés acceso" a alguien que sí lo tiene, sin explicación visible.
--
-- Guardamos lo que la persona escribió (`whatsapp`, para mostrar) y aparte la forma normalizada.
-- La COMPARACIÓN se hace por los últimos 10 dígitos: así el con-9, el sin-9, el con-+ y el
-- sin-código-de-país caen todos en el mismo casillero. Ver panel/telefono.js.

ALTER TABLE contenido.usuario
  ADD COLUMN IF NOT EXISTS whatsapp_norm text;

-- Índice sobre la clave real de búsqueda, no sobre la columna entera.
CREATE INDEX IF NOT EXISTS idx_usuario_wa_clave
  ON contenido.usuario (right(whatsapp_norm, 10))
  WHERE whatsapp_norm IS NOT NULL;

COMMENT ON COLUMN contenido.usuario.whatsapp_norm IS
  'Número en formato internacional sin símbolos. Lo escribe el panel (telefono.js). Se compara por los últimos 10 dígitos.';
