# Rutina automática — Regenerar publicaciones rechazadas (flujo HTTP)

Corre **cada 5 minutos por cron en el VPS** (`scripts/rutina_local.sh`), invocando **Claude Code headless** (`claude -p`, sobre la suscripción, sin costo de API). El script hace un chequeo barato (`curl cf-rechazos-pendientes`) y **solo invoca a Claude si hay rechazos**; luego **rutea por proyecto** (una corrida de Claude por marca, en su cápsula, filtrando por `revision_id`). Actúa como Director Creativo del proyecto cuya cápsula es el directorio actual.
**Nada se publica sin la aprobación de Fer** (lo regenerado vuelve a la preview).

> **Por qué cron local y no `/schedule` (02/06/2026):** la rutina de la nube (`/schedule`, `trig_016PJteF4kHjmwP16eMubYx3`) nunca funcionó porque el entorno remoto tiene una **allowlist de red** que bloquea el host de n8n, y además tiene **límite de ejecuciones/día**. El VPS no tiene sandbox y Claude Code ya está instalado y logueado ahí, así que el cron local resuelve ambas cosas gratis. Esta doc son las **instrucciones que sigue el agente**; el orquestador es `rutina_local.sh`.

> **Modelo de datos (desde 02/06/2026):** schema `contenido` (base `claude`), tablas `proyectos`/`piezas`/`revisiones`/`media`. Una corrección = una **revisión nueva** bajo la misma pieza. La cola de rechazos solo muestra revisiones `rechazada` que son la **vigente** de su pieza y **no** fueron derivadas a Fer. Al crear una revisión nueva (corrección), la rechazada deja de ser vigente y **sale sola de la cola** (no hay que marcar nada).

## Tono de marca (leer del directorio actual)
Antes de redactar, leer `contexto/CONTEXTO_MARCA.md`, `contexto/REFERENCIAS_INSTAGRAM.md` y el `CLAUDE.md` del proyecto, y aplicar EXACTAMENTE su voz, reglas de copy (menciones, hashtags, nombres propios, uso del slogan, emojis sí/no) y estética. **No uses datos ni voz de otra marca**: lo que no esté en el contexto de ESTA marca, no va.

## Endpoints (base: `https://crm-n8n.dhmtev.easypanel.host`)
- `GET /webhook/cf-rechazos-pendientes` → JSON array de rechazos sin procesar. Cada item: `pieza_id, revision_id, titulo_interno, **canal** (instagram|aviso), asset_ig, media_tipo, poster_url, caption, web_titulo, web_copy, web_tags, daypart, clima, transito, momento, duracion_s, motivo_rechazo, intentos`. Si `[]`, no hay nada que hacer.
- `POST /webhook/cf-crear-pendiente` (body JSON) → crea la corrección como **revisión nueva** de la misma pieza y la deja `pendiente_aprobacion`. Devuelve `{token}`. **Mandar siempre `pieza_id`** (es lo que la encadena y supera a la rechazada). Body:
  ```json
  {"pieza_id":"<pieza_id del rechazo>","titulo_interno":"...","asset_ig":"<misma URL>","caption":"...","web_titulo":"...","web_copy":"...","web_tags":["..."],"tipo_media":"image","notas":"qué se corrigió"}
  ```
- `GET /webhook/cf-pub-notify?token=<token>` → manda a Fer el mail con el link a la preview.
- `GET /webhook/cf-marcar-procesado?id=<revision_id>` → marca esa **revisión** como **derivada a Fer** (`derivado_en`); sale de la cola sin crear corrección. Usar solo en el caso de escalado (abajo).
- `POST /webhook/cf-avisar` (body `{"asunto":"...","cuerpo":"..."}`) → manda un mail a Fer.

## Flujo (cada ejecución)
1. `GET cf-rechazos-pendientes`. Si `[]` → **terminar** (caso normal).
> **Material aportado al rechazar:** cuando Fer rechaza desde el panel puede adjuntar imágenes/videos. El runner (`rutina_local.sh`) ya los descarga al VPS y te los pasa en el prompt como `MATERIAL APORTADO POR FER AL RECHAZAR`, agrupado por `pieza_id` (rutas locales). Si un rechazo tiene material acá, **usalo** en la corrección visual (partí de esos archivos en lugar de inventar o de pedir material). Sale de `contenido.brief_material` del brief que generó la pieza (`brief.pieza_id`).

2. Para cada rechazo:
   a. **Límite (ambos canales):** si `intentos >= 5` → `cf-avisar` ("No pude resolver tras 5 intentos: <titulo>. Motivo: <motivo>. Necesito tu intervención.") → `cf-marcar-procesado?id=<revision_id>` → siguiente.
   b. **Ruteo por `canal`:**
      - Si **`canal == 'aviso'`** → corrección de **aviso de pantalla** (ver sección *Corrección de avisos* abajo) → siguiente.
      - Si **`canal == 'instagram'`** → clasificar el `motivo_rechazo` (abajo).
   c. **Clasificar el `motivo_rechazo`** (solo Instagram):
      - **De TEXTO** (copy/caption/título/datos/tono): redactar la versión corregida (caption, `web_titulo`, `web_copy`, `web_tags`) **reusando la misma imagen** (`asset_ig` igual). `POST cf-crear-pendiente` **con `pieza_id`** y los textos nuevos (`notas` = qué se corrigió). Con el `{token}` que devuelve: `GET cf-pub-notify?token=<token>`. **No hace falta marcar nada**: la revisión nueva supera a la rechazada y sale de la cola sola.
      - **VISUAL editable** (tipografía/colores fuera de marca, "el texto tapa la comida", "sacá/borrá X", "más cinematográfico", reencuadre, otro texto): **corregilo vos editando la pieza**. Partí de la media base (descargá `asset_ig`), editá la imagen con Higgsfield si hace falta (`nano_banana_2 --image`, ver `scripts/higgsfield/README.md` → *Edición de imagen por instrucción*) y/o rehorneá el texto con la **tipografía de marca** (ver *Texto de marca horneado*). Acondicioná a 9:16 si es Story/Reel, subí (commit+push, verificá 200) y reenviá como **revisión nueva** con `POST cf-crear-pendiente` **+ `pieza_id`** (incluí el `media` nuevo + `formato` si es story) → `GET cf-pub-notify?token=<token>`. La rechazada sale sola de la cola.
      - **Material faltante que NO tenés** ("mandame otra foto de X", "necesito una toma del salón", falta un asset real): primero fijate si Fer adjuntó material al rechazar (`MATERIAL APORTADO…` en el prompt, por `pieza_id`); si está, usalo. Si no hay y no lo tenés, NO inventes: `cf-avisar` pidiendo el material → `cf-marcar-procesado?id=<revision_id>`.
   c. Si el motivo es ambiguo, intentá la corrección visual; si genuinamente no se puede sin material nuevo, avisá a Fer y derivá.
3. Terminar. Resumir en el log qué se hizo.

## Corrección de avisos (`canal == 'aviso'`)
Actuás como **Editor de Video** (`/editor`). Leé `/root/.claude/skills/editor/SKILL.md` y `scripts/brief_aviso.md`.
- **Regenerá el spot** según el `motivo_rechazo`: produce un nuevo **mp4 2:3 (1080×1620), ~10s, mudo**, con la estética de marca y la tipografía horneada (logo SOLO el oficial `interior-graficas/entregables/Logo.png`). Partí del spot actual (`asset_ig`) y/o de Higgsfield/clips de fuego según lo que pida el motivo.
- Guardá el mp4 + poster (`.webp`/`.jpg`) en `assets/landing/publicaciones/` con **nombre único nuevo**, `git add` + commit + push y verificá **200** (la landing los sirve público).
- Reenviá como **revisión nueva**: `POST cf-crear-pendiente` con **`pieza_id`** + `formato:"feed"` + el `media` nuevo (`url` pública `https://cortafuego.ar/publicaciones/<archivo>.mp4`, `tipo:"video"`, `poster_url`) + los **tags de contexto** (`daypart`/`clima`/`transito`/`momento`/`duracion_s`, reusá los del rechazo salvo que el motivo los cambie). **NO** mandes `cf-pub-notify` (eso es de Instagram).
- Avisá: `POST cf-avisar {"asunto":"Aviso de pantalla corregido","cuerpo":"Revisá y aprobá en https://cortafuego.ar/panel/avisos"}`.
- Material que NO tenés / intentos>=5: igual que Instagram → `cf-avisar` + `cf-marcar-procesado`.

## Reglas
- La rutina **solo propone**; el OK final es de Fer (preview). Nunca llamar a publicar.
- Corrección de texto = **nueva revisión con `pieza_id`** (encadena y supera). Escalado a Fer = `cf-marcar-procesado` (deriva). Nunca dejar un rechazo sin una de las dos acciones, o se reprocesa cada hora.
- Si en el futuro se regeneran imágenes, usar nombre de archivo único por versión (la media de la pieza se reemplaza por la de la última revisión).
- Ante cualquier error inesperado, `cf-avisar` a Fer y terminar; no dejar piezas a medias.
