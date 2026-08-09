-- ClaUsina — el contexto del negocio, completo y con una sola fuente de verdad.
--
-- Diagnóstico del 09/08: `CONTEXTO_MARCA.md` —el archivo que lee el creativo— tenía el brief de
-- ANTEAYER. Se regenera sólo cuando corre un job, así que editar en el panel no lo actualiza:
-- el agente trabaja con una versión vieja y nadie se entera. Además nunca llevó la FICHA (rubro,
-- sedes, zona, ticket, público, atributos, horarios), que es la mitad de lo que define al
-- negocio, ni los tokens de marca.
--
-- Y `REFERENCIAS_INSTAGRAM.md` (32 KB de análisis de cuentas de referencia) vivía SÓLO como
-- archivo: es el único contenido de marca sin fuente de verdad, sin respaldo y sin historial.
--
-- Mismo patrón que los skills, pero atado al negocio: la base manda, el archivo se regenera.
BEGIN;

ALTER TABLE contenido.negocio_perfil ADD COLUMN IF NOT EXISTS referencias_md text;

-- El pedido de regeneración. El panel no puede escribir en el disco del host (las cápsulas
-- viven ahí), así que deja la marca y un worker rehace los .md del negocio.
CREATE TABLE IF NOT EXISTS contenido.contexto_sync_req (
  id         bigserial PRIMARY KEY,
  slug       text NOT NULL,
  procesado  boolean NOT NULL DEFAULT false,
  pedido_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contexto_sync_req_pend_ix ON contenido.contexto_sync_req (pedido_en) WHERE NOT procesado;

COMMIT;
