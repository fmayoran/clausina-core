-- ClaUsina v2.0 / F7 — la propuesta se acuerda antes de bajar a acciones.
--
-- El creativo devolvía el plan y las acciones de una sola vez. Eso obliga a discutir la
-- estrategia y la ejecución al mismo tiempo, y deja acciones sobre la mesa que quizá salen de un
-- plan que todavía no se aprobó.
--
-- Ahora son dos fases: primero el PLAN en prosa —que se puede editar a mano y aprobar—, y recién
-- sobre el plan aprobado se generan las ACCIONES. Si el texto se editó, las acciones salen del
-- texto editado: es lo que hace que editarlo sirva de algo.
BEGIN;

ALTER TABLE contenido.campania_propuesta DROP CONSTRAINT IF EXISTS campania_propuesta_estado_chk;
ALTER TABLE contenido.campania_propuesta ADD CONSTRAINT campania_propuesta_estado_chk
  CHECK (estado IN ('pendiente','procesando','lista','aprobada','error'));

-- Qué está generando el job: el plan o las acciones que salen de él.
ALTER TABLE contenido.campania_propuesta ADD COLUMN IF NOT EXISTS fase text NOT NULL DEFAULT 'plan';
ALTER TABLE contenido.campania_propuesta DROP CONSTRAINT IF EXISTS campania_propuesta_fase_chk;
ALTER TABLE contenido.campania_propuesta ADD CONSTRAINT campania_propuesta_fase_chk
  CHECK (fase IN ('plan','acciones'));

-- Quedan registrados el texto original del creativo y el editado: saber qué escribió él y qué
-- corrigió el negocio es la mitad del valor de dejarlo editar.
ALTER TABLE contenido.campania_propuesta ADD COLUMN IF NOT EXISTS resumen_original text;
ALTER TABLE contenido.campania_propuesta ADD COLUMN IF NOT EXISTS aprobado_en timestamptz;

-- Las que ya tienen acciones nacieron con el flujo viejo: se dan por aprobadas para no perderlas.
UPDATE contenido.campania_propuesta
   SET estado='aprobada', aprobado_en=now()
 WHERE estado='lista' AND jsonb_array_length(acciones) > 0;

COMMIT;
