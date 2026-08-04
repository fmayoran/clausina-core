-- ClaUsina v2.0 — F5: el puente del call to action.
-- Una pieza deja de terminar en el posteo y pasa a llevar una ACCIÓN. Alguien la usa, y lo que
-- hace queda atribuido a la pieza que lo produjo. Ver core/planes/V2.md.
--
-- Lo que no es obvio y es el grueso de la fase: hasta hoy una reserva sólo se podía crear desde
-- adentro del panel, con sesión. El puente exige que la cree el CLIENTE FINAL, que no tiene
-- usuario ni va a tenerlo. Eso obliga a una superficie PÚBLICA, y es la misma puerta que después
-- va a usar el catálogo de F7 con otra llave.
BEGIN;

-- ── La acción que lleva una pieza ────────────────────────────────────────────
-- { "capacidad": "reservas", "etiqueta": "Reservá tu mesa", "params": {...} }
ALTER TABLE contenido.piezas ADD COLUMN IF NOT EXISTS accion jsonb;

-- ── Enlaces ─────────────────────────────────────────────────────────────────
-- Un enlace corto por acción publicada. Vive separado de la pieza porque también hace falta
-- para acciones sin pieza (un enlace suelto en la bio, un QR en la mesa).
CREATE TABLE IF NOT EXISTS contenido.accion_link (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  pieza_id   uuid REFERENCES contenido.piezas(id) ON DELETE SET NULL,
  token      text NOT NULL UNIQUE,          -- lo que va en la URL
  capacidad  text NOT NULL DEFAULT 'reservas',
  etiqueta   text,
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accion_link_negocio_ix ON contenido.accion_link (negocio_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS accion_link_pieza_ix ON contenido.accion_link (pieza_id);

-- ── Atribución ──────────────────────────────────────────────────────────────
-- Dos pasos del embudo: se abrió el enlace, y se completó la acción. Sin el primero no se puede
-- decir "de 100 que entraron reservaron 7", que es la métrica que justifica todo esto.
CREATE TABLE IF NOT EXISTS contenido.accion_click (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id    uuid NOT NULL REFERENCES contenido.accion_link(id) ON DELETE CASCADE,
  negocio_id uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  -- NO se guarda la IP: para contar visitas alcanza un hash, y una IP es un dato personal más
  -- que no necesitamos tener.
  ip_hash    text,
  referer    text,
  reserva_id uuid REFERENCES contenido.reserva(id) ON DELETE SET NULL,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  completado_en timestamptz
);
CREATE INDEX IF NOT EXISTS accion_click_link_ix ON contenido.accion_click (link_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS accion_click_negocio_ix ON contenido.accion_click (negocio_id, creado_en DESC);

-- La reserva recuerda de qué enlace salió. Es la mitad que permite ir de la reserva a la pieza;
-- accion_click.reserva_id es la que permite ir al revés.
ALTER TABLE contenido.reserva
  ADD COLUMN IF NOT EXISTS link_id uuid REFERENCES contenido.accion_link(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS reserva_link_ix ON contenido.reserva (link_id);

COMMIT;
