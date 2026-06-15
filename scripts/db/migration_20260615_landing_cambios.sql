-- F1 Landings: requerimientos de cambio de landing por proyecto.
-- Flujo: pendiente -> procesando -> borrador (preview listo) -> aprobada (a producción) | rechazada | error.
CREATE TABLE IF NOT EXISTS contenido.landing_cambios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id   uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  requerimiento text NOT NULL,
  estado        text NOT NULL DEFAULT 'pendiente',   -- pendiente|procesando|borrador|aprobada|rechazada|error
  branch        text,
  preview_url   text,
  commit_sha    text,
  resumen       text,            -- qué hizo el creativo (una línea)
  motivo_rechazo text,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  procesado_en  timestamptz,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS landing_cambios_proy_estado_idx ON contenido.landing_cambios(proyecto_id, estado);
