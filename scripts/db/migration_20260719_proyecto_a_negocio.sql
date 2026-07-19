-- RENOMBRE GENERAL: la entidad que gestionamos pasa a llamarse NEGOCIO.
-- Antes "proyecto" (DB) / "marca" (UI). Un negocio es el paraguas; a futuro podrá tener >1 marca
-- (identidad), por eso "marca" se conserva SOLO como concepto de branding (manual/estilo/voz),
-- nunca como la entidad. Acá se renombran tablas + columnas; todo en una transacción.
-- PG hace RENAME sobre metadatos: FKs, índices y secuencias siguen automáticamente (sus nombres
-- quedan con el string viejo, pero funcionan; no afecta nada).
BEGIN;

-- 1) Columnas proyecto_id -> negocio_id (usando los nombres de tabla ACTUALES, antes de renombrarlas).
ALTER TABLE contenido.ads_daily             RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.ads_snapshot          RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.auditorias            RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.batch_runs            RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.biblioteca_carpeta    RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.biblioteca_item       RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.campanias             RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.ig_metricas           RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.landing_cambios       RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.marca_descubrimiento  RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.marca_gen             RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.piezas                RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.proyecto_capacidad    RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.proyecto_contacto     RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.proyecto_perfil       RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.solicitudes_biblioteca RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.solicitudes_campania  RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.solicitudes_propuesta RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.tg_briefs             RENAME COLUMN proyecto_id TO negocio_id;
ALTER TABLE contenido.tg_pending            RENAME COLUMN proyecto_id TO negocio_id;

-- 2) Tablas de la entidad -> negocio.
ALTER TABLE contenido.proyectos            RENAME TO negocios;
ALTER TABLE contenido.proyecto_perfil      RENAME TO negocio_perfil;
ALTER TABLE contenido.proyecto_capacidad   RENAME TO negocio_capacidad;
ALTER TABLE contenido.proyecto_contacto    RENAME TO negocio_contacto;
-- Estas tenían prefijo "marca_" pero son operaciones sobre la ENTIDAD (onboarding, cápsula,
-- generación de estilo/manual), no el concepto de branding: pasan a "negocio_".
ALTER TABLE contenido.marca_capsula_req    RENAME TO negocio_capsula_req;
ALTER TABLE contenido.marca_descubrimiento RENAME TO negocio_descubrimiento;
ALTER TABLE contenido.marca_gen            RENAME TO negocio_gen;

COMMIT;
