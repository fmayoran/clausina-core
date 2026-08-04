-- ClaUsina v2.0 / F4c — el turno puede redefinir el máximo por reserva.
-- Fer (04/08): "que la cantidad máxima sea genérica, pero que luego se pueda redefinir en el
-- turno. De esta manera el turno hereda la capacidad máxima global, pero luego permite cambiarla
-- específicamente para ese turno."
--
-- NULL = hereda el `cantidad_max` de la configuración del negocio. Es la forma de expresar
-- "heredado" sin duplicar el valor: si mañana cambia el general, los turnos que no lo pisaron
-- siguen al día solos.
BEGIN;

ALTER TABLE contenido.turno
  ADD COLUMN IF NOT EXISTS cantidad_max int
    CONSTRAINT turno_cantidad_max_positiva CHECK (cantidad_max IS NULL OR cantidad_max > 0);

COMMENT ON COLUMN contenido.turno.cantidad_max IS
  'Máximo por reserva en este turno. NULL = hereda el de la configuración del negocio.';

COMMIT;
