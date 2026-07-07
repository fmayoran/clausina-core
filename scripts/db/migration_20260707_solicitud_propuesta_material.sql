-- Material opcional adjunto a un pedido de propuestas: el creativo lo ve al proponer y se
-- traslada a cada requerimiento generado (para usarlo al crear la pieza).
CREATE TABLE IF NOT EXISTS contenido.solicitud_propuesta_material (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id uuid NOT NULL REFERENCES contenido.solicitudes_propuesta(id) ON DELETE CASCADE,
  media_path   text NOT NULL,
  media_type   text NOT NULL DEFAULT 'photo',
  filename     text,
  orden        int  NOT NULL DEFAULT 0,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS solic_prop_material_idx ON contenido.solicitud_propuesta_material (solicitud_id, orden);
