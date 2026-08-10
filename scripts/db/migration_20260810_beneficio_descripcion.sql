-- ClaUsina — el beneficio puede llevar una descripción, y sale impresa en la invitación.
--
-- El nombre del beneficio ("Primeros Clientes") dice para quién es, y el texto calculado ("15% de
-- descuento") dice cuánto. Falta el medio: qué incluye, qué no, cómo se usa. Eso hoy se escribe en
-- 'notas', que es interno y no se imprime, así que terminaba explicándose a mano en el mostrador.
BEGIN;
ALTER TABLE contenido.beneficio ADD COLUMN IF NOT EXISTS descripcion text;
COMMENT ON COLUMN contenido.beneficio.descripcion IS
  'Detalle del beneficio que se imprime en la invitación, debajo del título. Público.';
COMMIT;
