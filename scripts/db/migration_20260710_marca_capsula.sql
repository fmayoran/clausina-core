-- La cápsula marcas/<slug>/ es un ARTEFACTO DERIVADO de la DB: se crea al dar de alta la marca
-- y se archiva al darla de baja. El panel deja un pedido; el worker lo aplica en el host
-- (nada a mano en el VPS). accion: 'scaffold' (crear) | 'archivar' (baja).
CREATE TABLE IF NOT EXISTS contenido.marca_capsula_req (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug      text NOT NULL,
  accion    text NOT NULL DEFAULT 'scaffold',
  pedido_en timestamptz NOT NULL DEFAULT now(),
  procesado boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS marca_capsula_req_pend_idx ON contenido.marca_capsula_req (procesado) WHERE NOT procesado;
