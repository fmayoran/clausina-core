-- Cortafuego / Sistema de contenido — schema `contenido` (base `claude`, PostgreSQL pgvector del VPS).
-- Modelo multi-proyecto: proyectos → piezas → revisiones (historial de versiones) ; media cuelga de la pieza
-- (solo la última versión). El concepto "publicación" es una revisión con estado='publicada'.
-- Ejecutar con: docker exec -i crm_pgvector psql -U postgres -d claude -v ON_ERROR_STOP=1 < schema_contenido.sql
-- Idempotente.

CREATE EXTENSION IF NOT EXISTS pgcrypto;        -- gen_random_uuid()
CREATE SCHEMA IF NOT EXISTS contenido;

-- ─────────────── Enums ───────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='estado_pub' AND n.nspname='contenido') THEN
    CREATE TYPE contenido.estado_pub AS ENUM
      ('borrador','pendiente_aprobacion','aprobada','rechazada','publicada');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='canal' AND n.nspname='contenido') THEN
    CREATE TYPE contenido.canal AS ENUM ('instagram','novedades','ambos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='tipo_media' AND n.nspname='contenido') THEN
    CREATE TYPE contenido.tipo_media AS ENUM ('image','video');
  END IF;
END$$;

-- ─────────────── Tablas ───────────────
CREATE TABLE IF NOT EXISTS contenido.proyectos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,                 -- 'cortafuego'
  nombre       text NOT NULL,
  ig_user_id   text,                                 -- cuenta IG (público)
  ig_handle    text,                                 -- @cortafuego.ar
  dominio_web  text,                                 -- cortafuego.ar
  telegram_chat_id text,                             -- chat de Telegram para aprobaciones (2º canal)
  activo       boolean NOT NULL DEFAULT true,
  creado_en    timestamptz NOT NULL DEFAULT now()
);
-- idempotente para bases ya creadas
ALTER TABLE contenido.proyectos ADD COLUMN IF NOT EXISTS telegram_chat_id text;

CREATE TABLE IF NOT EXISTS contenido.piezas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id       uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE RESTRICT,
  titulo_interno    text NOT NULL,
  estado            contenido.estado_pub NOT NULL DEFAULT 'borrador',  -- denormalizado de la revisión vigente (trigger)
  revision_vigente  uuid,                              -- FK -> revisiones(id); se agrega abajo (circular)
  notas             text,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  actualizado_en    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contenido.revisiones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pieza_id        uuid NOT NULL REFERENCES contenido.piezas(id) ON DELETE CASCADE,
  nro             int NOT NULL DEFAULT 1,             -- versión 1,2,3...
  estado          contenido.estado_pub NOT NULL DEFAULT 'borrador',
  canal           contenido.canal NOT NULL DEFAULT 'ambos',
  formato         text NOT NULL DEFAULT 'feed',        -- 'feed' (post/reel/carrusel) | 'story' (Historia efímera)
  caption         text,                               -- Instagram
  web_titulo      text,
  web_copy        text,
  web_tags        text[],
  token           uuid NOT NULL DEFAULT gen_random_uuid(),  -- link de aprobación
  motivo_rechazo  text,                               -- por qué se rechazó ESTA versión
  aprobado_por    text,
  aprobado_en     timestamptz,
  ig_post_id      text,                               -- vacío hasta publicar
  ig_permalink    text,                               -- vacío hasta publicar
  publicado_en    timestamptz,
  derivado_en     timestamptz,                        -- marca de "escalado a Fer" por la rutina (rechazo no auto-resoluble)
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);
-- idempotente para bases ya creadas
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS derivado_en timestamptz;
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS formato text NOT NULL DEFAULT 'feed';
ALTER TABLE contenido.proyectos  ADD COLUMN IF NOT EXISTS ig_colaboradores text[] DEFAULT '{}';  -- handles a etiquetar/invitar a Collab en cada post (ej. {ardora.ar})

-- estado efímero para correlacionar el motivo de rechazo que llega por Telegram
CREATE TABLE IF NOT EXISTS contenido.tg_pending (
  chat_id    text PRIMARY KEY,
  token      uuid NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

-- cola de "briefs" por Telegram (audio + media opcional) → los procesa brief_local.sh (cron + Claude Code)
CREATE TABLE IF NOT EXISTS contenido.tg_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id       text NOT NULL,
  voice_file_id text,                 -- file_id de Telegram del audio
  media_file_id text,                 -- file_id de la foto/video adjunta (opcional)
  media_type    text,                 -- 'photo' | 'video'
  texto         text,                 -- caption de texto (si vino)
  transcripcion text,                 -- la completa el handler tras transcribir
  estado        text NOT NULL DEFAULT 'pendiente',  -- pendiente | procesado | error
  creado_en     timestamptz NOT NULL DEFAULT now(),
  procesado_en  timestamptz
);

CREATE TABLE IF NOT EXISTS contenido.media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pieza_id     uuid NOT NULL REFERENCES contenido.piezas(id) ON DELETE CASCADE,
  orden        int NOT NULL DEFAULT 1,
  tipo         contenido.tipo_media NOT NULL DEFAULT 'image',
  url          text NOT NULL,
  poster_url   text,
  creado_en    timestamptz NOT NULL DEFAULT now()
);

-- FK circular piezas.revision_vigente -> revisiones(id) (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_piezas_revision_vigente') THEN
    ALTER TABLE contenido.piezas
      ADD CONSTRAINT fk_piezas_revision_vigente
      FOREIGN KEY (revision_vigente) REFERENCES contenido.revisiones(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ─────────────── Índices ───────────────
CREATE INDEX IF NOT EXISTS idx_piezas_proyecto   ON contenido.piezas(proyecto_id);
CREATE INDEX IF NOT EXISTS idx_piezas_estado     ON contenido.piezas(estado);
CREATE INDEX IF NOT EXISTS idx_rev_pieza         ON contenido.revisiones(pieza_id);
CREATE INDEX IF NOT EXISTS idx_rev_estado        ON contenido.revisiones(estado);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rev_token  ON contenido.revisiones(token);
CREATE INDEX IF NOT EXISTS idx_media_pieza       ON contenido.media(pieza_id, orden);

-- ─────────────── Triggers ───────────────
-- mantener actualizado_en
CREATE OR REPLACE FUNCTION contenido.set_actualizado_en() RETURNS trigger AS $$
BEGIN NEW.actualizado_en = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_piezas_upd ON contenido.piezas;
CREATE TRIGGER trg_piezas_upd BEFORE UPDATE ON contenido.piezas
  FOR EACH ROW EXECUTE FUNCTION contenido.set_actualizado_en();

DROP TRIGGER IF EXISTS trg_rev_upd ON contenido.revisiones;
CREATE TRIGGER trg_rev_upd BEFORE UPDATE ON contenido.revisiones
  FOR EACH ROW EXECUTE FUNCTION contenido.set_actualizado_en();

-- sincronizar piezas.estado/revision_vigente con la revisión vigente
--  INSERT de revisión  -> esa pasa a ser la vigente
--  UPDATE de la vigente -> se refleja el estado en la pieza
CREATE OR REPLACE FUNCTION contenido.sync_pieza() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE contenido.piezas
       SET revision_vigente = NEW.id, estado = NEW.estado
     WHERE id = NEW.pieza_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE contenido.piezas
       SET estado = NEW.estado
     WHERE id = NEW.pieza_id AND revision_vigente = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rev_sync ON contenido.revisiones;
CREATE TRIGGER trg_rev_sync AFTER INSERT OR UPDATE OF estado ON contenido.revisiones
  FOR EACH ROW EXECUTE FUNCTION contenido.sync_pieza();
