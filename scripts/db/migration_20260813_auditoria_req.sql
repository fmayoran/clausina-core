-- ClaUsina — la auditoría se pide desde el panel y la genera un job del host.
--
-- La tabla contenido.auditorias existe desde junio y su migración decía "a futuro se generan
-- periódicamente por cron". Ese cron nunca existió: las tres filas que hay se cargaron a mano, y
-- un negocio nuevo veía la pantalla vacía sin ninguna forma de llenarla.
--
-- Mismo patrón que las demás colas del motor (grafica_version, campania_propuesta): el panel deja
-- el pedido, el dispatcher lo ve, el worker lo corre en el host —que es el único que puede salir
-- a la web y hablar con la API de Meta— y el resultado vuelve a la base.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.auditoria_req (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id   uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  estado       text NOT NULL DEFAULT 'pendiente',
  error        text,
  -- Qué encontró, para poder decir "web sí, Instagram no hay datos" sin abrir el JSON.
  resumen      text,
  pedido_por   uuid,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  iniciado_en  timestamptz,
  procesado_en timestamptz,
  CONSTRAINT auditoria_req_estado_chk CHECK (estado IN ('pendiente','procesando','lista','error'))
);

CREATE INDEX IF NOT EXISTS auditoria_req_neg_ix ON contenido.auditoria_req (negocio_id, creado_en DESC);
-- Una sola en curso por negocio: pedir de nuevo mientras corre gasta el doble y compite por la
-- misma fila de resultado.
CREATE UNIQUE INDEX IF NOT EXISTS auditoria_req_encurso_ux
  ON contenido.auditoria_req (negocio_id) WHERE estado IN ('pendiente','procesando');

COMMIT;
