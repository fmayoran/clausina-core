-- ClaUsina v2.0 — F4: reservas. Segunda capacidad del grupo OPERACIÓN.
-- Especificación de Fer (04/08): configurador por negocio + turnos + bloqueos + reserva
-- identificando al cliente + vista calendarizada.
--
-- ESTE ES EL MÓDULO DONDE LA CORRECTITUD IMPORTA DE VERDAD. La comunicación se apoya en la
-- compuerta humana y un error se atrapa antes de salir; acá una mesa duplicada ya ocurrió.
-- Por eso los límites viven en la base y el conteo se hace bajo lock, no consultando y después
-- insertando (ver reservarConLock en panel/db.js).
BEGIN;

-- ── Turnos: las ventanas de tiempo en que se puede reservar ──────────────────
CREATE TABLE IF NOT EXISTS contenido.turno (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  nombre      text NOT NULL,                    -- 'Mediodía', 'Noche'
  -- Se cuenta en PERSONAS, no en reservas: para una parrilla son cubiertos y para una cancha
  -- cada reserva ocupa 1. Un solo campo sirve a los dos casos sin configuración extra.
  capacidad   int  NOT NULL CHECK (capacidad > 0),
  dias        smallint[] NOT NULL,              -- ISO: 1=lunes … 7=domingo (coincide con isodow)
  hora_desde  time NOT NULL,
  hora_hasta  time NOT NULL,
  activo      boolean NOT NULL DEFAULT true,
  orden       int NOT NULL DEFAULT 0,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turno_horario CHECK (hora_desde < hora_hasta),
  CONSTRAINT turno_dias_validos CHECK (
    cardinality(dias) > 0 AND dias <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);
CREATE INDEX IF NOT EXISTS turno_negocio_ix ON contenido.turno (negocio_id, orden);

-- ── Bloqueos: la excepción (feriado, evento privado, mantenimiento) ──────────
CREATE TABLE IF NOT EXISTS contenido.bloqueo (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  fecha      date NOT NULL,
  turno_id   uuid REFERENCES contenido.turno(id) ON DELETE CASCADE,   -- NULL = el día entero
  motivo     text,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bloqueo_negocio_ix ON contenido.bloqueo (negocio_id, fecha);
-- Un bloqueo por día entero y uno por turno son cosas distintas; no repetir ninguno de los dos.
CREATE UNIQUE INDEX IF NOT EXISTS bloqueo_dia_ux
  ON contenido.bloqueo (negocio_id, fecha) WHERE turno_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bloqueo_turno_ux
  ON contenido.bloqueo (negocio_id, fecha, turno_id) WHERE turno_id IS NOT NULL;

-- ── Reservas ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contenido.reserva (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  -- "Se deberá identificar al cliente": una reserva sin cliente no sirve para nada.
  -- ON DELETE RESTRICT y no CASCADE: borrar a un cliente no puede hacer desaparecer en silencio
  -- una reserva que el negocio tiene agendada para mañana.
  cliente_id  uuid NOT NULL REFERENCES contenido.cliente(id) ON DELETE RESTRICT,
  turno_id    uuid NOT NULL REFERENCES contenido.turno(id) ON DELETE RESTRICT,
  fecha       date NOT NULL,
  hora        time NOT NULL,                    -- la tolerancia se cuenta desde acá
  personas    int  NOT NULL CHECK (personas > 0),
  estado      text NOT NULL DEFAULT 'confirmada'
                CHECK (estado IN ('solicitada','confirmada','cancelada','cumplida','no_show')),
  canal       text NOT NULL DEFAULT 'panel'
                CHECK (canal IN ('panel','whatsapp','landing','agente')),
  agente_id   text,                             -- qué agente externo la creó, si fue uno
  notas       text,
  ref_externa text,                             -- id en el backoffice del negocio
  creado_en   timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reserva_negocio_fecha_ix ON contenido.reserva (negocio_id, fecha, turno_id);
CREATE INDEX IF NOT EXISTS reserva_cliente_ix ON contenido.reserva (cliente_id);
-- El conteo de ocupación sólo mira las que pesan; este índice es el que usa esa consulta.
CREATE INDEX IF NOT EXISTS reserva_ocupacion_ix ON contenido.reserva (negocio_id, fecha, turno_id)
  WHERE estado IN ('solicitada','confirmada','cumplida');

CREATE OR REPLACE FUNCTION contenido.reserva_touch() RETURNS trigger AS $$
BEGIN NEW.actualizado_en := now(); RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS reserva_touch_tg ON contenido.reserva;
CREATE TRIGGER reserva_touch_tg BEFORE UPDATE ON contenido.reserva
  FOR EACH ROW EXECUTE FUNCTION contenido.reserva_touch();

COMMIT;
