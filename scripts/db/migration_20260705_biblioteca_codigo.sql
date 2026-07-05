-- Identificador legible por asset del taller, para referenciarlo (ej. "usá el medio M0007").
CREATE SEQUENCE IF NOT EXISTS contenido.biblioteca_item_seq;
ALTER TABLE contenido.biblioteca_item ADD COLUMN IF NOT EXISTS codigo text;
ALTER TABLE contenido.biblioteca_item ALTER COLUMN codigo SET DEFAULT 'M'||to_char(nextval('contenido.biblioteca_item_seq'),'FM0000');
UPDATE contenido.biblioteca_item SET codigo='M'||to_char(nextval('contenido.biblioteca_item_seq'),'FM0000') WHERE codigo IS NULL;
