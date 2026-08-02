-- Definir contraseña sin haber entrado nunca.
--
-- El agujero que cierra: la contraseña sólo se podía definir DESDE ADENTRO del panel, así que
-- quien no quisiera usar Google no tenía forma de entrar la primera vez. Círculo cerrado.
-- Ahora la invitación lleva un enlace de un solo uso para definirla, y el mismo mecanismo
-- resuelve el "olvidé mi contraseña".
--
-- Guardamos el HASH del token, no el token: si alguien lee la base, no puede usarlos.

ALTER TABLE contenido.usuario
  ADD COLUMN IF NOT EXISTS token_hash   text,
  ADD COLUMN IF NOT EXISTS token_expira timestamptz;

CREATE INDEX IF NOT EXISTS idx_usuario_token ON contenido.usuario (token_hash)
  WHERE token_hash IS NOT NULL;

COMMENT ON COLUMN contenido.usuario.token_hash IS
  'SHA-256 del token de un solo uso para definir contraseña. Se borra al usarlo.';
COMMENT ON COLUMN contenido.usuario.token_expira IS
  'Vencimiento del token. La invitación dura 7 días; el "olvidé mi contraseña", 1 hora.';
