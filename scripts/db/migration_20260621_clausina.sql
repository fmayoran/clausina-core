-- Alta del proyecto Clausina en el sistema multi-proyecto ClaUsina.
-- Registra la marca en contenido.proyectos y su perfil en contenido.proyecto_perfil.
-- Ejecutar con: docker exec -i crm_pgvector psql -U postgres -d claude -v ON_ERROR_STOP=1 < migration_20260621_clausina.sql

BEGIN;

INSERT INTO contenido.proyectos (slug, nombre, ig_handle, dominio_web, activo)
VALUES ('clausina', 'Clausina', '@clausina.ar', 'clausina.ar', true)
ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, ig_handle = EXCLUDED.ig_handle, dominio_web = EXCLUDED.dominio_web, activo = EXCLUDED.activo;

INSERT INTO contenido.proyecto_perfil (proyecto_id, slogan, logo, brief_md, actualizado_en)
SELECT id,
  'Clausina',
  'Logotipo oficial de Clausina. Usar solo archivos de marca autorizados; no regenerar con IA.',
  $bm$Clausina es la plataforma de contenido y operaciones de la agencia ClaUsina.

Su función es integrar marcas, procesos y generación de contenido con un motor de publicación multi-marca.

Tono: profesional, claro y directo. La marca es soporte operativo para otras marcas; no es protagonista del contenido de los locales.

Servicios:
- Gestión de proyectos de marca.
- Orquestación de contenido para Instagram, Telegram, rechazos y pantallas.
- Procesos de aprobación y revisión multi-marca.
- Automatización con cola Redis, agentes IA y panel central.

Objetivo:
Construir un entorno en el que cada marca tenga su propia voz y contexto, mientras la agencia administra la operación desde ClaUsina.$bm$,
  now()
FROM contenido.proyectos p WHERE p.slug = 'clausina'
ON CONFLICT (proyecto_id) DO UPDATE SET slogan = EXCLUDED.slogan, logo = EXCLUDED.logo, brief_md = EXCLUDED.brief_md, actualizado_en = now();

COMMIT;
