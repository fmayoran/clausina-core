-- Cortafuego — Workflow de publicación (Fase A)
-- Schema y tabla de publicaciones en la base `claude` (PostgreSQL pgvector del VPS).
-- La base `claude` es la base propia de los proyectos (independiente de `crm`); un schema por proyecto.
-- Ejecutar con: docker exec -i crm_pgvector psql -U postgres -d claude < schema_publicaciones.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;          -- gen_random_uuid()
CREATE SCHEMA IF NOT EXISTS cortafuego;

-- Estado de la publicación (máquina de estados)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE t.typname='estado_publicacion' AND n.nspname='cortafuego') THEN
    CREATE TYPE cortafuego.estado_publicacion AS ENUM
      ('borrador','pendiente_aprobacion','aprobada','publicada','rechazada');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS cortafuego.publicaciones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  titulo_interno  text NOT NULL,
  canal           text NOT NULL DEFAULT 'ambos' CHECK (canal IN ('instagram','novedades','ambos')),
  asset_origen    text,                       -- ruta/URL del archivo fuente (PNG)
  asset_ig        text,                       -- URL pública del JPG 4:5 listo para IG
  caption         text,                       -- texto del post de Instagram
  web_titulo      text,                       -- título de la tarjeta de novedades
  web_copy        text,                       -- copy de la tarjeta de novedades
  web_tags        text[],                     -- etiquetas de la tarjeta
  estado          cortafuego.estado_publicacion NOT NULL DEFAULT 'borrador',
  token           uuid NOT NULL DEFAULT gen_random_uuid(),  -- para links de aprobación
  preview_url     text,
  ig_post_id      text,
  publicado_en    timestamptz,
  aprobado_por    text,
  aprobado_en     timestamptz,
  notas           text,
  motivo_rechazo  text,                          -- comentario del rechazo (loop de iteración)
  regenerada_en   timestamptz,                   -- marca de rechazo ya procesado (idempotencia de la rutina)
  intentos        int NOT NULL DEFAULT 0,        -- intentos de regeneración (corta loops)
  tipo_media      text NOT NULL DEFAULT 'image', -- 'image' | 'video' (Reel)
  poster_url      text                           -- thumbnail/poster del video
);

-- Idempotente para bases existentes (las columnas de arriba pueden no estar en una tabla previa)
ALTER TABLE cortafuego.publicaciones ADD COLUMN IF NOT EXISTS motivo_rechazo text;
ALTER TABLE cortafuego.publicaciones ADD COLUMN IF NOT EXISTS regenerada_en timestamptz;
ALTER TABLE cortafuego.publicaciones ADD COLUMN IF NOT EXISTS intentos int NOT NULL DEFAULT 0;
ALTER TABLE cortafuego.publicaciones ADD COLUMN IF NOT EXISTS tipo_media text NOT NULL DEFAULT 'image';
ALTER TABLE cortafuego.publicaciones ADD COLUMN IF NOT EXISTS poster_url text;

CREATE INDEX IF NOT EXISTS idx_pub_estado ON cortafuego.publicaciones(estado);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pub_token ON cortafuego.publicaciones(token);

-- Mantener actualizado_en
CREATE OR REPLACE FUNCTION cortafuego.set_actualizado_en() RETURNS trigger AS $$
BEGIN NEW.actualizado_en = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pub_actualizado ON cortafuego.publicaciones;
CREATE TRIGGER trg_pub_actualizado BEFORE UPDATE ON cortafuego.publicaciones
  FOR EACH ROW EXECUTE FUNCTION cortafuego.set_actualizado_en();
