-- Sistema de diseño por marca: el estilo estructurado vive en la base (fuente de verdad),
-- editable desde el panel (perfil) y generado a marcas/<slug>/contexto/ESTILO.md por perfil_a_md.sh.
-- Distinto de lineamientos_visuales (texto corto) y de brief_md (narrativa).
ALTER TABLE contenido.proyecto_perfil ADD COLUMN IF NOT EXISTS estilo_md text;
