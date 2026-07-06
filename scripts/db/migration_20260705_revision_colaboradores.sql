-- Collaborators por-post (Instagram Collab). NULL = usar el default de la marca (proyectos.ig_colaboradores);
-- {} = publicar SIN collab; {handle,...} = invitar a esos. Lo elige Fer al aprobar.
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS colaboradores text[];
