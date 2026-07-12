-- Descubrimiento de marca: análisis de la presencia digital pública (web + IG + enlaces)
-- que alimenta el wizard de alta. Corre ANTES de que la marca exista -> no cuelga de proyecto_id
-- (se enlaza después, si el alta se concreta).
CREATE TABLE IF NOT EXISTS contenido.marca_descubrimiento (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       text,
  web          text,
  instagram    text,
  notas        text,
  estado       text NOT NULL DEFAULT 'pendiente',   -- pendiente | procesando | listo | error
  resultado    jsonb,
  error        text,
  proyecto_id  uuid REFERENCES contenido.proyectos(id) ON DELETE SET NULL,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  procesado_en timestamptz
);
CREATE INDEX IF NOT EXISTS marca_descubrimiento_estado_idx
  ON contenido.marca_descubrimiento (estado, creado_en);
