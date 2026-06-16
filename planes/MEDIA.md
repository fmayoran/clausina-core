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

## Nivel 2 — Diseño del sitio (público, CDN de la marca)
Para: imágenes que son parte del DISEÑO de la landing (hero, logos del sitio, fuentes).
- Viven en `marcas/<slug>/assets/landing/img/`, servidas por el **CDN de la marca** (Cloudflare): `cortafuego.ar/...`, `ardora.com.ar/...`. Rápido y desacoplado. Correcto ahí.

## Categoría aparte — Material de PUBLICACIONES (pendiente de mover)
Para: imágenes/videos de piezas de Instagram y mp4+poster de avisos de la pantalla DOOH.
- **Hoy (interino):** co-alojado en `marcas/<slug>/assets/landing/publicaciones/` solo para tener URL pública vía el CDN de la marca (a 16/06: ~58 archivos / 99 MB en Cortafuego; 26 media en la base apuntan a cortafuego.ar).
- **Problema:** NO es contenido de la landing; infla el repo y acopla cada publicación a un commit + redeploy de la landing.
- **Necesita:** URL pública + CDN (lo descarga VNNOX para la pantalla; lo ven los visitantes en novedades). Por eso NO va al media store actual (panel-served, sin CDN = retroceso).
- **Destino correcto = Opción B** (ver abajo).

## Decisión (16/06/2026) y pendiente
Se adoptó el estándar para lo de hoy. **PENDIENTE / próximo proyecto de infra: Opción B** — media store único **fronteado con Cloudflare** (`media.clausina.ar`, CDN). Mover ahí el **material de publicaciones** (IG + pantalla), sacarlo del repo de la landing, repuntar las URLs en la base, y cambiar los flujos de publicación/avisos para que suban al store (en vez de commitear+redeployar la landing). Frontear sin lío de cert: agregar el host DNS-only → que EasyPanel emita el Let's Encrypt → pasar a proxied (Cloudflare Full usa ese cert). Es un proyecto con foco, no al cierre de una sesión.
