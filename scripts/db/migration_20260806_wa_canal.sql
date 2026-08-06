-- ClaUsina v2.0 / F5f — el canal de WhatsApp como producto configurable.
-- Fer (06/08): un configurador del canal — número, saludo, qué capacidades ofrece el bot, y un
-- inbox para lo que no encaja en ninguna operación.
--
-- La bitácora se diseñó para UN número (el de ClaUsina) y por eso no guarda de qué negocio es
-- cada mensaje. Con un número por negocio eso ya no alcanza: sin `negocio_id` no hay inbox
-- posible, porque no se sabe a quién mostrarle qué.
BEGIN;

ALTER TABLE contenido.whatsapp_mensaje
  ADD COLUMN IF NOT EXISTS negocio_id uuid REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  -- Para el inbox: un entrante sin atender es lo que hay que mirar.
  ADD COLUMN IF NOT EXISTS atendido boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN contenido.whatsapp_mensaje.negocio_id IS
  'De qué negocio es la conversación. NULL = el número de ClaUsina, o sea el canal con el operador.';

CREATE INDEX IF NOT EXISTS whatsapp_mensaje_negocio_ix
  ON contenido.whatsapp_mensaje (negocio_id, creado_en DESC);
-- Lo que el inbox consulta todo el tiempo: entrantes sin atender de un negocio.
CREATE INDEX IF NOT EXISTS whatsapp_mensaje_pendientes_ix
  ON contenido.whatsapp_mensaje (negocio_id, wa_id) WHERE direccion = 'entrante' AND NOT atendido;

-- Los mensajes de clientes de negocio que ya había son de Cortafuego: es el único negocio con
-- número propio. Se completan para no perderlos del inbox.
UPDATE contenido.whatsapp_mensaje
   SET negocio_id = (SELECT id FROM contenido.negocios WHERE slug = 'cortafuego')
 WHERE negocio_id IS NULL
   AND estado IN ('cliente_de_negocio', 'atendido_reservas');

COMMIT;
