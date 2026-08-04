-- ClaUsina v2.0 — F3: clientes. Primera capacidad del grupo OPERACIÓN.
-- Ver core/planes/V2.md.
--
-- DECISIÓN DE FER (04/08): los datos del cliente final son DEL NEGOCIO; ClaUsina los procesa.
-- Encargada del tratamiento, no dueña (ley 25.326). De ahí salen tres reglas que están en el
-- esquema, no en el código:
--   1. AISLAMIENTO ESTRICTO: el mismo teléfono en dos negocios son DOS filas. Nada de una tabla
--      de personas compartida entre negocios, ni siquiera para "enriquecer".
--   2. CONSENTIMIENTO REGISTRADO: hay que poder decir de dónde salió cada contacto.
--   3. EXPORTAR Y BORRAR por negocio desde el día uno (el borrado en cascada lo garantiza la FK).
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.cliente (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  nombre         text,
  telefono       text,          -- como lo escribió quien lo cargó
  telefono_norm  text,          -- clave de comparación (panel/telefono.js): últimos 10 dígitos
  email          text,
  notas          text,
  origen         text NOT NULL DEFAULT 'carga'
                   CHECK (origen IN ('whatsapp','landing','carga','agente','importacion')),
  -- Consentimiento: sin esto no se puede sostener que el contacto llegó de forma legítima.
  consentimiento     boolean NOT NULL DEFAULT false,
  consentimiento_en  timestamptz,
  ref_externa    text,          -- id en el sistema del negocio, cuando ClaUsina es espejo
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  -- Un cliente sin ningún dato de contacto no sirve para nada.
  CONSTRAINT cliente_identificable CHECK (
    coalesce(nombre,'') <> '' OR coalesce(telefono_norm,'') <> '' OR coalesce(email,'') <> '')
);

CREATE INDEX IF NOT EXISTS cliente_negocio_ix ON contenido.cliente (negocio_id, creado_en DESC);
-- Un teléfono, un cliente — DENTRO del negocio. Entre negocios se repite a propósito.
CREATE UNIQUE INDEX IF NOT EXISTS cliente_tel_ux
  ON contenido.cliente (negocio_id, telefono_norm) WHERE telefono_norm IS NOT NULL;
-- Búsqueda por nombre/mail sin exigir prefijo exacto.
CREATE INDEX IF NOT EXISTS cliente_busq_ix
  ON contenido.cliente USING gin (to_tsvector('simple',
     coalesce(nombre,'') || ' ' || coalesce(email,'') || ' ' || coalesce(telefono,'')));

-- El consentimiento se fecha solo: si alguien lo marca, queda cuándo. Si lo saca, se limpia.
CREATE OR REPLACE FUNCTION contenido.cliente_touch() RETURNS trigger AS $$
BEGIN
  NEW.actualizado_en := now();
  IF NEW.consentimiento AND (TG_OP = 'INSERT' OR NOT OLD.consentimiento) THEN
    NEW.consentimiento_en := now();
  ELSIF NOT NEW.consentimiento THEN
    NEW.consentimiento_en := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cliente_touch_tg ON contenido.cliente;
CREATE TRIGGER cliente_touch_tg BEFORE INSERT OR UPDATE ON contenido.cliente
  FOR EACH ROW EXECUTE FUNCTION contenido.cliente_touch();

COMMIT;
