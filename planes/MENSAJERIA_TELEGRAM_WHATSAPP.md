# Mensajería — Telegram y WhatsApp (diagnóstico 29/07/2026)

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
negocios tiene `telegram_chat_id`, y apenas 2 chats escribieron alguna vez.

## El hallazgo: WhatsApp ya está en producción

Chatwoot (`crm_chatwoot`) tiene un inbox **WhatsApp Cloud API** con número real
(+54 9 11 6695-7605): 247 conversaciones, 2116 mensajes, **78 en los últimos 30 días**.
La cuenta de Chatwoot se llama **Ibitat**. Está enganchado al workflow `dzain_CRM_v1`.

**No tiene ninguna relación con el motor de ClaUsina.** Son dos mundos paralelos en el mismo
VPS: el circuito de publicación por un lado, el de conversación con clientes por el otro.
Esa desconexión —no "Telegram contra WhatsApp"— es la deuda de arquitectura real.

Señal de que ya lo habíamos decidido sin decirlo: `contenido.negocio_contacto` guarda
**whatsapp y mail, no telegram**.

## Decisión de rumbo: separar por audiencia, no migrar

- **Operador (Fer) → Telegram.** Gratis, ilimitado, el bot puede escribir a cualquier hora.
  WhatsApp Business no permite eso: fuera de la ventana de 24 h desde que el usuario escribe,
  solo van plantillas pre-aprobadas por Meta, y cada conversación iniciada por el negocio se
  cobra. Un sistema que avisa a las 3 AM que se cayó la publicación sería caro y burocrático.
- **Cliente (dueño del negocio) → WhatsApp.** Nadie se instala Telegram para aprobar un posteo.
  Aprobar/rechazar es posible: las plantillas admiten botones de respuesta rápida, pero hay que
  dar de alta las plantillas y que Meta las apruebe.

## Pendientes

1. **Averiguar bajo qué cuenta de Meta Business está el número +54 9 11 6695-7605**: si está
   verificada, y si es de Fer o de Ibitat. Sin verificar, el tope son 250 conversaciones
   iniciadas por el negocio cada 24 h (probablemente alcance). Se cruza con la verificación de
   Meta que quedó frenada por el CUIT.
2. **Conectar el mundo conversacional con el motor**: hoy Chatwoot/`dzain_CRM_v1` y ClaUsina no
   se conocen.
3. **Plantillas de WhatsApp** para aprobar/rechazar desde el cliente.
4. **Identidad**: quién es quién en cada canal. Bloqueado por usuarios y roles — ver
   `USUARIOS_Y_ROLES.md`. Hoy `telegram_chat_id` cuelga de `negocios` y `whatsapp` de
   `negocio_contacto`; deberían converger en el usuario.

## Sobre los comandos de voz

La transcripción es **agnóstica del canal**: las notas de voz de WhatsApp se bajan por la Cloud
API igual que las de Telegram y pasan por el mismo whisper. La decisión de canal no bloquea la voz.

Estado de la voz (auditado el 29/07): el circuito está construido y **nunca se estrenó**.
`cf-telegram` ya guarda `tg_briefs.voice_file_id`; `brief_job.sh:54-58` baja el audio, lo pasa a
16 kHz mono con ffmpeg y lo transcribe con whisper.cpp — compilado en `/root/whisper.cpp` con
`ggml-base.bin`. Probado: ~3× tiempo real con los 2 CPUs del VPS. Nunca llegó una nota de voz
(0 de 29 briefs). Falta: subir a `ggml-small`, pasarle el vocabulario de marcas como pista, y
una lectura de vuelta para confirmar antes de encolar.
