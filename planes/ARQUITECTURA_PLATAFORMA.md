# Arquitectura de la Plataforma de Contenido

> Documento vivo. Describe la plataforma que estamos construyendo: un sistema **multi-proyecto**
> para crear, aprobar y publicar contenido de marca (Instagram + web), con generación asistida por IA.
> Hoy su primer (y único) proyecto es **Cortafuego**, pero el diseño está pensado para sumar más marcas.
>
> Última actualización: 2 de junio de 2026. Mantener este doc al agregar funcionalidad.
> Docs de detalle: [`ARQUITECTURA_PUBLICACIONES.md`](ARQUITECTURA_PUBLICACIONES.md) · [`../scripts/db/README.md`](../scripts/db/README.md) · [`../scripts/n8n/README.md`](../scripts/n8n/README.md) · `infra/INFRA_CONTEXTO.md`.

## 1. Visión y propósito

Una plataforma para que una marca (o varias) **planifique, apruebe y publique** contenido sin fricción:
- El contenido se prepara (texto + imagen/video, generados o reales), se registra como **pieza pendiente**.
- Pasa por una **aprobación humana** por mail con preview del posteo.
- Al aprobarse, se **publica solo** en Instagram y aparece en la web (Novedades).
- Si se rechaza, entra en un **loop de iteración** (corregir y reenviar) hasta aprobarse.

Principio rector: **nada sale sin aprobación humana**; la automatización prepara y publica, no decide.

## 2. Mapa de componentes

```
                         ┌─────────────────────────────────────────────┐
                         │  CONTROL / AGENTES (Claude Code)             │
                         │  /creativo (contenido) · /it (infra)         │
                         │  rutina cron local (regenera rechazos)       │
                         └───────────────┬─────────────────────────────┘
                                         │ prepara piezas / opera
                                         ▼
  GENERACIÓN IA              ORQUESTACIÓN (n8n)                 DATOS (PostgreSQL)
 ┌───────────────┐        ┌─────────────────────┐           ┌──────────────────────┐
 │ Higgsfield    │ asset  │ webhooks cf-*        │  SQL      │ base claude          │
 │ (CLI; API     ├───────▶│ (data/decide/notify/ │◀─────────▶│ schema contenido     │
 │  REST pend.)  │        │  publish/novedades…) │           │ proyectos·piezas·    │
 └───────────────┘        └─────┬────────┬───────┘           │ revisiones·media     │
                                │        │                   └──────────────────────┘
                  Graph API     │        │  SMTP (mail) + Telegram (bot)
                  (publicar)    ▼        ▼
                         ┌──────────┐  ┌──────────────────────┐
                         │Instagram │  │ Fernando              │
                         │@cortafu… │  │ mail / Telegram:      │
                         └──────────┘  │ aprueba/rechaza       │
                                       └────────┬─────────────┘
                                                │ abre
  PRESENTACIÓN (web, cortafuego.ar)             ▼
 ┌───────────────────────────────────────────────────────────┐
 │ index.html · preview.html (aprobación) · novedades.html    │
 │ (feed dinámico) — proxy same-origin /n8n → n8n             │
 └───────────────────────────────────────────────────────────┘

  INFRAESTRUCTURA: VPS Hostinger · EasyPanel · Docker Swarm · Traefik (SSL) ·
                   PostgreSQL pgvector · n8n · (chatwoot/dzain en base aparte `crm`)
```

## 3. Capa de infraestructura

- **VPS Hostinger** `72.60.166.136`, gestionado con **EasyPanel** (panel Docker, puerto 3000).
- **Docker Swarm** + **Traefik** como reverse proxy con SSL automático (Let's Encrypt) por dominio.
- **PostgreSQL** (contenedor `crm_pgvector`, imagen `ankane/pgvector`): aloja dos bases:
  - `crm` — apps ajenas (chatwoot, dzain, embeddings). **No** se tocan desde la plataforma.
  - `claude` — base **propia** de la plataforma (independiente). Acá vive el schema `contenido`.
- **n8n** (`https://crm-n8n.dhmtev.easypanel.host`) — motor de automatización.
- **Landing** Nginx (`cortafuego.ar`), repo `fmayoran/cortafuego`, **auto-deploy** por push a `main`.
- Detalle operativo y credenciales: `infra/INFRA_CONTEXTO.md` (rol **`/it`**).

## 4. Modelo de datos — base `claude`, schema `contenido`

Multi-proyecto: una marca = una fila en `proyectos`; el resto cuelga de ahí.

```
proyectos (slug, nombre, ig_user_id, ig_handle, dominio_web)
   └─ piezas            -- la idea / unidad de contenido; guarda estado y revisión vigentes
        ├─ revisiones   -- historial de versiones (SOLO texto/datos): caption, web_*, estado,
        │                  token, motivo_rechazo, ig_post_id, ig_permalink, derivado_en…
        └─ media         -- assets de la ÚLTIMA versión (carrusel: varias filas por orden)
```

Claves del diseño:
- Una **publicación** = una `revisión` con `estado='publicada'`. El feed de Novedades lee las publicadas.
- **Trazabilidad del loop**: cada corrección es una `revisión` nueva (`nro`+1) bajo la misma `pieza`.
- **Media solo de la última versión** (al iterar se reemplaza) para no acumular peso; el texto sí queda como historial.
- `piezas.estado` y `piezas.revision_vigente` los mantiene el **trigger `sync_pieza`**.
- `derivado_en` marca revisiones que la rutina escaló a Fer (para que no se reprocesen).
- Enums: `estado_pub` (borrador, pendiente_aprobacion, aprobada, rechazada, publicada), `canal` (instagram, novedades, ambos), `tipo_media` (image, video).
- DDL y migración: `scripts/db/schema_contenido.sql`, `scripts/db/migracion_contenido.sql`.

## 5. Orquestación (n8n)

- Conecta a `claude`/`contenido` con la credencial Postgres `DRC5p50dRb5kYMOn`. Mail por SMTP (`58C2JQ1ZFSV3GIxk`). Instagram por Graph API con token en credencial cifrada `ZqmyQ7hDQYu8xWC9` (no en git ni en la DB).
- Webhooks (todos devuelven los mismos alias que consume el front-end):
  - `cf-crear-pendiente` (POST) — crea pieza+revisión (o, con `pieza_id`, una revisión nueva = corrección).
  - `cf-pub-notify` — manda el mail de aprobación con link a la preview.
  - `cf-pub-data` — datos de la pieza para la preview.
  - `cf-pub-decide` — aprobar / rechazar con motivo.
  - `cf-pub-publish` — al aprobar: publica en IG (imagen o Reel), trae el `ig_permalink` y marca `publicada`.
  - `cf-novedades` — feed de publicadas para la web.
  - `cf-rechazos-pendientes` / `cf-marcar-procesado` / `cf-avisar` — soporte de la rutina.
- Detalle (queries, gotchas, loop): `scripts/n8n/README.md`. Los workflows están versionados en `scripts/n8n/workflows/*.json`.

## 6. Presentación (web — `cortafuego.ar`)

- Sitio estático Nginx. `index.html` (home con SEO/JSON-LD), `preview.html` (pantalla de aprobación), `novedades.html` (**feed dinámico** que hace fetch a `cf-novedades`).
- **Proxy same-origin**: preview y novedades cargan datos desde `cortafuego.ar/n8n/…` (Nginx → n8n) para funcionar incluso en el navegador embebido de Gmail.
- Calidad innegociable: hook pre-commit (`scripts/validate_web.py`) que bloquea si se viola el checklist (WebP, fuentes self-hosted, meta/OG/JSON-LD, sitemap). Rol **`/creativo`**.

## 7. Generación con IA

- **Higgsfield** (CLI, plan ultra) genera imágenes y Reels (image-to-video de producto) cuando no hay material real. Receta: `scripts/higgsfield/README.md`.
- Las piezas tipográficas de marca (teasers) se componen en HTML y se renderizan a JPG con Chromium/Playwright, usando fuentes y paleta reales.
- **Hoy la generación la inicia siempre Fer** (manual, con iteración de prompt). Automatizarla en el pipeline (API REST de Higgsfield en n8n) es un pendiente del roadmap.

## 8. Control / agentes

- **`/creativo`** — Director Creativo: contenido IG, web, mail, calendario, SEO/AEO, generación IA.
- **`/it`** — Director de IT: VPS, EasyPanel, Docker, n8n, PostgreSQL, deploys.
- **Rutina de auto-corrección** (`scripts/rutina_local.sh`, **cron cada 5 min en el VPS**) — invoca **Claude Code headless** (sobre la suscripción, sin API) solo cuando hay rechazos: regenera el copy de los rechazos de texto y reenvía, o escala a Fer los visuales. Doc/instrucciones: `scripts/rutina_regenerar_rechazos.md`. Reemplazó a la rutina `/schedule` de la nube (bloqueada por allowlist de red + cuota).

## 9. Flujo end-to-end

1. Se prepara una pieza (texto + media; generada o real) → `cf-crear-pendiente` → queda `pendiente_aprobacion` con `token`.
2. `cf-pub-notify` → avisa a Fer por **dos canales**: **mail** (link a `preview.html?token=…`) y **Telegram** (tarjeta con la imagen + botones ✅ Aprobar / ✖️ Rechazar; bot `@cf_ig_bot`, workflow `cf-telegram`). Aprobar/rechazar funciona igual desde cualquiera.
3. Fer abre la preview (mockup IG + tarjeta de novedad) y decide:
   - **Aprobar** → `cf-pub-publish`: container Graph API → publish → guarda `ig_post_id` + `ig_permalink` → `publicada`. Aparece en Instagram y en Novedades.
   - **Rechazar con motivo** → `cf-pub-decide` guarda el motivo → la pieza queda `rechazada`.
4. **Loop**: una corrección crea una **revisión nueva** (misma pieza) → vuelve al paso 2. La rutina puede hacer este loop sola para correcciones de texto; los visuales los escala a Fer.

## 10. Decisiones de diseño (con fecha)

- **31/05/2026** — Aprobación desacoplada (Nivel 3): PostgreSQL como fuente de verdad + n8n + mail con token. Novedades dinámico (no regenerado).
- **02/06/2026** — Base **`claude`** separada de `crm` para independizar los proyectos de las apps ajenas.
- **02/06/2026** — Reingeniería al schema **`contenido`** multi-proyecto (proyectos/piezas/revisiones/media). Se fusionó "revisión" y "publicación" en una tabla con `estado` evolutivo; la media guarda solo la última versión (peso); `proyecto` como tabla (no schema por proyecto) para reusar el sistema.
- **02/06/2026** — Fix: el nodo Postgres de n8n con `queryReplacement` multi-segmento parte por comas → pasar params como **array**. (Truncaba el motivo de rechazo.)
- **02/06/2026** — `ig_permalink` real al publicar; baja de respaldos viejos (`cortafuego.*`).

## 11. Roadmap / funcionalidad futura

*(Sección para ir llenando a medida que agregamos features.)*

- [x] **Rutina de auto-corrección** — HECHO (02/06/2026): cron local en el VPS + Claude Code headless (sin costo de API). Reemplaza la `/schedule` de la nube, que estaba bloqueada por la allowlist de red.
- [ ] **API REST de Higgsfield en n8n** — generación automática dentro del pipeline (auth `Key KEY_ID:KEY_SECRET`, async con webhook). Mantener a Fer en el loop por calidad/NSFW.
- [ ] **Onboarding del 2º proyecto/marca** — validar el multi-proyecto end-to-end (config por marca en `proyectos`, credenciales IG por marca, dominio web).
- [x] **Carrusel** — HECHO (02/06/2026): `cf-crear-pendiente` acepta `media[]`, la preview lo muestra deslizable y `cf-pub-publish` publica carrusel en IG (contenedores hijos + `CAROUSEL`). Primera pieza: "Cuenta regresiva" (4 slides).
- [x] **Poll de status real** en la publicación — HECHO (03/06/2026): reemplazó los `Wait` fijos por consulta de `status_code` hasta `FINISHED` (robusto para Reels). Junto con: no-op en doble disparo y **soporte de Historias** (`formato='story'` → `media_type=STORIES`, fuera de Novedades). Validado el no-op y el intake/exclusión; el publish en vivo (poll/Reel/Story) se prueba con la próxima pieza real.
- [ ] **Backfill de `ig_permalink`** en las publicaciones históricas (requiere el token IG).
- [ ] *(agregar acá lo que vaya surgiendo)*
