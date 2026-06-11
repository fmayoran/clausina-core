# Arquitectura — Intake único + canales de publicación (acordado 06/06/2026)

Separar el **qué** (una sola Cola de Requerimientos, agnóstica del canal) del **dónde** (canales de publicación:
Instagram y Avisos de pantalla), con la **misma lógica de publicación** en cada canal.

## Decisiones
- **Modelo unificado:** una sola tabla `piezas` con columna **`canal`** (`instagram` | `aviso`). Misma máquina de estados
  y motor de publicación. Lo único distinto por canal: campos de la revisión y la acción de "publicar".
- **Un canal por requerimiento** (Instagram **o** Aviso; para ambos se crean dos).

## Pantallas
- **Home (`/panel`):** Cola de Requerimientos unificada + barra de status + menú → [Instagram] [Avisos].
- **Instagram (`/panel/instagram`):** Pendiente de aprobación · Publicada (métricas + Collab). Aprobar/Rechazar/Descartar.
- **Avisos (`/panel/avisos`):** Pendiente de aprobación · En pantalla. Aprobar/Rechazar/Descartar.

## Flujo
1. Requerimiento entra a la Cola con **`canal_destino`** (instagram|aviso). Fuentes: Fer (Telegram/panel), creativo (propuesta), mención.
2. Al activarse, el agente genera la **pieza en ese canal**, estado `pendiente_aprobacion`.
3. En el panel del canal: **Aprobar** (publica) / **Rechazar** (corrige) / **Descartar**.
   - IG: aprobar → `cf-pub-publish` (Graph API) + métricas + Collab.
   - Aviso: aprobar → estado `publicada` = **en pantalla** (disponible para el programador de Fase 2). Sin API externa.
4. Rechazar: IG → rutina de auto-corrección; Aviso → el `/editor` regenera con el motivo (loop análogo).

## Modelo de datos
- `piezas.canal` (`instagram`|`aviso`, default `instagram`). Numeración CF-NNNN compartida.
- `revisiones`: para avisos suma `daypart`, `clima`, `transito`, `momento`, `duracion_s` (NULL para IG). El mp4 2:3 + poster van en `media` (tipo `video`). El texto en pantalla = `caption`.
- `tg_briefs.canal_destino` (`instagram`|`aviso`).
- `pantalla_avisos` se **migra a `piezas/revisiones/media`** (canal=aviso) y se deja de usar.

## Plan de implementación (por fases, sin romper lo vivo)
1. **DB (aditivo):** `piezas.canal`, campos de aviso en `revisiones`, `tg_briefs.canal_destino`. (No rompe: default instagram.)
2. **Backend canal-aware:** `getPiezas(canal)`; aprobar/rechazar/descartar ramifican por canal; requerimientos muestran/setean canal.
3. **UI 3 pantallas:** home (cola+menú+status), `/instagram`, `/avisos`. Migrar `pantalla_avisos` → piezas y apuntar el panel de avisos al nuevo modelo. Recién acá se retira `pantalla_avisos`.
4. **Intake + generación por canal** ✅: selector de canal en la cola; `cf-crear-pendiente` acepta `canal_pieza`+tags de aviso; `brief_local.sh` rutea IG (`brief_dictado.md`) vs aviso (`brief_aviso.md` → `/editor`); las propuestas llevan canal (`propuestas_*`).
5. **Loop de corrección de avisos** ✅: `cf-rechazos-pendientes` trae el `canal`; `rutina_local.sh` rutea por canal — IG (texto/visual) y aviso (el `/editor` regenera el spot 2:3 según el motivo, sin `cf-pub-notify`; aprobación por el panel).

## Lo que NO cambia
Generación + **aprobación manual antes de publicar**, auto-corrección de rechazos (IG), Telegram operativo.
