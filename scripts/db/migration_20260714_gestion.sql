-- Rol de ClaUsina sobre la marca: gestión INTEGRAL (la manejamos completa) vs PARCIAL (rol
-- secundario: por ejemplo, solo le pasamos avisos a la pantalla).
--
-- Es un dato de NEGOCIO, no una consecuencia de qué capacidades estén prendidas: una marca puede
-- tener Instagram habilitado y aun así ser un rol secundario. Por eso es un flag explícito y no
-- algo derivado (una derivación se equivocaría, y encima en silencio).
ALTER TABLE contenido.proyectos
  ADD COLUMN IF NOT EXISTS gestion text NOT NULL DEFAULT 'integral';

ALTER TABLE contenido.proyectos DROP CONSTRAINT IF EXISTS proyectos_gestion_chk;
ALTER TABLE contenido.proyectos
  ADD CONSTRAINT proyectos_gestion_chk CHECK (gestion IN ('integral', 'parcial'));

-- Semilla razonable: parcial = tiene pantalla pero NO produce contenido (sin Instagram).
-- Es solo el valor inicial; Fer lo corrige desde el panel cuando haga falta.
UPDATE contenido.proyectos p SET gestion = 'parcial'
WHERE EXISTS (SELECT 1 FROM contenido.proyecto_capacidad c
               WHERE c.proyecto_id = p.id AND c.capacidad = 'pantalla' AND c.habilitada)
  AND NOT EXISTS (SELECT 1 FROM contenido.proyecto_capacidad c
                   WHERE c.proyecto_id = p.id AND c.capacidad = 'instagram' AND c.habilitada);
