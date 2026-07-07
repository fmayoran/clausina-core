-- Campañas de pauta (Meta Marketing API): el creativo PROPONE campañas; Fer aprueba; se crean
-- PAUSADAS en Meta y recién se activan con su OK. Nada gasta sin aprobación.
--
-- Dos tablas, en paralelo al patrón bibliotecario:
--   solicitudes_campania: pedido a que el creativo proponga una campaña (worker -> campania_job.sh)
--   campanias:            el borrador/propuesta en sí (lo que se revisa, aprueba y crea en Meta)

CREATE TABLE IF NOT EXISTS contenido.campanias (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id   uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  -- propuesta -> aprobada -> (creada en Meta) pausada -> activa ; rechazada/descartada/error
  estado        text NOT NULL DEFAULT 'propuesta',
  nombre        text NOT NULL,
  objetivo      text NOT NULL,               -- OUTCOME_AWARENESS | OUTCOME_TRAFFIC | OUTCOME_ENGAGEMENT
  pieza_id      uuid REFERENCES contenido.piezas(id) ON DELETE SET NULL,  -- post publicado usado de creativo
  razon         text,                        -- por qué esta campaña (racional del creativo)
  audiencia     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- ubicaciones/edad/generos/intereses (descriptivo + hints)
  presupuesto   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {tipo:diario|total, monto, moneda}
  fecha_inicio  date,
  fecha_fin     date,
  url_destino   text,
  cta           text,
  meta_campaign_id text,
  meta_adset_id    text,
  meta_ad_id       text,
  resumen       text,                         -- qué pasó al crear/activar (o motivo de error/rechazo)
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  aprobado_en   timestamptz
);
CREATE INDEX IF NOT EXISTS campanias_estado_idx ON contenido.campanias (proyecto_id, estado);
COMMENT ON TABLE contenido.campanias IS 'Borradores/propuestas de campañas de pauta. El creativo propone; Fer aprueba; se crean PAUSADAS en Meta.';

CREATE TABLE IF NOT EXISTS contenido.solicitudes_campania (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id  uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  instruccion  text,                          -- guía opcional de Fer (o vacío = a criterio del creativo)
  estado       text NOT NULL DEFAULT 'pendiente',  -- pendiente | procesando | listo | error
  campania_id  uuid REFERENCES contenido.campanias(id) ON DELETE SET NULL,
  resumen      text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  procesado_en timestamptz
);
CREATE INDEX IF NOT EXISTS solic_campania_estado_idx ON contenido.solicitudes_campania (proyecto_id, estado);
COMMENT ON TABLE contenido.solicitudes_campania IS 'Pedido a que el creativo proponga una campaña (worker -> campania_job.sh).';
