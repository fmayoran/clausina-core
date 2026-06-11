# Base de datos — Sistema de contenido (modelo multi-proyecto)

Schema **`contenido`** en la base **`claude`** del PostgreSQL **`crm_pgvector`** del VPS
(proyecto EasyPanel `crm`, imagen `ankane/pgvector`). Es la **fuente de verdad** del sistema de
publicación con aprobación (ver `planes/ARQUITECTURA_PUBLICACIONES.md`).

> La base **`claude`** es la base propia de los proyectos, **independiente de `crm`** (que usan otras
> apps: chatwoot, dzain, embeddings). El schema **`contenido`** es **multi-proyecto**: una tabla
> `proyectos` distingue cada marca, así el mismo sistema (tablas + workflows + front-end) sirve a
> Cortafuego y a futuras marcas sin clonar nada.

## Modelo (02/06/2026 — reingeniería)

```
proyectos    -- una marca (slug, nombre, ig_user_id, ig_handle, dominio_web)
   └─ piezas        -- la idea / unidad de contenido; guarda estado y revisión vigentes
        ├─ revisiones   -- historial de versiones (SOLO texto/datos: caption, web_*, motivo, estado, ig_post_id, ig_permalink…)
        └─ media        -- assets SOLO de la última versión (carrusel: varias filas por orden)
```
- Una **publicación** es una `revisión` con `estado='publicada'`. El feed de Novedades lee las publicadas.
- El **loop de iteración**: rechazar deja la revisión en `rechazada`; corregir = **nueva revisión** bajo la misma pieza (`nro`+1), que pasa a ser la vigente y supera a la anterior (no hace falta marcar "procesado").
- La **media solo guarda la última versión** (al iterar se reemplaza) para no acumular peso; el texto de cada versión sí queda como historial.
- `piezas.estado` y `piezas.revision_vigente` los mantiene un **trigger** (`sync_pieza`) desde la revisión vigente.

## Cambios 06/06/2026 (panel + propuestas)
Migraciones: `migration_20260606_operativo.sql` y `migration_20260606_propuestas.sql`.
- **`piezas.numero`** — numeración secuencial (`pieza_numero_seq`), se muestra como **CF-NNNN** en el panel.
- **`tg_briefs`** (cola de requerimientos) gana:
  - `pieza_id` → correlación requerimiento ↔ pieza generada (la setea `cf-crear-pendiente` con `brief_id`).
  - `origen` (`fer` | `creativo`), `titulo`, `requiere_material` → para las **propuestas del creativo**.
  - `tg_msg_id` → message_id de la propuesta en Telegram (para vincular la respuesta-con-material).
  - estado `propuesta` (es `text`, sin enum): propuesta esperando material; al aportarlo pasa a `pendiente`.
  - estado `descartada`: requerimiento sacado de la cola.
- **`solicitudes_propuesta`** — pedidos de propuestas que hace el panel (con `enfasis`); los levanta `propuestas_local.sh`.
- **`batch_runs`** — latido de los procesos batch (`correccion`, `ingesta_briefs`, `propuestas`) para la barra de status del panel.
- **`ig_metricas`** (`migration_20260606_metricas.sql`) — métricas de Instagram por post publicado (views/reach/likes/…), cacheadas. El panel las refresca cada 30 min desde `graph.instagram.com` (token con permiso de insights) y las muestra en la columna Publicada. Insumo para el futuro modo proactivo del creativo.
- **enum `estado_pub`** sumó `descartada` (estado terminal de revisión/pieza; la rutina de corrección solo mira `rechazada`).

## Acceso

- Host interno (red Docker del VPS): servicio `crm_pgvector`, puerto `5432`.
- Usuario: `postgres` · Base: `claude` · Password: en el env del contenedor (`POSTGRES_PASSWORD`, vía EasyPanel).
- El contenedor es un servicio Swarm; obtener su nombre dinámicamente:

```bash
PG=$(ssh root@72.60.166.136 "docker ps -q -f name=crm_pgvector.1.")
```

## Ejecutar SQL

```bash
# crear/actualizar el modelo (idempotente)
ssh root@72.60.166.136 "docker exec -i $PG psql -U postgres -d claude -v ON_ERROR_STOP=1" < schema_contenido.sql

# migrar desde el modelo viejo cortafuego.publicaciones (idempotente, solo lo no migrado)
ssh root@72.60.166.136 "docker exec -i $PG psql -U postgres -d claude -v ON_ERROR_STOP=1" < migracion_contenido.sql

# consultar
ssh root@72.60.166.136 "docker exec -i $PG psql -U postgres -d claude -c \"SELECT pz.titulo_interno, r.nro, r.estado FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente ORDER BY pz.creado_en;\""
```

## Archivos

- `schema_contenido.sql` — modelo nuevo: schema `contenido`, enums (`estado_pub`, `canal`, `tipo_media`), tablas `proyectos`/`piezas`/`revisiones`/`media`, índices y triggers (`set_actualizado_en`, `sync_pieza`). Idempotente.
- `migracion_contenido.sql` — migra `cortafuego.publicaciones` → `contenido` (cada fila → pieza + revisión nro 1 + media). Idempotente.
- *(legacy)* `schema_publicaciones.sql` / `seed_migracion.sql` — modelo viejo de 1 tabla (`cortafuego.publicaciones`). Quedan por referencia histórica.

## Historial

- **Fase A (31/05/2026):** schema `cortafuego` + tabla `publicaciones` en base `crm`.
- **Mudanza a base `claude` (02/06/2026):** se aisló el proyecto de `crm` (compartida). Credencial n8n `DRC5p50dRb5kYMOn`.
- **Reingeniería a `contenido` (02/06/2026):** modelo multi-proyecto (proyectos/piezas/revisiones/media). Datos migrados y circuito probado end-to-end. **Bajas hechas (02/06/2026):** se dropearon los respaldos `claude.cortafuego` y `crm.cortafuego`; `contenido` es la única fuente. Se agregó `revisiones.derivado_en` (marca de "escalado a Fer" para la rutina). Rollback ya no por tabla vieja, sino por git (workflows + DDL versionados).
