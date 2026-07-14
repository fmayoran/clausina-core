-- Contactos de la marca: quién es quién del lado del cliente (dueño, community manager,
-- responsable de pauta…). Sirve para saber a quién escribirle y, más adelante, para notificar
-- automáticamente (ej. "tu aviso ya está en pantalla").
CREATE TABLE IF NOT EXISTS contenido.proyecto_contacto (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  rol         text,            -- dueño | community manager | pauta | … (texto libre, con sugerencias en el panel)
  whatsapp    text,
  email       text,
  notas       text,
  orden       int  NOT NULL DEFAULT 0,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proyecto_contacto_proyecto_idx
  ON contenido.proyecto_contacto (proyecto_id, orden);
