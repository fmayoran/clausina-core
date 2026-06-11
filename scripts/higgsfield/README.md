# Higgsfield — Generación de video/imagen con IA para Cortafuego

CLI `higgsfield` (instalada y autenticada en el entorno; cuenta `fernando.mayorano@gmail.com`,
plan ultra). La opera el **`/creativo`** para generar Reels e imágenes de producto que después
entran al circuito de aprobación (`scripts/n8n/README.md`). Detalle técnico de la cuenta/CLI en
`infra/INFRA_CONTEXTO.md` y en la memoria `reference_higgsfield`.

## Receta probada: Reel de producto (primer plano de comida)

Probado el 02/06/2026 con la provoleta al fuego (3 iteraciones hasta la versión final).

### 1. Elegir modelo y precio ANTES de generar
```bash
higgsfield model list --video           # lista de modelos
higgsfield model get seedance_2_0       # params y defaults (aspect_ratio, duration, resolution…)
higgsfield generate cost seedance_2_0 --aspect_ratio 9:16 --duration 5 --resolution 1080p --prompt "x"
```
- **`seedance_2_0`** — mejor relación calidad/precio para comida. 1080p 9:16 5s = **45 créditos**;
  720p = 22.5. Soporta `--genre` (drama/epic/etc.).
- **`kling2_6`** — más barato (10 créditos 9:16 5s), buena opción para pruebas.
- Veo 3/3.1 existen pero son más caros; no hicieron falta para este caso.

### 2. Generar (corre largo → background)
```bash
higgsfield generate create seedance_2_0 \
  --aspect_ratio 9:16 --duration 5 --resolution 1080p --genre drama \
  --prompt "<prompt en INGLÉS, detallado, lenguaje culinario>" \
  --wait --wait-timeout 20m --wait-interval 10s
```
- El **prompt va en inglés** (los modelos rinden mejor); el copy de marca se escribe aparte, en español.
- Devuelve una **URL de CloudFront** (`...cloudfront.net/....mp4`) cuando termina.
- Tarda varios minutos: lanzarlo en background.

### ⚠️ Falso positivo NSFW con comida
Palabras como *oozing, dripping, lava-like, molten, gooey* disparan el filtro y el job termina con
`status "nsfw"` (**no se cobran créditos**). Solución: **reformular en lenguaje culinario neutro**
("perfectly melted", "soft and tender", "golden bubbling edges") y reintentar. Pasó en la v2.

### 3. Acondicionar para Instagram (Reel) + póster
```bash
# Reencode IG-friendly: yuv420p + faststart + pista de audio silenciosa (IG a veces la exige)
ffmpeg -y -i raw.mp4 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -map 0:v:0 -map 1:a:0 -shortest \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 20 -preset slow \
  -c:a aac -b:a 128k -movflags +faststart provoleta_fundicion_vN_YYYYMMDD.mp4

# Póster: un frame del video → WebP (más liviano y pasa el hook de calidad web)
ffmpeg -y -ss 4.6 -i provoleta_..._.mp4 -frames:v 1 -q:v 3 poster.jpg
ffmpeg -y -i poster.jpg -c:v libwebp -quality 82 provoleta_fundicion_vN_YYYYMMDD.webp
```
Seedance 2.0 1080p ya entrega 1080×1920 / H.264 / 24fps, dentro de specs de Reels. El reencode
es por compatibilidad/robustez. Nombre de archivo **único por pieza** (anti-cache).

### 4. Iterar
Cada corrección de Fer se traduce a un ajuste del prompt y se regenera (≈45 créditos por vez).
Evaluar revisando 3 frames (inicio/medio/final) con `ffmpeg -ss <t> -frames:v 1`.

### 5. Meter al circuito de aprobación
```bash
git add assets/landing/publicaciones/<nombre>.mp4 assets/landing/publicaciones/<nombre>.webp
git commit -m "..."; git push origin main          # auto-deploy
# verificar que el MP4 y el WebP devuelvan 200 en https://cortafuego.ar/publicaciones/<...>

curl -s -X POST "$N8N/webhook/cf-crear-pendiente" -H "Content-Type: application/json" -d '{
  "titulo_interno": "...", "tipo_media": "video",
  "asset_ig": "https://cortafuego.ar/publicaciones/<nombre>.mp4",
  "poster_url": "https://cortafuego.ar/publicaciones/<nombre>.webp",
  "caption": "...con tildes y ñ...", "web_titulo": "...", "web_copy": "...",
  "web_tags": ["..."], "intentos": 0
}'                                                  # devuelve {token}
curl -s "$N8N/webhook/cf-pub-notify?token=<token>" # mail a Fer con la preview
```
- `asset_ig` guarda la **URL del MP4** (el workflow `cf-pub-publish` la usa como `video_url` del Reel).
- El **caption debe llevar tildes/ñ** (JSON + curl son UTF-8; no hace falta escapar los acentos).
- `N8N=https://crm-n8n.dhmtev.easypanel.host`. Webhooks y campos: `scripts/n8n/README.md`.

## Edición de imagen por instrucción (sacar/limpiar objetos, "más cinematográfico")
Cuando el brief o un rechazo pide **editar una foto** (borrar elementos, destacar, look cinematográfico),
usar un modelo de **edición por instrucción** sobre la imagen (NO regenerar de cero):
```bash
higgsfield generate create nano_banana_2 --image <ruta_o_url> --aspect_ratio 9:16 --resolution 2k \
  --prompt "Remove the cardboard next to the sausages and clutter in the mid-ground; keep the meat, the CORTAFUEGO sign and the lit soccer field; cinematic warm moody night barbecue, photorealistic" \
  --wait --wait-timeout 8m
```
- `nano_banana_2` (Nano Banana Pro) ≈ **2 créditos**, soporta `--image` + `aspect_ratio` 9:16 + `2k/4k`. Devuelve una **URL PNG**. Probado 04/06/2026 (sacó un cartón y un rollo manteniendo carne/cartel/cancha, look cine). Alternativas de edit: `nano_banana`, `flux_kontext`. Prompt en **inglés**; verificá el PNG antes de seguir.

## Texto de marca horneado en el video/imagen (Stories planas, placas)
La API de IG no permite stickers/texto en Stories → el texto va **horneado**. Hacerlo SIEMPRE con la
**tipografía de marca**, no con `drawtext`/fuente del sistema:
1. Componer el texto en **HTML** con las fuentes self-hosted (`assets/landing/fonts/`, **Barlow Condensed 900**) y los colores de marca (naranja `#ff4400`, hueso `#f5f2ec`, fondo `#080806`); usar un **degradé inferior** para legibilidad.
2. Renderizar un **PNG transparente** con Playwright (`omitBackground:true`, chromium en `/root/.cache/ms-playwright/...`).
3. Superponer con ffmpeg (`-loop 1` sobre la imagen/clip; `fade` de alpha; opcional slow-zoom `zoompan` y audio ambiente con `loudnorm`). Salida 1080x1920 yuv420p + faststart. Ver placas existentes como referencia.

## Pendiente
Integrar la **API REST** de Higgsfield en n8n (auth `Authorization: Key KEY_ID:KEY_SECRET`, async con
webhook `X-Webhook-URL`) para que la rutina/el pipeline generen contenido solos. Ver `infra/INFRA_CONTEXTO.md`.
