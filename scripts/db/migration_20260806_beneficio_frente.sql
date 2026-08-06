-- ClaUsina v2.0 / F6 — el frente impreso de una invitación.
-- Fer: "podríamos indicar que en el frente ponga la imagen G-0006 que creamos en el panel gráfica
-- y en el dorso los datos de la invitación".
--
-- Va en el BENEFICIO y no en cada invitación: una campaña se imprime toda con el mismo frente, y
-- elegirlo en un desplegable cada vez que se manda a la imprenta no es indicarlo — es acordarse.
BEGIN;

ALTER TABLE contenido.beneficio
  -- ON DELETE SET NULL: si la pieza se borra, la campaña sigue existiendo y cae al frente por
  -- defecto. Perder el beneficio entero por borrar un archivo de diseño sería absurdo.
  ADD COLUMN IF NOT EXISTS frente_pieza_id uuid REFERENCES contenido.piezas(id) ON DELETE SET NULL;

COMMENT ON COLUMN contenido.beneficio.frente_pieza_id IS
  'Pieza de comunicación que va al frente del impreso. NULL = logo sobre el color del negocio.';

COMMIT;
