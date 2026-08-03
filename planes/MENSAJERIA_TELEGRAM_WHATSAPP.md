# Mensajería — Telegram y WhatsApp (diagnóstico 29/07/2026)

> **ESTADO:** las dos decisiones de este diagnóstico están aplicadas. Telegram quedó cerrado al
> administrador (02/08) y WhatsApp está andando (03/08, ver `WHATSAPP.md`).

Auditoría hecha antes de sumar comandos de voz. No es un plan cerrado: es el mapa del terreno
y las decisiones que quedan pendientes.

## Dónde nos integramos hoy con Telegram

Siete puntos, y **todos menos uno son de salida** (el sistema le habla a Fer):

| Punto | Dónde vive | Dirección |
|---|---|---|
| Aprobar/rechazar piezas con botones | n8n `ClaUsina - Telegram (botones)` (`cf-telegram`) | entrada + salida |
| Aviso de pieza lista para aprobar | n8n `ClaUsina - Notificacion aprobacion` | salida |
| Resumen diario | n8n `ClaUsina - Resumen diario` | salida |
| Alertas de integridad | `scripts/verificar_job.sh` | salida |
| Avisos de jobs (corrección, propuesta, revisión, campaña, biblioteca) | `scripts/*_job.sh` | salida |
| Briefs dictados al creativo (texto, foto, video, voz) | `cf-telegram` → `contenido.tg_briefs` | entrada |
| Panel | `panel/server.js`, `panel/db.js` | salida |

**Telegram no es un canal multi-negocio: es la consola personal del operador.** Solo 1 de 9
negocios tenía `telegram_chat_id`, y apenas 2 chats escribieron alguna vez.

**Decidido el 02/08 y ya aplicado:** Telegram queda para el administrador y las alertas de
plataforma. El Router del bot descarta cualquier chat no autorizado; la lista se deriva de
`contenido.usuario` con `scripts/sync_telegram_admins.py`.

## Corrección: el WhatsApp que corre en el VPS NO es de ClaUsina

En la auditoría del 29/07 encontré un inbox de WhatsApp Cloud API en Chatwoot (`crm_chatwoot`,
número +54 9 11 6695-7605, cuenta "Ibitat", enganchado al workflow `dzain_CRM_v1`) y lo
interpreté como "WhatsApp ya está en producción, desconectado del motor". **Era incorrecto.**

Fer aclaró (02/08) que ese Chatwoot y ese número **pertenecen a otra aplicación** y no tienen
relación con ClaUsina. Comparten el VPS y nada más. No hay nada que "reconectar": no es deuda
de arquitectura, es un vecino.

**Consecuencia práctica: ClaUsina no tiene WhatsApp. Se arranca desde cero** — cuenta de Meta
Business propia, número dedicado y alta en WhatsApp Business Platform.

Lo que sí sigue en pie: `contenido.negocio_contacto` guarda **whatsapp y mail, no telegram**,
señal de que el canal hacia el cliente ya estaba pensado por ahí.

## Decisión de rumbo: separar por audiencia, no migrar

- **Operador (Fer) → Telegram.** Gratis, ilimitado, el bot puede escribir a cualquier hora.
  WhatsApp Business no permite eso: fuera de la ventana de 24 h desde que el usuario escribe,
  solo van plantillas pre-aprobadas por Meta, y cada conversación iniciada por el negocio se
  cobra. Un sistema que avisa a las 3 AM que se cayó la publicación sería caro y burocrático.
- **Cliente (dueño del negocio) → WhatsApp.** Nadie se instala Telegram para aprobar un posteo.
  Aprobar/rechazar es posible: las plantillas admiten botones de respuesta rápida, pero hay que
  dar de alta las plantillas y que Meta las apruebe.

## Pendientes

1. ~~Dar de alta WhatsApp para ClaUsina desde cero~~ — **HECHO el 03/08/2026**: número
   +54 9 11 7261-3604 andando, circuito entrante probado. No hizo falta el CUIT. Ver `WHATSAPP.md`.
2. **Plantillas de WhatsApp** para aprobar/rechazar desde el cliente (Meta las revisa una por una).
3. **Identidad**: RESUELTO — `usuario.whatsapp` y `usuario.telegram_chat_id` ya cuelgan del
   usuario. Ver `USUARIOS_Y_ROLES.md`.

## Sobre los comandos de voz

La transcripción es **agnóstica del canal**: las notas de voz de WhatsApp se bajan por la Cloud
API igual que las de Telegram y pasan por el mismo whisper. La decisión de canal no bloquea la voz.

Estado de la voz (auditado el 29/07): el circuito está construido y **nunca se estrenó**.
`cf-telegram` ya guarda `tg_briefs.voice_file_id`; `brief_job.sh:54-58` baja el audio, lo pasa a
16 kHz mono con ffmpeg y lo transcribe con whisper.cpp — compilado en `/root/whisper.cpp` con
`ggml-base.bin`. Probado: ~3× tiempo real con los 2 CPUs del VPS. Nunca llegó una nota de voz
(0 de 29 briefs). Falta: subir a `ggml-small`, pasarle el vocabulario de marcas como pista, y
una lectura de vuelta para confirmar antes de encolar.
