-- ClaUsina v2.0 / F6 — la tarjeta de confirmación.
-- Fer: al terminar la reserva por WhatsApp, mandar una imagen con los datos ya resueltos —
-- nombre, día, turno y el beneficio si lo hubo. Cierra el proceso con algo que la persona
-- muestra en la puerta, en vez de dejarle un chat con un código suelto.
--
-- Va como pedido y no como columna en `reserva` porque el render corre en el HOST (Playwright no
-- entra en la imagen Alpine del panel): el panel anota que hace falta y el worker la fabrica.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.tarjeta_req (
  reserva_id  uuid PRIMARY KEY REFERENCES contenido.reserva(id) ON DELETE CASCADE,
  negocio_id  uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  -- A dónde mandarla. Se guarda acá y no se deduce después: la reserva puede no tener teléfono
  -- si la cargó el salón, y esta tarjeta sólo tiene sentido si hay a quién mandársela.
  wa_id       text NOT NULL,
  url         text,
  estado      text NOT NULL DEFAULT 'pendiente'
              CHECK (estado IN ('pendiente', 'lista', 'error')),
  error       text,
  pedido_en   timestamptz NOT NULL DEFAULT now(),
  hecho_en    timestamptz
);
CREATE INDEX IF NOT EXISTS tarjeta_req_pend_ix ON contenido.tarjeta_req (pedido_en)
  WHERE estado = 'pendiente';

COMMIT;
