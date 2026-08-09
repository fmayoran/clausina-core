-- ClaUsina — la imagen del dorso.
--
-- El fondo era uno por pieza, así que en una pieza de dos caras el creativo lo usaba en el
-- frente y el dorso quedaba sin foto: no había forma de pedir una imagen distinta atrás. Mismo
-- criterio que el mensaje por cara: si el dorso es una cara de verdad, tiene sus decisiones.
BEGIN;
ALTER TABLE contenido.grafica ADD COLUMN IF NOT EXISTS fondo_dorso_modo   text;
ALTER TABLE contenido.grafica ADD COLUMN IF NOT EXISTS fondo_dorso_url    text;
ALTER TABLE contenido.grafica ADD COLUMN IF NOT EXISTS fondo_dorso_prompt text;
COMMIT;
