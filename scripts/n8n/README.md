# n8n — Sistema de publicación de Cortafuego

n8n del VPS: **https://crm-n8n.dhmtev.easypanel.host** (API v1 con `N8N_API_KEY` del `.env`).
Conecta a PostgreSQL por el host **`crm_pgvector`** (red Docker), base **`claude`**, schema **`contenido`**
(modelo multi-proyecto proyectos/piezas/revisiones/media — ver `scripts/db/README.md`).
Los workflows están exportados en `workflows/*.json` (fuente versionada; el estado real vive en n8n).

> **Modelo `contenido` (desde 02/06/2026):** las queries leen/escriben `contenido.revisiones` + `piezas` + `media`, devolviendo **los mismos alias** que antes (`asset_ig`, `caption`, `web_*`, `estado`, `tipo_media`, `poster_url`, `titulo_interno`…), por eso `preview.html`/`novedades.html` no cambiaron. `cf-crear-pendiente` ahora acepta `pieza_id` opcional: con él agrega una **revisión** a la pieza existente (loop de corrección) y **reemplaza la media**; sin él crea pieza nueva. La cola `cf-rechazos-pendientes` solo muestra revisiones `rechazada` que son la **vigente** de su pieza y sin `derivado_en`: una corrección (nueva revisión) las supera y salen solas; **`cf-marcar-procesado` se repurposeó** para *derivar a Fer* (setea `derivado_en` por `revision_id`) los rechazos que la rutina no puede auto-resolver (visuales / ≥3 intentos), así dejan de reprocesarse.

> **Carrusel (desde 02/06/2026):** `cf-crear-pendiente` acepta `media`: un array `[{url,tipo,poster_url}, …]` (varias imágenes); sin él usa el `asset_ig` único. `cf-pub-data` devuelve el array `media` (la preview lo muestra como carrusel deslizable). `cf-pub-publish` ramifica: si la pieza tiene >1 media, crea un contenedor hijo por imagen (`is_carousel_item=true`), arma el contenedor `CAROUSEL` con los `children` y publica; con 1 media sigue el camino imagen/Reel de siempre.

> **Endurecimiento del publicador (03/06/2026):** `cf-pub-publish` se rehízo (26 nodos, builder `scripts/n8n/build_cf_pub_publish.py`) con tres mejoras: **(1) no-op en doble disparo** — si `Aprobar` no transiciona nada (pieza ya decidida), corta limpio con "ya fue decidida" en vez de errar (importante con 2 canales mail+Telegram); **(2) poll de status real** — reemplaza los `Wait` fijos: tras crear el contenedor, consulta `GET /{id}?fields=status_code` cada 5s hasta `FINISHED` (o corta en `ERROR/EXPIRED`) y recién ahí `media_publish` (robusto para Reels que tardan variable); **(3) Historias** — `formato='story'` (columna en `revisiones`) rutea a `media_type=STORIES` (imagen o video). Las Historias **no van a Novedades** (`cf-novedades` filtra `formato='feed'`) ni tienen permalink estable (efímeras 24h). `cf-crear-pendiente` acepta `formato`; `cf-pub-data`/`cf-pub-notify` lo traen (la tarjeta de Telegram marca `[HISTORIA]`). Limitación: por API las Historias salen "planas" (sin stickers/encuestas/links/música); eso es manual.

> **Etiqueta + Collab automáticos (04/06/2026):** cada contenedor de feed (`ContainerImg`/`ContainerReel`/`CarouselCont`) suma `collaborators` (invitación a Collab) y `user_tags` (etiqueta en la pieza) con los handles de `contenido.proyectos.ig_colaboradores` (para Cortafuego: `{ardora.ar}`). `Aprobar` trae la lista; las expresiones arman el JSON (`["ardora.ar"]` / `[{"username":"ardora.ar","x":..,"y":..}]`). Verificado que la Graph API los acepta y que el `text[]` llega como array. **Caveat:** el Collab requiere que el aliado **acepte** cada invitación. Las **Historias no** se etiquetan por API → la mención `@ardora.ar` va **horneada** en el texto del video.

## Credenciales (creadas vía API, cifradas en n8n)
- **Postgres Cortafuego (claude)** (`DRC5p50dRb5kYMOn`): host `crm_pgvector`, db **`claude`**, user `postgres`. Es la credencial activa de los 8 workflows (desde la mudanza del 02/06/2026). La vieja `Cortafuego PostgreSQL` (`OpXcQp95dbNVXbCP`, db `crm`) quedó sin uso; la API pública de n8n no permite editar credenciales, por eso se creó una nueva y se reapuntaron los nodos (script `rewire_claude.py`).
- **Cortafuego SMTP** (`58C2JQ1ZFSV3GIxk`): `smtp.gmail.com:465`, `asador.cortafuego@gmail.com`.
- **Cortafuego IG Token** (`ZqmyQ7hDQYu8xWC9`, tipo `httpQueryAuth`): agrega `?access_token=…` a la Graph API; restringida a `graph.instagram.com`. El token NO está en git ni en la DB, solo cifrado en n8n. `IG_USER_ID` (público) va en `cf-pub-publish`.
- **Cortafuego Telegram** (`zvxU9F3XDpRNBsYa`, tipo `telegramApi`): bot `@cf_ig_bot` (2º canal de aprobación). El token vive cifrado en n8n (no en git/DB). El `chat_id` de Fer está en `contenido.proyectos.telegram_chat_id`.

## Canal Telegram (2º canal de aprobación, además del mail)
- **Envío**: `cf-pub-notify` manda una tarjeta al bot (`sendPhoto` con la imagen/poster + caption + botones inline **✅ Aprobar / ✖️ Rechazar / 🗑 Descartar** y un botón **Ver completo** → `preview.html`). El `callback_data` lleva `ap:<token>` / `re:<token>` / `de:<token>`. *(El mail operativo de aprobación se quitó el 05/06/2026 — ahora la operación es por Telegram y panel; ver `cf-resumen-diario`.)*
- **Recepción**: `cf-telegram` (id `Jl9J93tQ3t6qNRdN`, webhook `/webhook/cf-telegram`, registrado con `setWebhook` del bot). Maneja:
  - `ap:<token>` → llama `cf-pub-publish` (publica) → avisa "Publicada".
  - `re:<token>` → guarda un pendiente en `contenido.tg_pending (chat_id→token)` y pide el motivo.
  - próximo **mensaje de texto** de ese chat → se toma como el motivo: `cf-pub-decide` lo registra (entra al loop de auto-corrección) y limpia `tg_pending`.
  - `de:<token>` → `cf-pub-decide?accion=descartar` → estado terminal `descartada` (no publica ni entra a la rutina de corrección). Un paso, sin motivo.
  - **Material para una propuesta**: un mensaje con foto/video que es **respuesta** a una propuesta → `esMaterial` busca el requerimiento por `tg_msg_id`, le setea la media y lo pasa a `pendiente` (entra al circuito). Si no matchea una propuesta, cae como requerimiento nuevo.
- Telegram y panel conviven; aprobar/rechazar/descartar por cualquiera funciona igual (idempotente por `estado='pendiente_aprobacion'`).

## Workflows ACTIVOS
| Webhook | id | Función |
|---------|----|---------|
| GET `/webhook/cf-pub-data?token=` | `L5AFTcvyJZNovYNI` | JSON de la publicación para `preview.html` (incluye `tipo_media`, `poster_url`). CORS `*`. |
| GET `/webhook/cf-pub-decide?token=&accion=rechazar\|descartar&motivo=` | `ogJzV8mnp2Dc5Aog` | `rechazar`: marca `rechazada` + `motivo_rechazo` (entra a auto-corrección). `descartar`: marca `descartada` (estado terminal, fuera de la rutina). Usado por preview, panel y Telegram. |
| GET `/webhook/cf-pub-notify?token=` | `JSGztXR051Z1eJm0` | Manda la tarjeta de aprobación a Telegram (Aprobar/Rechazar/Descartar). Ya **no** manda mail operativo. |
| _schedule 07:00 ART_ `cf-resumen-diario` | `YdxV0C1rNGzdKwFh` | Mail diario con lo publicado **el día anterior** (+ pendientes si hay). No manda nada si no hubo publicaciones. Reemplaza al mail operativo. |
| GET `/webhook/cf-pub-publish?token=` | `xosqlg1QJm8LVUKQ` | **Aprueba → publica**. IF por `tipo_media`: **video → Reel** (`media_type=REELS`, `video_url`, Wait 55s) · **imagen → IMAGE** (Wait 6s) → `media_publish` → guarda `ig_post_id` → `publicada`. Botón Aprobar de la preview. |
| GET `/webhook/cf-novedades` | `aeqZE34UMClFeqc5` | Feed de novedades publicadas (con `tipo_media`/`poster_url`) para `novedades.html`. |
| GET `/webhook/cf-rechazos-pendientes` | `x1WlWHd4jNkWgizC` | Array de rechazos sin procesar (`estado='rechazada' AND regenerada_en IS NULL`). Para la rutina. |
| POST `/webhook/cf-crear-pendiente` | `1Et3mWFjEEfwIN1p` | Crea una pieza `pendiente_aprobacion` desde un body JSON (incluye `tipo_media`/`poster_url`). Devuelve `{token}`. Acepta `pieza_id` (nueva revisión, reusa media), `brief_id` (vincula el requerimiento), `canal_pieza` (`instagram`\|`aviso`) y, para avisos, `daypart`/`clima`/`transito`/`momento`/`duracion_s`. Para la rutina, los briefs y el editor. |
| GET `/webhook/cf-marcar-procesado?id=` | `dxlBH6UHHFjp60qN` | Marca un rechazo como `regenerada_en=now()`. Para la rutina. |
| POST `/webhook/cf-avisar` | `HAUrbEF6zpIWecIn` | Manda un mail a Fer (`{asunto,cuerpo}`). Para la rutina. |

Recrear: `curl -X PUT -H "X-N8N-API-KEY: $KEY" .../api/v1/workflows/<id> --data @workflows/<n>.json` + `POST .../activate`.

> **Gotcha — parámetros del nodo Postgres (`queryReplacement`):** si se pasan como varias expresiones separadas por coma (`={{a}},={{b}},={{c}}`), n8n parte el resultado **por todas las comas**, incluidas las que estén dentro de un valor de texto. Eso truncaba el `motivo` de rechazo en su primera coma (corregido 02/06/2026 en `cf-pub-decide`). **Pasar siempre los parámetros como array**: `={{ [a, b, c] }}`. Un solo parámetro string (`={{ JSON.stringify($json.body) }}`) es seguro porque no hay coma de separación.

## Flujo de publicación
1. El `/creativo` prepara la pieza (imagen WebP o video MP4 en `publicaciones/`, con **nombre único**), pasa el *Checklist de calidad*. Para video: `tipo_media='video'` + `poster_url` (un frame).
2. INSERT en `cortafuego.publicaciones` con `estado='pendiente_aprobacion'` → `token`.
3. `curl ".../webhook/cf-pub-notify?token=<token>"` → mail a Fer.
4. Fer abre `preview.html?token=…` (carga vía **proxy same-origin** `cortafuego.ar/n8n/…`, así funciona en la app de Gmail) y:
   - **Aprobar y publicar** → `cf-pub-publish` (imagen al instante; **Reel ~1 min** por el procesamiento del video).
   - **Rechazar** → la preview pide un **motivo** → `cf-pub-decide` lo guarda.

## Loop de iteración (rechazo → corrección → reenvío)
La pieza vieja queda `rechazada` con `motivo_rechazo`. El `/creativo` (o la rutina) consulta los rechazos pendientes, corrige según el motivo y reenvía una nueva pieza pendiente (`intentos+1`). Idempotencia por `cf-marcar-procesado` (`regenerada_en`).

## Rutina automática
Trigger `/schedule` `trig_016PJteF4kHjmwP16eMubYx3` (cada hora, autocontenida sin repo). Flujo en `../rutina_regenerar_rechazos.md`: regenera rechazos de **texto** sola; **visual/material** → avisa a Fer. **Estado: en diagnóstico** (la corrida de prueba no procesó el rechazo).

## Mejoras pendientes
- Guardar el `ig_permalink` real de cada post (hoy el link de Novedades va al perfil).
- Reemplazar el Wait fijo (6s/55s) por un poll de `status_code` (robustez, sobre todo Reels).
- Multi-tenant: parametrizar por `proyecto` para clonar el sistema en otra marca.
