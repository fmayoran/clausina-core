-- ClaUsina — cuándo EMPEZÓ a procesarse un pedido, que no es cuándo se pidió.
--
-- La recuperación de trabajos colgados mataba todo lo que estuviera 'procesando' y se hubiera
-- CREADO hace más de 40 minutos. Dos formas de romperse, las dos reales:
--   · reintentar un pedido viejo: arranca y el dispatcher lo mata al minuto siguiente;
--   · un pedido que esperó en cola (worker caído, cola larga): lo matan apenas empieza.
-- El reloj tiene que correr desde que el trabajo arranca, no desde que la persona lo pidió.
BEGIN;

ALTER TABLE contenido.solicitudes_biblioteca ADD COLUMN IF NOT EXISTS iniciado_en timestamptz;
ALTER TABLE contenido.solicitudes_campania   ADD COLUMN IF NOT EXISTS iniciado_en timestamptz;
ALTER TABLE contenido.negocio_descubrimiento ADD COLUMN IF NOT EXISTS iniciado_en timestamptz;
ALTER TABLE contenido.negocio_gen            ADD COLUMN IF NOT EXISTS iniciado_en timestamptz;
ALTER TABLE contenido.grafica_version        ADD COLUMN IF NOT EXISTS iniciado_en timestamptz;

COMMIT;
