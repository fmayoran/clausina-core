-- ClaUsina — qué dice el dorso de una pieza de dos caras.
--
-- Hasta ahora una pieza tenía UN mensaje y, con caras=2, el dorso lo proponía el creativo: "el
-- complemento, según la pieza". Está bien como default, pero cuando el dorso tiene contenido
-- real —el menú, cómo llegar, las condiciones de una promo— no había dónde escribirlo y la
-- única vía era pedirlo después, iterando.
BEGIN;
ALTER TABLE contenido.grafica ADD COLUMN IF NOT EXISTS mensaje_dorso text;
COMMIT;
