-- Pedido de regeneración de secretos derivados. La DB es la fuente de verdad; cuando cambia
-- un token en el perfil, el panel deja un pedido y el worker corre sync_secrets.py (que
-- descifra en el host y regenera la credencial de n8n). n8n nunca ve la clave maestra.
CREATE TABLE IF NOT EXISTS contenido.secrets_sync_req (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug      text NOT NULL,
  pedido_en timestamptz NOT NULL DEFAULT now(),
  procesado boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS secrets_sync_req_pend_idx ON contenido.secrets_sync_req (procesado) WHERE NOT procesado;
