-- ClaUsina — el PNG de una pieza pasó a ser de imprenta (300 dpi), y por eso necesita un hermano
-- liviano para la pantalla.
--
-- Con el PNG a 100 dpi un solo archivo servía para todo. A 300 dpi un afiche A3 pesa 6,5 MB: la
-- grilla de Gráfica, que muestra nueve piezas, pasaría a bajar 40 MB para dibujar nueve
-- miniaturas. Se separan los dos usos: png_url es el que se imprime, png_prev_url el que se mira.
BEGIN;
ALTER TABLE contenido.grafica_version ADD COLUMN IF NOT EXISTS png_prev_url text;
COMMENT ON COLUMN contenido.grafica_version.png_prev_url IS
  'Copia liviana del frente para la pantalla. Para imprimir se usa png_url.';
COMMIT;
