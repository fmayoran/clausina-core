# Panel de publicaciones — `cortafuego.ar/panel`

App web para **operar** el circuito de publicaciones de Cortafuego: ver la cola de requerimientos,
las piezas pendientes y las publicadas, y **aprobar / rechazar / descartar** desde un solo lugar.
Reemplaza al mail como herramienta operativa (el mail quedó solo para el resumen diario).

## Stack y deploy
- **Node 20 + Express + `pg`** (sin frameworks de front; HTML/CSS/JS estático con la estética de marca).
- Toda la SQL vive en `db.js` (capa aislada → portar a FastAPI a futuro = reescribir solo el server).
- Corre como contenedor **`cf-panel`** (no EasyPanel; `docker run` con `--restart unless-stopped`),
  conectado a las redes `easypanel-crm` (DB) y `easypanel` (para que el Nginx de la landing lo proxee).
- El **Nginx de la landing** lo sirve en `cortafuego.ar/panel/` (bloque `location ~ ^/panel/` en `nginx.conf`).
- **Deploy / update:** `bash panel/deploy.sh` (rebuild de la imagen + recrea el contenedor + reconecta redes).
  > Recrear el contenedor cambia su IP; el Nginx la recachea en ~30s (resolver `valid=30s`), así que hay
  > un parpadeo breve tras cada deploy.
- **Credenciales / config:** `/root/cf-panel.env` (fuera de git, `chmod 600`). Variables:
  `PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD`, `TELEGRAM_BOT_TOKEN`, `PANEL_TG_CHAT`,
  `PANEL_PASSWORD`, `PANEL_SECRET`, `PANEL_COOKIE_PATH=/panel`.

## Trabajo desde Claude Code
- Rama de trabajo actual: `claude-panel-global`.
- Abre el folder `plataforma` en VS Studio y asegúrate de estar en `claude-panel-global`.
- Archivos clave:
  - `core/panel/public/index.html` — home/dashboard principal.
  - `core/panel/public/panel.js` — lógica compartida del panel.
  - `core/panel/deploy.sh` — script de despliegue EasyPanel.
- Flujo recomendado:
  1. editar en VS Studio.
  2. guardar cambios.
  3. en la terminal integrada:
     ```bash
     cd /root/claudefolder/core
     git status
     git add core/panel/public/index.html core/panel/public/panel.js core/panel/deploy.sh
     git commit -m "panel: <lo que cambiaste>"
     git push
     ```
  4. para desplegar en la plataforma real:
     ```bash
     cd /root/claudefolder/core/panel
     ./deploy.sh
     ```
  5. verificar:
     ```bash
     docker service ps clausina_panel
     curl -I -L -s https://panel.clausina.ar/
     ```
- Si necesitás ver cambios rápidos antes de deploy, usa el editor y prueba localmente con `git diff` y `git status`.

## Seguridad (login de marca + sesión)
- Pantalla de login (`public/login.html`) con la estética Cortafuego. Contraseña compartida (`PANEL_PASSWORD`).
- Sesión por **cookie firmada con HMAC** (`PANEL_SECRET`, 14 días). Botón **Salir** y manejo de `401 → login`.
- **Compuerta** sobre todo (ver + acciones). Públicos solo: `/api/health`, `/login` y las fuentes.
- Rotar el secreto (`PANEL_SECRET`) invalida todas las sesiones de golpe. Evolución prevista: SSO/Google.

## Columnas (board, autorefresh 6s)
1. **Cola de Requerimientos de Publicación** — requerimientos en curso, con miniatura y **estado derivado en vivo**
   (combina el estado del brief + el de la pieza que generó): _En cola → Procesando → Pieza pendiente → Rechazada·reprocesando_.
   Se mantiene hasta que la pieza llega a estado terminal (publicada/descartada). Incluye las **propuestas del creativo**.
2. **Pendiente de aprobación** — piezas a decidir: miniatura grande, **copy completo**, número **CF-NNNN**,
   `rev N` (rev>1 = vino de un rechazo). Acciones: **Aprobar y publicar / Rechazar / Descartar**.
3. **Publicada** — tarjetas compactas (miniatura + CF-NNNN + fecha + **vistas · alcance · likes** + link a Instagram).
   Las métricas vienen de `contenido.ig_metricas`, que el server refresca cada 30 min desde `graph.instagram.com`
   (insights de nuestra propia cuenta; `IG_TOKEN`/`IG_USER_ID` en el env). Las Stories viejas no muestran (insights efímeros).

Arriba, una **barra de status** con el latido de los procesos batch (última corrida / próxima) leído de
`contenido.batch_runs`.

## Propuestas del creativo (la cola se nutre sola)
- Botón **"Pedir propuestas al creativo"** + campo de **énfasis** → inserta en `contenido.solicitudes_propuesta`.
- El cron `scripts/propuestas_local.sh` corre al creativo headless, que **carga propuestas** en la cola
  (`tg_briefs.origen='creativo'`, `estado='propuesta'`) y las manda a Telegram.
- Cada propuesta muestra concepto + **"Necesita: …"** y acciones: **Aportar material** (subís archivo → va al bot
  como documento → queda como `media_file_id`) · **Activar** (si no requiere material) · **Descartar**.
- También se aporta material **respondiendo** la propuesta en Telegram (cf-telegram `esMaterial` la vincula por `tg_msg_id`).
- Cualquiera de las dos vías pasa la propuesta a `pendiente` → entra al circuito normal → **aprobación manual** intacta.

## API
| Método | Ruta | Qué hace |
|--------|------|----------|
| GET  | `/api/health` | Liveness (público). |
| GET  | `/api/piezas` | Piezas + revisión vigente + media principal (board). |
| GET  | `/api/requerimientos` | Cola: briefs/propuestas + correlación a la pieza + estado derivado. |
| GET  | `/api/status` | Latido de los batch (`batch_runs`) + próxima corrida estimada. |
| GET  | `/api/brief/:id/media` | Proxy de la miniatura (resuelve el `file_id` de Telegram server-side). |
| POST | `/api/login` · `/api/logout` | Sesión. |
| POST | `/api/piezas/:id/aprobar` · `/rechazar` · `/descartar` | Acciones sobre la pendiente (resuelve el token y llama a n8n: `cf-pub-publish` / `cf-pub-decide`). |
| POST | `/api/proponer` | Encola un pedido de propuestas (con `enfasis`). |
| POST | `/api/requerimientos/:id/material` | Sube material (base64 → bot → `file_id`) y activa la propuesta. |
| POST | `/api/requerimientos/:id/activar` · `/descartar` | Activa una propuesta sin material / la saca de la cola. |

> Las acciones nunca publican directo: resuelven el `token` de la revisión y llaman a los **mismos webhooks**
> que usan Telegram y la preview. La aprobación manual antes de publicar es el único disparador real.
