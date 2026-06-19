# Brief por voz (dictado) → pieza pendiente

Instrucciones para **Claude Code headless** cuando `brief_local.sh` (cron en el VPS) procesa un brief
que Fer mandó por Telegram (audio + foto/video opcional). Corre como **Director Creativo del proyecto** (su identidad, voz y estética están en `contexto/CONTEXTO_MARCA.md` y el `CLAUDE.md` del directorio actual).

**NUNCA publicar en Instagram.** El brief termina en una pieza `pendiente_aprobacion`; el OK lo da Fer.

## Lo que recibís (en el prompt)
- `brief`: el texto del pedido (transcripción del audio + caption si vino). Es lo que Fer dictó.
- `materiales`: **lista** de archivos aportados desde el panel, en orden: `[{path, media_type}]` (`photo`|`video`). **Usalos TODOS**: si son varias fotos para Instagram, armá un **carrusel** respetando el orden. Es la fuente preferente de material.
- `media`: ruta local de un único adjunto legacy (respuesta por Telegram) o vacío. **Fallback**: usalo solo si `materiales` está vacío. `media_type`: `photo`|`video`|vacío.
- `comentarios`: indicaciones de Fer sobre el material (cuál va de portada, recortes, orden, tono…). **Respetalas.**
- `chat_id`, `brief_id`: para referencia/avisos.
- Base n8n: `https://crm-n8n.dhmtev.easypanel.host`. El **cwd es la cápsula de la marca** (`marcas/<slug>`): trabajá SIEMPRE dentro de ella.

## Tono de marca (leer SIEMPRE)
Leé `contexto/CONTEXTO_MARCA.md`, `contexto/REFERENCIAS_INSTAGRAM.md` y el `CLAUDE.md` del proyecto (cwd),
y aplicá EXACTAMENTE su voz, sus reglas de copy (menciones, hashtags, nombres propios, uso del slogan, emojis sí/no)
y su estética. **No uses reglas ni datos de otra marca**: lo que no esté en el contexto de ESTA marca, no va.

## Pasos
1. **Interpretá el brief**: qué publicar, **formato** (`feed` imagen/Reel/carrusel, o `story`), ángulo, datos, y el copy.
2. **Media**:
   - **Foto** (`media_type=photo`): acondicionar a JPG (4:5 o como venga), **nombre único** en `assets/landing/publicaciones/`, `git add/commit/push`, esperar el deploy y verificar `200 image/jpeg`. Esa URL es el `asset_ig`.
   - **Video** (`media_type=video`): acondicionar según la receta (Reel o Story; `scripts/higgsfield/README.md` para el reencode; placas/overlay con la estética de marca si el brief lo pide). Subir mp4 + poster WebP, push, verificar 200. Para **Story** con texto/sonido: **hornear** el texto y el audio en el video (la API no soporta stickers).
   - **Si el brief pide editar la foto** ("sacá/borrá X", "destacá Y", "más cinematográfico"): **editala con Higgsfield** (`nano_banana_2 --image`, ver `scripts/higgsfield/README.md` → "Edición de imagen por instrucción"); verificá el PNG resultante.
   - **Texto horneado SIEMPRE con la tipografía y colores de la marca** (según el contexto de marca, vía HTML/Playwright; NO `drawtext`). Receta en `scripts/higgsfield/README.md` → "Texto de marca horneado". Cuidá que el texto **no tape lo importante** (la comida).
   - **Sin media**: si el brief lo permite, generá un **hero de producto con Higgsfield** (image-to-video / nano_banana, ver receta); si hace falta material real que no tenés, **no inventes el evento**: avisá a Fer (`POST /webhook/cf-avisar` con `{asunto,cuerpo}`) explicando qué material necesitás y terminá.
3. **Redactá** caption (con las menciones y hashtags que indique el contexto de marca), `web_titulo`, `web_copy`, `web_tags` con la voz de marca.
4. **Insertá** la pieza: `POST /webhook/cf-crear-pendiente` (un solo `curl`, JSON inline; `\n` para saltos del caption) con:
   `{"titulo_interno":"...","formato":"feed|story","caption":"...","web_titulo":"...","web_copy":"...","web_tags":["..."],"media":[{"url":"<URL pública>","tipo":"image|video","poster_url":"<URL webp si es video>"}],"brief_id":"<el brief_id que recibiste>"}`
   → devuelve `{token}`. **Incluí siempre `brief_id`**: vincula el requerimiento con la pieza (correlación en el panel) y marca el brief como procesado. El **número de pieza (CF-NNNN) lo asigna la base sola**; el `titulo_interno` es solo descriptivo.
5. **Notificá**: `GET /webhook/cf-pub-notify?token=<token>` (manda la tarjeta de Telegram a Fer; el mail dejó de ser operativo).
6. Resumí en una línea qué hiciste.

## Reglas
- Nombre de archivo **único por pieza** (anti-cache).
- Si algo no se entiende del brief o falta info clave, **avisá a Fer** (`cf-avisar`) en vez de inventar.
- Ante cualquier error, `cf-avisar` y terminar; no dejar la pieza a medias.
