-- Bitácora de WhatsApp.
--
-- Todo lo que entra y sale queda registrado, incluso lo que se rechaza por no estar autorizado:
-- cuando algo no funcione, la primera pregunta va a ser "¿llegó el mensaje?" y sin esto no hay
-- forma de contestarla. Meta no guarda historial accesible.

CREATE TABLE IF NOT EXISTS contenido.whatsapp_mensaje (
  id           bigserial PRIMARY KEY,
  direccion    text        NOT NULL,          -- 'entrante' | 'saliente'
  wa_id        text,                          -- número del interlocutor, como lo manda Meta
  usuario_id   uuid REFERENCES contenido.usuario(id) ON DELETE SET NULL,
  mensaje_id   text,                          -- id de Meta, sirve para no procesar dos veces
  tipo         text,                          -- text | image | audio | button | ...
  texto        text,
  crudo        jsonb,                         -- el payload entero, para poder depurar de verdad
  estado       text,                          -- 'recibido' | 'sin_usuario' | 'enviado' | 'error'
  creado_en    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_msg_creado ON contenido.whatsapp_mensaje (creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_usuario ON contenido.whatsapp_mensaje (usuario_id, creado_en DESC);
-- Meta reintenta la entrega si tardamos en responder: el mismo mensaje puede llegar dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_unico ON contenido.whatsapp_mensaje (mensaje_id)
  WHERE mensaje_id IS NOT NULL AND direccion = 'entrante';

COMMENT ON TABLE contenido.whatsapp_mensaje IS
  'Bitácora de WhatsApp, entrante y saliente. La poda db_backup.sh junto con job_runs.';
