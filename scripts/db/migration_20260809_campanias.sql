-- ClaUsina v2.0 / F7a — Campañas: el paraguas que agrupa acciones de marketing.
--
-- Una campaña es un conjunto de acciones con un objetivo y una ventana. Las acciones NO son
-- entidades nuevas: son publicaciones, avisos, impresos, tandas de invitaciones y pauta que ya
-- viven en sus tablas. `campania_accion` es el vínculo, más lo que sólo existe por ser parte de
-- la campaña (su costo, su rótulo, cuántos folletos se repartieron).
--
-- Ver core/planes/CAMPANIAS.md.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.campania (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id     uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  nombre         text NOT NULL,
  objetivo       text,                      -- en palabras: "que vengan a conocer el local"
  -- Y en números, que es lo que lo hace medible. Sin esto "efectividad" es una opinión.
  objetivo_tipo  text NOT NULL DEFAULT 'clientes_nuevos',
  meta_valor     numeric(12,2),
  desde          date NOT NULL,
  hasta          date,                      -- abierta mientras no se cierre
  estado         text NOT NULL DEFAULT 'borrador',
  presupuesto    numeric(12,2),             -- lo previsto; el gasto real se deriva de las acciones
  notas          text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campania_estado_chk CHECK (estado IN ('borrador','activa','pausada','cerrada')),
  CONSTRAINT campania_objetivo_chk CHECK (objetivo_tipo IN ('clientes_nuevos','reservas','visitas','alcance')),
  -- Una campaña que termina antes de empezar es siempre un error de carga, y silencioso: no
  -- atribuye nada y nadie entiende por qué.
  CONSTRAINT campania_ventana_chk CHECK (hasta IS NULL OR hasta >= desde)
);
CREATE INDEX IF NOT EXISTS campania_negocio_ix ON contenido.campania (negocio_id, desde DESC);

CREATE TABLE IF NOT EXISTS contenido.campania_accion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campania_id    uuid NOT NULL REFERENCES contenido.campania(id) ON DELETE CASCADE,
  tipo           text NOT NULL,
  nombre         text NOT NULL,
  estado         text NOT NULL DEFAULT 'planificada',
  orden          integer NOT NULL DEFAULT 0,

  -- Exactamente una, según el tipo. FKs reales y no una columna `objeto_id` con discriminador:
  -- lo segundo parece más elegante y pierde integridad referencial — el día que se borra una
  -- pieza, la acción queda apuntando al vacío sin que nadie se entere.
  pieza_id       uuid REFERENCES contenido.piezas(id)          ON DELETE SET NULL,
  grafica_id     uuid REFERENCES contenido.grafica(id)         ON DELETE SET NULL,
  beneficio_id   uuid REFERENCES contenido.beneficio(id)       ON DELETE SET NULL,
  pauta_id       uuid REFERENCES contenido.pauta_campania(id)  ON DELETE SET NULL,
  link_id        uuid REFERENCES contenido.accion_link(id)     ON DELETE SET NULL,

  -- Lo que la campaña agrega y no vive en ningún otro lado.
  costo_previsto numeric(12,2),
  costo_real     numeric(12,2),             -- para pauta se deriva de ads_daily; el resto se carga
  costo_nota     text,
  -- Cuántos se repartieron/imprimieron. NADIE lo mide: lo declara una persona, y por eso en la
  -- pantalla se muestra distinto de lo medido.
  volumen_declarado integer,
  notas          text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campania_accion_tipo_chk CHECK (tipo IN ('instagram','pantalla','impreso','invitaciones','pauta','link','otra')),
  CONSTRAINT campania_accion_estado_chk CHECK (estado IN ('planificada','activa','terminada','descartada')),
  -- Cero o una referencia: cero mientras la acción se está armando ("folleto de barrios" existe
  -- antes de que la pieza gráfica esté diseñada), nunca dos.
  CONSTRAINT campania_accion_una_ref_chk CHECK (
    (CASE WHEN pieza_id     IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN grafica_id   IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN beneficio_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN pauta_id     IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN link_id      IS NOT NULL THEN 1 ELSE 0 END) <= 1
  )
);
CREATE INDEX IF NOT EXISTS campania_accion_camp_ix ON contenido.campania_accion (campania_id, orden);

-- El hilo de la atribución. Dos columnas contra una tabla nueva: el dato queda donde ya vive el
-- hecho, y no hay una tercera copia que se pueda desincronizar.
ALTER TABLE contenido.accion_link
  ADD COLUMN IF NOT EXISTS campania_accion_id uuid REFERENCES contenido.campania_accion(id) ON DELETE SET NULL;
ALTER TABLE contenido.invitacion
  ADD COLUMN IF NOT EXISTS campania_accion_id uuid REFERENCES contenido.campania_accion(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS accion_link_campania_ix ON contenido.accion_link (campania_accion_id);
CREATE INDEX IF NOT EXISTS invitacion_campania_ix  ON contenido.invitacion (campania_accion_id);

COMMIT;
