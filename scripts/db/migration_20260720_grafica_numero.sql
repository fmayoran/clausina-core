-- Numeración de piezas gráficas, igual que las publicaciones: un número correlativo para
-- poder referenciarlas ("mandá el G-0003 a la imprenta"). Secuencia propia.
CREATE SEQUENCE IF NOT EXISTS contenido.grafica_numero_seq;
ALTER TABLE contenido.grafica
  ADD COLUMN IF NOT EXISTS numero int NOT NULL DEFAULT nextval('contenido.grafica_numero_seq');
