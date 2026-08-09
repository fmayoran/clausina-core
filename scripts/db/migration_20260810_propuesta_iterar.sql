-- ClaUsina v2.0 / F7 — la propuesta se itera hasta afinarla.
--
-- Hasta ahora sólo se podía "pedir otra": el creativo arrancaba de cero y perdía todo lo que sí
-- estaba bien. Una propuesta de 7 acciones donde molestan 2 no se corrige tirándola.
--
-- Cada iteración es una propuesta nueva que apunta a la anterior y trae la instrucción de
-- cambio. El job parte del diseño previo y toca SÓLO lo que se pidió, igual que la iteración de
-- una pieza gráfica.
BEGIN;

ALTER TABLE contenido.campania_propuesta ADD COLUMN IF NOT EXISTS nro integer NOT NULL DEFAULT 1;
ALTER TABLE contenido.campania_propuesta ADD COLUMN IF NOT EXISTS previa_id uuid
  REFERENCES contenido.campania_propuesta(id) ON DELETE SET NULL;
-- Sobre qué acción de la propuesta anterior se pidió el ajuste (null = sobre el plan entero).
ALTER TABLE contenido.campania_propuesta ADD COLUMN IF NOT EXISTS sobre_accion integer;

COMMIT;
