-- Bibliotecario: solicitudes para crear/editar ASSETS de la biblioteca (no publicaciones).
-- Fer escribe una directiva desde la página de Biblioteca; un worker corre el creativo con
-- el contexto de marca (Higgsfield/ffmpeg) y deja el resultado en el media store (biblioteca/<slug>/).
CREATE TABLE IF NOT EXISTS contenido.solicitudes_biblioteca (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id    uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  instruccion    text NOT NULL,
  origen_url     text,          -- asset fuente a editar (opcional; URL absoluta)
  origen_tipo    text,          -- image | video
  estado         text NOT NULL DEFAULT 'pendiente',   -- pendiente | procesando | listo | error
  resultado_path text,          -- media_path del asset generado (biblioteca/<slug>/<uuid>.<ext>)
  resultado_tipo text,          -- image | video
  resumen        text,          -- qué hizo el bibliotecario (alto nivel)
  creado_en      timestamptz NOT NULL DEFAULT now(),
  procesado_en   timestamptz
);
CREATE INDEX IF NOT EXISTS solic_biblio_estado_idx ON contenido.solicitudes_biblioteca(proyecto_id, estado);
