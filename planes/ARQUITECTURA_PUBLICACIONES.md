# Arquitectura — Workflow de publicación con aprobación (Cortafuego)

Estado: **En producción**, con **operación por Telegram y panel** (`cortafuego.ar/panel`). El mail dejó de ser operativo (solo resumen diario). El modelo se reingenió al schema multi-proyecto `contenido` (`scripts/db/README.md`); la tabla `publicaciones` de más abajo es el **diseño original (histórico)**. Ver también `scripts/n8n/README.md`, `panel/README.md` y la sección **Evolución (jun 2026)** al final.
Decisión: **Nivel 3 (desacoplado, con n8n) sobre PostgreSQL.**

> Las secciones siguientes son el diseño original (aprobación por mail, tabla `publicaciones`). La máquina de estados y la lógica de aprobación siguen valiendo; cambiaron el **almacenamiento** (schema `contenido`) y los **canales** (Telegram + panel). Resumen al día en **Evolución (jun 2026)**.

## Objetivo
Que toda publicación (Instagram + Novedades) pase por un **control visual manual** y una **aprobación** antes de salir, con un **registro persistente** en base de datos y una **máquina de estados** donde, al aprobarse, se dispara la publicación automática.

## Modelo de datos — tabla `publicaciones` (PostgreSQL, fuente de verdad)
```
id (uuid) · creado_en · actualizado_en
titulo_interno
canal            (instagram | novedades | ambos)
asset_origen     (PNG/fuente)  ·  asset_ig (jpg 4:5 listo, URL pública)
caption          (texto IG)
web_titulo · web_copy · web_tags        (para la tarjeta de novedades)
estado           (borrador → pendiente_aprobacion → aprobada → publicada | rechazada)
token            (uuid de un solo uso, para los links de aprobación)
preview_url
ig_post_id · publicado_en
aprobado_por · aprobado_en · notas
```

## Máquina de estados
```
borrador ──► pendiente_aprobacion ──►(OK de Fer)──► aprobada ──► publicada
                     │
                     └──►(rechazo)──► rechazada ──► (vuelve a borrador)
```
Disparador de publicación: **pendiente_aprobacion → aprobada**.

## Flujo de punta a punta
1. **/creativo** prepara la pieza (imagen 4:5, caption, datos de novedad), pasa el *Checklist de calidad web*, genera la **preview visual** e inserta la fila en PostgreSQL con `estado=pendiente_aprobacion` y un `token` único.
2. **n8n (WF-1)** detecta la fila pendiente y envía un **mail a Fer** con la preview embebida/enlazada y dos links: `…/aprobar?token=…` y `…/rechazar?token=…`.
3. Fer **revisa la preview y clica** Aprobar o Rechazar.
4. **n8n (WF-2, webhook)** valida el token → cambia el estado. Si `aprobada`:
5. **n8n (WF-3)** publica en Instagram vía **Graph API** (3 pasos: crear container con `image_url`+`caption` → poll `status_code` → `media_publish`), guarda `ig_post_id`, regenera Novedades desde la DB, marca `estado=publicada` y manda **mail de confirmación**.

## Componentes (todos sobre infra ya existente en el VPS)
- **PostgreSQL** (motor `crm_pgvector`, base propia **`claude`**, schema **`contenido`**): modelo multi-proyecto `proyectos`/`piezas`/`revisiones`/`media` (ver `scripts/db/README.md`). n8n se conecta nativamente. La base `claude` es independiente de `crm` (que usan otras apps).
- **n8n** (proyecto `crm`): workflows de aprobación/publicación (ver `scripts/n8n/README.md`).
- **Preview visual**: HTML servido en `cortafuego.ar/preview/<token>` con mockup del post de IG + tarjeta de novedades.
- **Publicador**: n8n con la Instagram Graph API. El MCP actual (`tools/instagram-mcp/server.js`) usa `https://graph.instagram.com/v19.0` con `IG_TOKEN` + `IG_USER_ID`; ese mismo token/flujo se reutiliza en n8n.

## Decisiones de diseño cerradas
- **Novedades = regeneradas desde la DB** (no dinámicas): al publicar, n8n regenera `novedades.html` desde PostgreSQL y lo deploya. Así se mantiene el hosting estático y el SEO/performance logrado (100 SEO, 89 Perf).
- **Aprobación por mail con token** de un solo uso (sin panel/login por ahora; el panel web queda como evolución futura).

## Plan de implementación incremental
- **Fase A — Base de datos. ✅ HECHA.** Schema `cortafuego` + tabla `publicaciones`. 2 publicaciones históricas migradas. Scripts en `scripts/db/` (ver `scripts/db/README.md`). **Actualización 02/06/2026:** el schema se mudó de la base compartida `crm` a la base propia **`claude`** (mismo motor `crm_pgvector`) para independizar el proyecto. Migración verificada por paridad + test end-to-end; respaldo temporal en `crm.cortafuego`.
- **Fase B — Preview + mail. ✅ HECHA.** Preview (`assets/landing/preview.html`) + 3 webhooks n8n (datos `cf-pub-data`, decisión `cf-pub-decide`, notificación `cf-pub-notify`) + credencial SMTP. Mail con link a la preview, probado end-to-end. Detalle en `scripts/n8n/README.md`.
- **Fase C — Publicación automática. ✅ HECHA (falta 1ra prueba real).** Workflow `cf-pub-publish`: aprueba → container → espera → `media_publish` → `ig_post_id` → `publicada`. Token IG en credencial cifrada. Validado hasta container + SQL; falta publicar una pieza real end-to-end.
- **Fase D — Novedades desde la DB. ✅ HECHA.** Implementada como **feed dinámico**: `novedades.html` hace fetch al webhook `cf-novedades` (n8n→DB) y renderiza las tarjetas. Al publicarse una pieza aparece sola, sin regenerar ni deployar. (Trade-off elegido vs. estático por GitHub API: se priorizó simplicidad sin token; la home conserva su SEO estático.)

## Reparto de roles
- **/it** (Director de IT): PostgreSQL (DB/tabla/credenciales), n8n (workflows, webhooks, token IG), deploy. Infra de producción.
- **/creativo** (Director Creativo): preparación de piezas, preview, plantilla de novedades, captions, checklist de calidad.

## Notas técnicas / pendientes para la implementación
- `IG_TOKEN` e `IG_USER_ID`: ubicar dónde están (env del MCP) y cargarlos en n8n de forma segura.
- Webhooks de n8n: definir URL pública (¿`n8n.cortafuego.ar`? hoy n8n no tiene dominio asignado — ver INFRA_CONTEXTO).
- Seguridad de los links: token de un solo uso, expiración, e idealmente HTTPS.
- El `/creativo` mantiene su *Checklist de calidad web* y *Definition of Done* en cada pieza antes de pasar a `pendiente_aprobacion`.

---

## Evolución (jun 2026)
Lo que está vivo hoy, sobre el diseño original:

- **Almacenamiento:** schema multi-proyecto **`contenido`** (`proyectos`/`piezas`/`revisiones`/`media`), base `claude` (independiente de `crm`). Detalle en `scripts/db/README.md`. Iterar = nueva revisión; la media guarda solo la última versión. Numeración **CF-NNNN** (`piezas.numero`).
- **Canales de operación:** **Telegram** (tarjeta con Aprobar/Rechazar/Descartar) y **panel** (`cortafuego.ar/panel`, `panel/README.md`): board de Cola de Requerimientos / Pendientes / Publicadas, con login de marca + sesión. El **mail dejó de ser operativo**; quedó `cf-resumen-diario` (07:00 ART) con lo publicado el día anterior.
- **Entrada de contenido:**
  - **Requerimientos por Telegram** (`brief_local.sh`): Fer manda voz/foto+texto → pieza pendiente.
  - **Propuestas del creativo** (`propuestas_local.sh`): el creativo propone qué publicar y **qué material necesita**; Fer aporta material (responde en Telegram o sube en el panel) → entra al circuito. On-demand desde el panel; **pendiente: modo proactivo mirando resultados**.
- **Corrección automática de rechazos** (`rutina_local.sh`, cada 5 min): corrige texto y **visual** (Higgsfield + tipografía de marca) y reenvía como nueva revisión; escala a Fer al **5º** intento. `descartar` = estado terminal, fuera de la rutina.
- **Estados:** enum `estado_pub` = `borrador, pendiente_aprobacion, aprobada, rechazada, publicada, descartada`. El disparador real de publicación sigue siendo la **aprobación manual** (`pendiente_aprobacion → aprobada` vía `cf-pub-publish`).

---
Última actualización: 2026-06-06 — panel de operación + propuestas del creativo + descartar + resumen diario.
