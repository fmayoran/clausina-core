-- Frente / frente y dorso: una pieza puede tener 1 o 2 caras (flyers, tarjetas, folletos).
-- El PDF sale con una página por cara; el preview guarda una imagen por cara.
ALTER TABLE contenido.grafica ADD COLUMN IF NOT EXISTS caras int NOT NULL DEFAULT 1
  CHECK (caras IN (1, 2));
ALTER TABLE contenido.grafica_version ADD COLUMN IF NOT EXISTS png_dorso_url text;
