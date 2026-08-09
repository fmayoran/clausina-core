-- ClaUsina — los skills se editan en el panel; el archivo es una copia derivada.
--
-- Hasta hoy las instrucciones de los agentes (/creativo, /editor, /it) vivían SÓLO como archivos
-- en ~/.claude/skills/. Eso trae tres problemas que ya se cobraron algo:
--   · no están versionados ni respaldados —son lo único de ClaUsina fuera de git—;
--   · se editan a mano en el servidor, cuando toda la operación diaria es por el panel;
--   · se desactualizan en silencio: el de /creativo apuntaba a rutas que no existen desde el
--     renombre de carpetas, y decía "apertura Julio 2026" cuando la apertura es el 18 de agosto.
--     Un skill que miente no falla: escribe una pieza con la fecha equivocada.
--
-- Mismo patrón que la credencial de n8n (ver core/planes/, regla de secretos): la DB es la fuente
-- de verdad y el consumidor que no puede leerla recibe una copia regenerada. Acá el consumidor es
-- Claude, que lee archivos .md del disco.
--
-- ÁMBITO: esta tabla guarda lo GENÉRICO (de la agencia). Lo particular de cada negocio no se
-- duplica acá: ya vive en Identidad —brief y estilo— y se regenera en CONTEXTO_MARCA.md de su
-- cápsula. El skill genérico dice "leé el contexto del negocio activo"; el contexto lo pone el
-- negocio. Guardar lo mismo en dos lados es garantizar que se contradigan.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.skill (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE,          -- creativo | editor | it
  nombre         text NOT NULL,
  -- Lo que lee Claude para decidir CUÁNDO invocarla. Es tan importante como el cuerpo: una
  -- descripción pobre hace que la skill no se active nunca.
  descripcion    text NOT NULL,
  contenido_md   text NOT NULL,
  activo         boolean NOT NULL DEFAULT true,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_por uuid
);

-- Igual que secrets_sync_req: el panel no puede escribir en el disco del host, así que deja el
-- pedido y un worker del host regenera el archivo.
CREATE TABLE IF NOT EXISTS contenido.skill_sync_req (
  id         bigserial PRIMARY KEY,
  slug       text NOT NULL,
  procesado  boolean NOT NULL DEFAULT false,
  pedido_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_sync_req_pend_ix ON contenido.skill_sync_req (pedido_en) WHERE NOT procesado;

-- Historial, con el mismo criterio que el brief: un texto largo escrito a mano no puede quedar
-- sin red. Ver el incidente del 09/08 en perfil_texto_hist.
CREATE TABLE IF NOT EXISTS contenido.skill_hist (
  id          bigserial PRIMARY KEY,
  slug        text NOT NULL,
  contenido   text NOT NULL,
  largo       integer NOT NULL,
  usuario_id  uuid,
  guardado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_hist_ix ON contenido.skill_hist (slug, guardado_en DESC);

COMMIT;
