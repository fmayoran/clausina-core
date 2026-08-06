-- ClaUsina v2.0 / F6 — Invitaciones.
-- Fer (06/08): repartir invitaciones a clientes puntuales, con descuentos configurables, y poder
-- rastrear cada una unívocamente. Capacidad de plataforma, no un agregado de Cortafuego.
--
-- TRES TABLAS Y NO UNA. Es la decisión que sostiene todo lo demás:
--   beneficio  — QUÉ da (20%, gratis hasta 4). Una definición, muchas invitaciones.
--   invitacion — EL CÓDIGO: a quién se le mandó, cuándo vence, cuántos usos admite.
--   uso        — QUÉ RESERVA lo tomó y si finalmente vino.
-- Metido todo en una tabla, "¿cuánto costó la campaña?" y "¿cuántos volvieron?" dejan de tener
-- respuesta, que es justamente para lo que se reparten invitaciones.
--
-- LO QUE ESTA CAPACIDAD NO HACE: aplicar el descuento. ClaUsina no ve la factura. Emite, autoriza,
-- avisa y mide; la cuenta la hace una persona en el mostrador. Correrse de ahí mete a la
-- plataforma en un lugar donde equivocarse cuesta plata de verdad.
BEGIN;

-- ── Qué da ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contenido.beneficio (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id  uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  -- Tipo cerrado y valor numérico, NO texto libre: con texto libre nadie puede calcular después
  -- cuánto se regaló, y una invitación es un costo de adquisición o no es nada.
  tipo        text NOT NULL CHECK (tipo IN ('porcentaje', 'gratis_hasta', 'monto_fijo')),
  valor       numeric(12,2) NOT NULL CHECK (valor > 0),
  -- Restricciones de uso. Las de turno y día son las que más importan: una invitación que vale
  -- de lunes a jueves llena la noche floja; la misma un sábado regala margen sobre una mesa que
  -- se vendía sola. {dias:[1..7], turnos:[uuid], cantidad_min, cantidad_max}
  condiciones jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Qué hacer si la reserva se toma y la persona no aparece. Fer: depende del tipo de invitación,
  -- así que es del beneficio y no una regla de la plataforma.
  no_show     text NOT NULL DEFAULT 'liberar' CHECK (no_show IN ('liberar', 'quemar')),
  notas       text,
  activo      boolean NOT NULL DEFAULT true,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beneficio_negocio_ix ON contenido.beneficio (negocio_id, activo);

COMMENT ON COLUMN contenido.beneficio.tipo IS
  'porcentaje = % sobre el total · gratis_hasta = sin cargo hasta N cubiertos · monto_fijo = $ off';

-- ── El código ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contenido.invitacion (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id   uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  beneficio_id uuid NOT NULL REFERENCES contenido.beneficio(id) ON DELETE RESTRICT,
  -- ÚNICO EN TODA LA PLATAFORMA, no por negocio: el enlace /i/<codigo> tiene que poder resolverse
  -- sin que quien lo abre sepa de qué negocio es.
  codigo       text NOT NULL UNIQUE,
  -- A quién se le mandó. Texto libre porque muchas veces se manda a alguien que todavía no es
  -- cliente — que es justamente el punto de invitar.
  etiqueta     text,
  -- Si ya existe en la base del negocio. Opcional.
  cliente_id   uuid REFERENCES contenido.cliente(id) ON DELETE SET NULL,
  -- 1 = invitación personal. >1 = código compartido con cupo ("los primeros 20"). Es el mismo
  -- modelo con un tope arriba, y es la forma barata de repartir a una lista.
  usos_max     int NOT NULL DEFAULT 1 CHECK (usos_max >= 1),
  -- Denormalizado a propósito: se consulta en cada validación y se toca bajo lock.
  usos         int NOT NULL DEFAULT 0 CHECK (usos >= 0),
  -- El primero que la usa se la queda: reenviarla deja de servir sin pedirle a nadie que se
  -- identifique de antemano. Se completa sola en el primer canje.
  telefono_norm text,
  vence_en     date,
  anulada_en   timestamptz,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitacion_negocio_ix ON contenido.invitacion (negocio_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS invitacion_beneficio_ix ON contenido.invitacion (beneficio_id);

-- ── Quién la usó ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contenido.invitacion_uso (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitacion_id uuid NOT NULL REFERENCES contenido.invitacion(id) ON DELETE CASCADE,
  negocio_id    uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  -- Toda invitación se usa CONTRA UNA RESERVA, incluso la de quien llega sin reservar: en ese
  -- caso el salón carga la reserva a mano y le engancha la invitación. Decisión de Fer, y es lo
  -- que hace que el seguimiento quede completo en un solo lugar.
  reserva_id    uuid NOT NULL REFERENCES contenido.reserva(id) ON DELETE CASCADE,
  cliente_id    uuid REFERENCES contenido.cliente(id) ON DELETE SET NULL,
  -- tomada  = hay reserva, todavía no vino
  -- consumida = vino y se aplicó el descuento (lo marca una persona del salón)
  -- liberada = la reserva se canceló, o no vino y el beneficio dice liberar → no gastó el cupo
  -- perdida  = no vino y el beneficio dice quemar → gastó el cupo
  estado        text NOT NULL DEFAULT 'tomada'
                CHECK (estado IN ('tomada', 'consumida', 'liberada', 'perdida')),
  tomada_en     timestamptz NOT NULL DEFAULT now(),
  cerrada_en    timestamptz,
  notas         text
);
-- Una reserva no puede llevar dos invitaciones, y una invitación no se toma dos veces por la
-- misma reserva. Se hace acá y no en el código: es una regla que no puede depender de que
-- alguien se acuerde de chequearla.
CREATE UNIQUE INDEX IF NOT EXISTS invitacion_uso_reserva_ux ON contenido.invitacion_uso (reserva_id);
CREATE INDEX IF NOT EXISTS invitacion_uso_inv_ix ON contenido.invitacion_uso (invitacion_id, estado);
CREATE INDEX IF NOT EXISTS invitacion_uso_negocio_ix ON contenido.invitacion_uso (negocio_id, tomada_en DESC);

COMMIT;
