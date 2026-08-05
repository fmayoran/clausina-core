-- ClaUsina v2.0 / F5c — nombre público del turno.
-- Fer (05/08): "no deberíamos visualizar el nombre clave del turno y la capacidad, podríamos
-- agregar un nombre general como mediodía, noche primer turno y noche segundo turno".
--
-- El `nombre` que ya existe es la CLAVE con la que el negocio identifica el turno adentro
-- ("Noche F. Semana T1"): tiene que ser distinguible y por eso termina siendo críptico. El
-- nombre público es una DESCRIPCIÓN para el cliente final y por lo tanto puede repetirse — dos
-- turnos de días distintos pueden llamarse los dos "Noche primer turno".
BEGIN;

ALTER TABLE contenido.turno ADD COLUMN IF NOT EXISTS nombre_publico text;

COMMENT ON COLUMN contenido.turno.nombre_publico IS
  'Cómo se le muestra el turno al cliente final. Puede repetirse entre turnos. '
  'NULL = se usa `nombre`, que es la clave interna.';

-- Semilla para los turnos de Cortafuego, según lo que describió Fer.
UPDATE contenido.turno t SET nombre_publico = CASE
    WHEN t.nombre = 'Mediodía'           THEN 'Mediodía'
    WHEN t.nombre = 'Noche Semana'       THEN 'Noche'
    WHEN t.nombre = 'Noche F. Semana T1' THEN 'Noche, primer turno'
    WHEN t.nombre = 'Noche F.Semana T2'  THEN 'Noche, segundo turno'
  END
 WHERE t.negocio_id = (SELECT id FROM contenido.negocios WHERE slug = 'cortafuego')
   AND t.nombre IN ('Mediodía','Noche Semana','Noche F. Semana T1','Noche F.Semana T2');

COMMIT;
