-- ClaUsina v2.0 / F6 — corrección: el frente sale de GRÁFICA, no de las piezas de comunicación.
-- Fer: "en verdad tiene que apuntar a las piezas del panel de gráfica".
--
-- La gráfica no vive en contenido.piezas: tiene sus propias tablas (grafica + grafica_version),
-- con formato, medidas en mm y versiones renderizadas. Apuntar a `piezas` traía publicaciones de
-- Instagram, que están pensadas para pantalla y no para imprimir.
BEGIN;

ALTER TABLE contenido.beneficio DROP COLUMN IF EXISTS frente_pieza_id;
ALTER TABLE contenido.beneficio
  ADD COLUMN IF NOT EXISTS frente_grafica_id uuid
    REFERENCES contenido.grafica(id) ON DELETE SET NULL;

COMMENT ON COLUMN contenido.beneficio.frente_grafica_id IS
  'Pieza de Gráfica que va al frente del impreso. NULL = logo sobre el color del negocio.';

COMMIT;
