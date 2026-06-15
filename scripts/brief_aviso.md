# Requerimiento de AVISO de pantalla (DOOH) → pieza pendiente (canal=aviso)

Instrucciones para **Claude Code headless** cuando `brief_local.sh` procesa un requerimiento con
`canal_destino='aviso'`. Corrés como **Editor de Video** (`/editor`): producís un **spot para la
pantalla de calle** (DOOH).

**NUNCA publicás.** Termina en una pieza `canal=aviso`, `pendiente_aprobacion`; el OK lo da Fer en
el panel (sección Avisos del proyecto).

## Leé primero
- El skill del editor: `/root/.claude/skills/editor/SKILL.md` (specs de la pantalla, reglas DOOH, pipeline, **logo oficial**).
- `contexto/CONTEXTO_MARCA.md` y `scripts/higgsfield/README.md`.

## Lo que recibís
`/tmp/brief_ctx.json`: `brief` (qué aviso quiere Fer), `media` (ruta de foto/video que aportó, o vacío),
`media_type`, `chat_id`, `brief_id`.

## Producí el spot (pipeline del SKILL)
- Salida: **mp4 H.264 1080×1620 (2:3), ~10 s, loop, SIN audio**, diseñado bold para LED.
- Base: la media aportada (reencuadrá a 2:3) o Higgsfield / clips de fuego de `assets/landing/publicaciones/` si no hay.
- **Texto de marca HORNEADO** con la tipografía y colores de la marca (ver `contexto/CONTEXTO_MARCA.md` y el `CLAUDE.md` del proyecto). Si insertás el **logo**, usá SOLO el archivo oficial de la marca (nunca uno inventado/IA).
- Guardá el mp4 + un poster (`.webp`/`.jpg`) en **`assets/landing/publicaciones/`** con nombre único `aviso_<slug>_<momento>_<fecha>.mp4`, hacé **git add + commit + push** y **verificá 200** (la landing los sirve público, como las piezas de Instagram).

## Registrá la pieza (un solo curl a cf-crear-pendiente)
`POST /webhook/cf-crear-pendiente` con:
```
{
 "titulo_interno":"...", "canal_pieza":"aviso", "formato":"feed",
 "caption":"<texto/nota del aviso>",
 "daypart":"manana|mediodia|tarde|noche|cualquiera",
 "clima":"frio|lluvia|calor|cualquiera",
 "transito":"alto|normal|cualquiera",
 "momento":"pre-apertura|apertura|promo-relampago|generico",
 "duracion_s":10,
 "media":[{"url":"https://<dominio-de-la-marca>/publicaciones/<archivo>.mp4","tipo":"video","poster_url":"https://<dominio-de-la-marca>/publicaciones/<archivo>.webp"}],
 "brief_id":"<el brief_id>"
}
```
La `url` de media es la **pública de la landing de la marca** (su `dominio_web`, ver `contexto/CONTEXTO_MARCA.md`).

## Avisá a Fer (la aprobación es por el panel, sin botones)
`POST /webhook/cf-avisar {"asunto":"Nuevo aviso de pantalla pendiente","cuerpo":"Revisá y aprobá en el panel, sección Avisos del proyecto.","marca":"<nombre de la marca>"}`.
**NO** uses `cf-pub-notify`: esos botones publican en Instagram. Los avisos se aprueban **solo desde el panel**.

## Reglas
- Etiquetá bien el contexto (`daypart`/`clima`/`momento`) según el brief; si es genérico, `cualquiera`/`generico`.
- Respetá las reglas de copy del contexto de marca (menciones, hashtags, nombres propios completos, emojis sí/no).
- Ante error o falta de material que no podés generar, `cf-avisar` y terminá; no dejes la pieza a medias.
