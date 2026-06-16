# Tratamiento de imágenes / medios — método establecido (16/06/2026)

Convención de **dos niveles** para todas las imágenes de la plataforma. Regla simple para decidir dónde va una imagen:

- **¿La ve el público en el sitio de la marca?** → CDN de la marca.
- **¿Es interna / de trabajo / multipropósito / cross-marca?** → media store central de ClaUsina.

## Nivel 1 — Media store central de ClaUsina (interno / trabajo / cross-marca)
Para: histórico/referencias de IG, imágenes que genera el creativo, borradores, análisis, moodboards, y cualquier medio que use el panel o varias marcas.

- **Almacenamiento:** volumen persistente `clausina-media` montado en el contenedor del panel en `/app/media`.
  - Host (docker volume): `/var/lib/docker/volumes/clausina_panel_clausina-media/_data/`.
  - Sobrevive a los redeploys. El VPS tiene espacio de sobra (70 GB libres).
- **Servido público** por el panel: `https://panel.clausina.ar/media/...` (ruta `/media`, antes del login; en `server.js`).
- **Estructura** (por propósito / marca):
  - `/media/ig/<marca>/` — histórico y referencias de Instagram (ej. `ig/ardora/<ig_post_id>.webp`).
  - `/media/creativo/<marca>/` — imágenes generadas por el creativo (Higgsfield, etc.).
  - `/media/referencias/<marca>/` — moodboards, capturas, benchmarks.
- **Cómo escribir** (desde el VPS): directo al host path de arriba, o `docker cp`/`docker exec` al contenedor `/app/media`. La URL pública se arma con `https://panel.clausina.ar/media/<ruta>`.
- **Backup:** el volumen NO entra en el backup de Postgres. Lo re-descargable (thumbnails de IG) no es crítico; lo generado (creativo) conviene respaldarlo aparte cuando empiece a acumularse.

## Nivel 2 — CDN de cada marca (público, de cara al cliente)
Para: imágenes de la landing y de las piezas publicadas que se muestran en el sitio de la marca (home, novedades).

- Viven en el **repo de la cápsula de la marca** (`marcas/<slug>/assets/landing/img/` y `.../publicaciones/`) y se sirven por el **CDN de la marca** (Cloudflare): `cortafuego.ar/...`, `ardora.com.ar/...`.
- Ventaja: rápido (CDN) y **desacoplado** del panel/VPS. No mover esto al store central (sería un retroceso).

## Decisión (16/06/2026)
Se adoptó el **estándar de dos niveles (Opción A)**. Opción B futura: un store único con CDN propio (`media.clausina.ar` fronteado por Cloudflare) que además desacople el flujo de publicación del repo de la landing — es un proyecto en sí, a planificar si se quiere centralización total.
