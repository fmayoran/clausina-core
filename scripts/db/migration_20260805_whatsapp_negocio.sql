-- ClaUsina v2.0 / F5d — WhatsApp propio por negocio.
-- Decisión de Fer (05/08): el cliente final habla con el NÚMERO DEL NEGOCIO, no con el de
-- ClaUsina. El de ClaUsina queda para la conversación con el operador, que ya funciona.
--
-- POR QUÉ, EN UNA LÍNEA: la calificación de calidad y el nombre visible son POR NÚMERO. Con un
-- número compartido, un negocio que junta reportes se lleva puestos a todos los demás, y el
-- comensal recibe un mensaje de "ClaUsina" en vez del nombre del lugar donde reservó.
--
-- Sigue la regla de secretos de la plataforma: los IDs no-secretos en claro (como ig_user_id) y
-- el token cifrado (AES-256-GCM), write-only — nunca vuelve al navegador.
BEGIN;

ALTER TABLE contenido.negocio_perfil
  ADD COLUMN IF NOT EXISTS wa_phone_id  text,   -- id del número en la Cloud API
  ADD COLUMN IF NOT EXISTS wa_waba_id   text,   -- cuenta de WhatsApp Business que lo contiene
  ADD COLUMN IF NOT EXISTS wa_token_enc text;   -- token del usuario del sistema, cifrado

COMMENT ON COLUMN contenido.negocio_perfil.wa_waba_id IS
  'Las PLANTILLAS son por cuenta, no por número: sin el WABA no se puede verificar si las que '
  'necesitamos están aprobadas.';

COMMIT;
