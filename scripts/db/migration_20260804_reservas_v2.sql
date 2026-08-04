-- ClaUsina v2.0 / F4b — la reserva es por TURNO COMPLETO y la capacidad tiene unidad.
-- Correcciones de Fer (04/08), sobre la primera versión de reservas:
--
--   1. "La reserva debe ser por turno completo, debemos hacer el calendario tan atómico como la
--      mínima cantidad de tiempo que permitimos reservar." → el turno ES la unidad de tiempo.
--      La columna `hora` sobra: si alguien quiere reservar por hora, define turnos de una hora.
--      Se elimina en vez de dejarla mintiendo. La tabla tiene 0 filas (se creó hoy).
--   2. "La tolerancia se toma desde el inicio del turno" → se deduce de lo anterior.
--   3. La capacidad se mide en una UNIDAD configurable por negocio (cubiertos, personas,
--      canchas…), así que `personas` deja de ser el nombre correcto: pasa a `cantidad`.
BEGIN;

-- 1 y 2) La hora concreta desaparece: la reserva ocupa el turno.
ALTER TABLE contenido.reserva DROP COLUMN IF EXISTS hora;

-- 3) La cantidad se expresa en la unidad del negocio, no en personas.
ALTER TABLE contenido.reserva RENAME COLUMN personas TO cantidad;
ALTER TABLE contenido.reserva RENAME CONSTRAINT reserva_personas_check TO reserva_cantidad_check;

-- Índice de ocupación: el nombre viejo seguía hablando de personas.
DROP INDEX IF EXISTS contenido.reserva_ocupacion_ix;
CREATE INDEX IF NOT EXISTS reserva_ocupacion_ix ON contenido.reserva (negocio_id, fecha, turno_id)
  WHERE estado IN ('solicitada','confirmada','cumplida');

-- 4) Config: personas_min/max pasan a cantidad_min/max y aparece la unidad.
UPDATE contenido.negocio_capacidad
   SET config = (config - 'personas_min' - 'personas_max')
              || jsonb_build_object(
                   'cantidad_min', COALESCE(config->'personas_min', to_jsonb(1)),
                   'cantidad_max', COALESCE(config->'personas_max', to_jsonb(12)),
                   'unidad',       COALESCE(config->'unidad', to_jsonb('personas'::text))),
       actualizado_en = now()
 WHERE capacidad = 'reservas';

COMMIT;
