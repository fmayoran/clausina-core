-- Onboarding por invitación: el admin carga lo mínimo, la persona completa el resto.
--
-- Antes el admin tenía que inventar una contraseña y tipear el WhatsApp de otro de memoria.
-- Ahora carga nombre, email y negocios; el sistema manda la invitación; y en el primer ingreso
-- la persona completa sus propios datos de contacto.
--
-- NO se agrega un campo para el chat de Telegram: no es un dato que la persona conozca (es un
-- número interno que Telegram asigna y no se ve en la app). Vincular Telegram se hace al revés
-- — la persona le escribe al bot y el bot asocia el chat — y eso es un mecanismo aparte.

ALTER TABLE contenido.usuario
  ADD COLUMN IF NOT EXISTS cargo                text,
  ADD COLUMN IF NOT EXISTS perfil_completado_en timestamptz,
  ADD COLUMN IF NOT EXISTS invitado_en          timestamptz;

-- Los usuarios que ya existían no pasan por el onboarding: si no, al entrar quedarían
-- atrapados en la pantalla de completar perfil.
UPDATE contenido.usuario
   SET perfil_completado_en = now()
 WHERE perfil_completado_en IS NULL;

COMMENT ON COLUMN contenido.usuario.cargo IS
  'Qué hace la persona en el negocio. Lo completa ella en su primer ingreso.';
COMMENT ON COLUMN contenido.usuario.perfil_completado_en IS
  'NULL = todavía no completó el onboarding; el panel lo manda a mi-cuenta antes de dejarlo pasar.';
COMMENT ON COLUMN contenido.usuario.invitado_en IS
  'Cuándo se le mandó la invitación por mail. Sirve para reenviarla y para saber si nunca entró.';
