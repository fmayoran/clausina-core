-- ClaUsina — la imagen con la que la invitación se ve al compartirla.
--
-- Como og:image se estaba usando la pieza gráfica del frente, que es vertical (A6). WhatsApp
-- trata las verticales como adjunto: miniatura chica al costado y el link al lado. La vista
-- grande, la que ocupa el ancho de la burbuja, necesita una imagen apaisada.
--
-- Así que se compone una pieza propia de 1200x630 —el arte del frente + logo, beneficio y marca—
-- y se guarda por beneficio, no por invitación: todas las invitaciones de un beneficio comparten
-- el mismo diseño, y el código va en la descripción del enlace.
BEGIN;
ALTER TABLE contenido.beneficio ADD COLUMN IF NOT EXISTS og_url text;
ALTER TABLE contenido.beneficio ADD COLUMN IF NOT EXISTS og_generado_en timestamptz;
COMMENT ON COLUMN contenido.beneficio.og_url IS
  'Imagen apaisada 1200x630 para la vista previa al compartir la invitación.';
COMMIT;
