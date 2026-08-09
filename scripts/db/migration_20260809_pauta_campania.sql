-- ClaUsina v2.0 / F7a — liberar el nombre "campaña".
--
-- `contenido.campanias` nunca fue una campaña de marketing: es una campaña de META ADS
-- (meta_campaign_id, adset, ad, presupuesto, audiencia). El concepto que entra ahora —el
-- paraguas que agrupa invitaciones, impresos, publicaciones y pauta— es el que la gente llama
-- campaña, y la pauta va a ser una acción adentro de él.
--
-- Dos cosas con el mismo nombre es la clase de deuda que en un año nadie puede desarmar. Se
-- renombra ahora, con 2 filas y una sección usándola.
BEGIN;

ALTER TABLE contenido.campanias RENAME TO pauta_campania;

-- Los índices y constraints heredan el nombre viejo; se renombran para que el esquema se lea.
ALTER INDEX  contenido.campanias_pkey       RENAME TO pauta_campania_pkey;
ALTER INDEX  contenido.campanias_estado_idx RENAME TO pauta_campania_estado_idx;
ALTER TABLE  contenido.pauta_campania
  RENAME CONSTRAINT campanias_pieza_id_fkey TO pauta_campania_pieza_id_fkey;
ALTER TABLE  contenido.pauta_campania
  RENAME CONSTRAINT campanias_proyecto_id_fkey TO pauta_campania_negocio_id_fkey;

-- La solicitud que le pide al creativo una propuesta de pauta apunta acá.
ALTER TABLE contenido.solicitudes_campania
  RENAME CONSTRAINT solicitudes_campania_campania_id_fkey TO solicitudes_campania_pauta_id_fkey;

COMMIT;
