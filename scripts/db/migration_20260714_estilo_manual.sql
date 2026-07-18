-- Generación de estilo y manual de marca por el creativo.
-- Una sola tabla de pedidos para los dos (tipo = estilo | manual): el manual depende de que el
-- estilo esté completo, así que comparten flujo y estado.
CREATE TABLE IF NOT EXISTS contenido.marca_gen (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id  uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  tipo         text NOT NULL CHECK (tipo IN ('estilo', 'manual')),
  estado       text NOT NULL DEFAULT 'pendiente',   -- pendiente | procesando | listo | error
  error        text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  procesado_en timestamptz
);
CREATE INDEX IF NOT EXISTS marca_gen_estado_idx ON contenido.marca_gen (estado, creado_en);
-- Un pedido en curso por marca y tipo (no encolar dos veces lo mismo).
CREATE UNIQUE INDEX IF NOT EXISTS marca_gen_encurso_ux ON contenido.marca_gen (proyecto_id, tipo)
  WHERE estado IN ('pendiente', 'procesando');

-- El manual es un artefacto derivado: HTML (online) + PDF. Se guardan sus URLs en el perfil.
ALTER TABLE contenido.proyecto_perfil ADD COLUMN IF NOT EXISTS manual_html_url    text;
ALTER TABLE contenido.proyecto_perfil ADD COLUMN IF NOT EXISTS manual_pdf_url     text;
ALTER TABLE contenido.proyecto_perfil ADD COLUMN IF NOT EXISTS manual_generado_en timestamptz;
