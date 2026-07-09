-- Evolución diaria de pauta (para el gráfico) + pedido de refresco on-demand.

-- Serie diaria por marca (breakdown time_increment=1 de Meta). Upsert por (proyecto, fecha).
CREATE TABLE IF NOT EXISTS contenido.ads_daily (
  proyecto_id uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  fecha       date NOT NULL,
  gasto       numeric NOT NULL DEFAULT 0,
  impresiones bigint  NOT NULL DEFAULT 0,
  alcance     bigint  NOT NULL DEFAULT 0,
  clics       bigint  NOT NULL DEFAULT 0,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proyecto_id, fecha)
);

-- Pedido de refresco manual (botón "Actualizar ahora"): el dispatcher lo consume y corre el sync.
CREATE TABLE IF NOT EXISTS contenido.pauta_sync_req (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_en timestamptz NOT NULL DEFAULT now(),
  procesado boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pauta_sync_req_pend_idx ON contenido.pauta_sync_req (procesado) WHERE NOT procesado;
