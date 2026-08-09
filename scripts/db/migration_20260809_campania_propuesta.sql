-- ClaUsina v2.0 / F7 — el creativo propone las acciones de una campaña.
--
-- El momento correcto es con la campaña en BORRADOR: objetivo, ventana, público y presupuesto
-- cargados, y todavía sin acciones. Después, el creativo llega tarde a opinar sobre algo ya
-- decidido.
--
-- La propuesta NO crea nada: deja acciones sugeridas para aceptar de a una. Misma regla que el
-- resto de la plataforma — nada sale sin visto humano.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.campania_propuesta (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campania_id  uuid NOT NULL REFERENCES contenido.campania(id) ON DELETE CASCADE,
  estado       text NOT NULL DEFAULT 'pendiente',
  instruccion  text,                    -- lo que se le pidió además del objetivo de la campaña
  resumen      text,                    -- la lectura del creativo, en prosa
  acciones     jsonb NOT NULL DEFAULT '[]'::jsonb,
  error        text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  iniciado_en  timestamptz,
  procesado_en timestamptz,
  CONSTRAINT campania_propuesta_estado_chk CHECK (estado IN ('pendiente','procesando','lista','error'))
);
CREATE INDEX IF NOT EXISTS campania_propuesta_camp_ix ON contenido.campania_propuesta (campania_id, creado_en DESC);
-- Una sola en curso por campaña: pedir dos a la vez gasta el doble y confunde cuál se aplica.
CREATE UNIQUE INDEX IF NOT EXISTS campania_propuesta_encurso_ux
  ON contenido.campania_propuesta (campania_id) WHERE estado IN ('pendiente','procesando');

-- De qué propuesta salió una acción: permite ver qué aceptó el negocio de lo que se sugirió.
ALTER TABLE contenido.campania_accion ADD COLUMN IF NOT EXISTS propuesta_id uuid
  REFERENCES contenido.campania_propuesta(id) ON DELETE SET NULL;

COMMIT;
