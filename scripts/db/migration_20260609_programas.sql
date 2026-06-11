-- Programación de pantalla (09/06/2026): playlists de avisos para el reproductor de la pantalla LED.
-- Un "programa" es una lista ordenada de avisos aprobados (piezas canal=aviso, estado=publicada).
-- El player web (kiosco en la pantalla) consume el programa ACTIVO y se autoactualiza por polling.
CREATE TABLE IF NOT EXISTS contenido.programas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre         text NOT NULL,
  activo         boolean NOT NULL DEFAULT false,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contenido.programa_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programa_id uuid NOT NULL REFERENCES contenido.programas(id) ON DELETE CASCADE,
  orden       int  NOT NULL,
  pieza_id    uuid NOT NULL REFERENCES contenido.piezas(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS programa_items_prog_idx ON contenido.programa_items(programa_id, orden);
