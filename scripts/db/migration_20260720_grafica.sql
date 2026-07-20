-- Gráfica: diseño de material promocional impreso y de vía pública (folletos, afiches, carteles).
-- Capacidad transversal a todos los negocios. Se itera por VERSIONES hasta llegar a la definitiva;
-- nada se da por final sin la aprobación de Fer (misma regla que el resto de la plataforma).
CREATE TABLE IF NOT EXISTS contenido.grafica (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id   uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  nombre       text NOT NULL,
  formato      text NOT NULL,              -- id del catálogo (a5, a3, sextuple, custom…)
  ancho_mm     numeric NOT NULL,           -- resueltos: permite "a medida"
  alto_mm      numeric NOT NULL,
  mensaje      text,                       -- qué queremos transmitir
  fondo_modo   text NOT NULL DEFAULT 'sin_fondo',  -- biblioteca | subido | generar | sin_fondo
  fondo_url    text,                       -- el fondo elegido/generado (se reusa entre versiones)
  fondo_prompt text,                       -- si se generó con IA, con qué se pidió
  datos        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- qué datos del negocio incluir
  estado       text NOT NULL DEFAULT 'borrador',    -- borrador | lista | aprobada | descartada
  version_actual int NOT NULL DEFAULT 0,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grafica_negocio_idx ON contenido.grafica (negocio_id, actualizado_en DESC);

-- Cada iteración es una versión: queda el historial y se puede volver a una anterior.
CREATE TABLE IF NOT EXISTS contenido.grafica_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grafica_id   uuid NOT NULL REFERENCES contenido.grafica(id) ON DELETE CASCADE,
  nro          int NOT NULL,
  instruccion  text,                       -- qué se pidió en esta vuelta ("título más grande")
  html_url     text,
  pdf_url      text,
  png_url      text,                       -- preview para ver y compartir
  estado       text NOT NULL DEFAULT 'pendiente',  -- pendiente | procesando | lista | error
  error        text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  procesado_en timestamptz
);
CREATE INDEX IF NOT EXISTS grafica_version_idx ON contenido.grafica_version (grafica_id, nro DESC);
-- Una sola generación en curso por pieza (evita encolar dos veces).
CREATE UNIQUE INDEX IF NOT EXISTS grafica_version_encurso_ux ON contenido.grafica_version (grafica_id)
  WHERE estado IN ('pendiente', 'procesando');
