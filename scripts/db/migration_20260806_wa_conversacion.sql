-- ClaUsina v2.0 / F5e — reservar por WhatsApp.
-- Fer (06/08): un canal alternativo a la página. La ventaja que señaló es real: como el cliente
-- INICIA la conversación, estamos dentro de la ventana de 24 h y podemos contestarle sin
-- plantillas — así se puede probar el circuito antes de que Meta apruebe nada.
--
-- Lo que la ventana NO cambia es quién aprueba: la reserva sigue entrando como `solicitada` salvo
-- que el negocio active auto_confirmar. Poder avisar no es lo mismo que poder decidir.
--
-- Una conversación de WhatsApp es un ida y vuelta sin estado: cada mensaje llega solo. Para
-- armar una reserva hacen falta cuatro datos y cuatro turnos de conversación, así que hay que
-- recordar dónde quedó cada uno.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.wa_conversacion (
  negocio_id     uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  wa_id          text NOT NULL,              -- el teléfono del cliente, como lo manda Meta
  paso           text NOT NULL,              -- en qué punto del flujo está
  datos          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- lo que ya eligió
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negocio_id, wa_id)
);

-- Para la poda: una conversación vieja no se retoma, se empieza de nuevo.
CREATE INDEX IF NOT EXISTS wa_conversacion_viejas_ix
  ON contenido.wa_conversacion (actualizado_en);

COMMENT ON TABLE contenido.wa_conversacion IS
  'Dónde quedó cada cliente en el flujo de reserva por WhatsApp. Se descarta sola a los 30 min: '
  'retomar un flujo de ayer con la fecha que eligió ayer sería peor que volver a empezar.';

COMMIT;
