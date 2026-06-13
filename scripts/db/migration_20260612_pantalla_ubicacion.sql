-- Multi-pantalla: ubicación de cada pantalla. 2026-06-12
ALTER TABLE contenido.pantallas ADD COLUMN IF NOT EXISTS ubicacion text;
UPDATE contenido.pantallas SET ubicacion='Ochava Av. Valentín Vergara — Paseo Ardora'
  WHERE slug='paseo-ardora' AND ubicacion IS NULL;
