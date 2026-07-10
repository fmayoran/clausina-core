-- Capacidades por marca: no toda marca usa toda la plataforma.
-- Estado de una capacidad = flag explícito (habilitada) + configuración verificada (se calcula
-- contra la config real, no se guarda, para que el flag no pueda mentir).
-- Siempre activas (no son capacidades): identidad, brief, biblioteca.
CREATE TABLE IF NOT EXISTS contenido.proyecto_capacidad (
  proyecto_id    uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  capacidad      text NOT NULL,          -- estilo | instagram | pauta | pantalla | web
  habilitada     boolean NOT NULL DEFAULT false,
  config         jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- web: {"modo":"administrada"|"referencia"}
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proyecto_id, capacidad)
);

-- Seed: habilitamos lo que cada marca YA usa hoy (derivado de su config/uso real).
INSERT INTO contenido.proyecto_capacidad (proyecto_id, capacidad, habilitada, config)
SELECT p.id, 'instagram',
       (p.ig_handle IS NOT NULL AND (pp.ig_token_enc IS NOT NULL
        OR EXISTS (SELECT 1 FROM contenido.piezas pz WHERE pz.proyecto_id=p.id AND pz.canal='instagram'))),
       '{}'::jsonb
FROM contenido.proyectos p LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
ON CONFLICT DO NOTHING;

INSERT INTO contenido.proyecto_capacidad (proyecto_id, capacidad, habilitada, config)
SELECT p.id, 'pauta',
       (pp.meta_ads_account_id IS NOT NULL AND pp.meta_ads_token_enc IS NOT NULL), '{}'::jsonb
FROM contenido.proyectos p LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
ON CONFLICT DO NOTHING;

INSERT INTO contenido.proyecto_capacidad (proyecto_id, capacidad, habilitada, config)
SELECT p.id, 'pantalla',
       EXISTS (SELECT 1 FROM contenido.piezas pz WHERE pz.proyecto_id=p.id AND pz.canal='aviso'), '{}'::jsonb
FROM contenido.proyectos p
ON CONFLICT DO NOTHING;

INSERT INTO contenido.proyecto_capacidad (proyecto_id, capacidad, habilitada, config)
SELECT p.id, 'estilo', (length(coalesce(pp.estilo_md,'')) > 20), '{}'::jsonb
FROM contenido.proyectos p LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
ON CONFLICT DO NOTHING;

-- Web: habilitada si tiene dominio. Modo por defecto 'administrada' (hoy las 3 cápsulas
-- tienen repo propio); 'referencia' = la web existe pero ClaUsina no la administra.
INSERT INTO contenido.proyecto_capacidad (proyecto_id, capacidad, habilitada, config)
SELECT p.id, 'web', (p.dominio_web IS NOT NULL), '{"modo":"administrada"}'::jsonb
FROM contenido.proyectos p
ON CONFLICT DO NOTHING;
