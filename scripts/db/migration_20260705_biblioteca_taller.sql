-- Gestor de medios: "taller" organizable de la biblioteca (carpetas + ítems).
-- Piezas/Marca/Material siguen siendo carpetas CALCULADAS (solo lectura). El taller es
-- lo que Fer sube o genera el bibliotecario, con carpetas propias (En proceso, Terminado, …)
-- y assets movibles entre ellas.
CREATE TABLE IF NOT EXISTS contenido.biblioteca_carpeta (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  orden       int  NOT NULL DEFAULT 100,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proyecto_id, nombre)
);
CREATE TABLE IF NOT EXISTS contenido.biblioteca_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  media_path  text NOT NULL,                       -- en el media store (biblioteca/<slug>/…)
  tipo        text NOT NULL DEFAULT 'image',        -- image | video
  nombre      text,
  carpeta     text NOT NULL DEFAULT 'En proceso',
  origen      text NOT NULL DEFAULT 'subido',       -- subido | bibliotecario
  resumen     text,                                 -- para lo generado con IA: cómo se hizo
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS biblio_item_proy_idx ON contenido.biblioteca_item(proyecto_id, carpeta);
