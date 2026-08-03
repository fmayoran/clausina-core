# WhatsApp — canal hacia el cliente

> **ANDANDO desde el 03/08/2026.** Número **+54 9 11 7261-3604**, nombre para mostrar
> **ClaUsina**. Circuito entrante probado de punta a punta: mensaje → identificación por
> número → respuesta, en un segundo.

## El diseño

Un solo número de ClaUsina que habla con el WhatsApp del usuario que gestiona cada negocio.
**El usuario escribe primero** — eso abre una ventana de 24 h en la que se puede responder libre
y sin costo, sin plantillas ni revisión de Meta. Las plantillas (pagas, aprobadas una por una)
sólo hacen falta cuando ClaUsina inicia la conversación, por ejemplo el aviso de "tenés una
pieza para aprobar" cuando el cliente hace rato que no escribe.

**El canal autentica; `contenido.usuario` autoriza.** Meta garantiza de qué número viene el
mensaje, pero el acceso sale de la base: número que no está cargado recibe una respuesta
explicando que pida acceso. Mismo criterio que el SSO de Google y que el bot de Telegram.

## Los tres enganches (esto costó horas de encontrar)

El webhook figura **validado con luz verde** aunque falten los otros dos, y ninguno avisa por el
otro. Si no llegan mensajes, revisar los tres en este orden:

1. **URL y token de verificación a nivel de la app.** Se configura en el paso de producción del
   flujo guiado (Meta lo esconde ahí; no hay entrada de "WhatsApp" en el menú lateral).
2. **La cuenta de WhatsApp Business suscripta a la app.** Va por cuenta, no por app: al cambiar
   de número de prueba a producción hay que rehacerlo.
   `GET /{waba-id}/subscribed_apps` para verificar, `POST` al mismo para arreglarlo.
   Síntoma cuando falta: la cuenta tiene suscripta sólo `WA DevX Webhook Events 1P App`, que es
   la app interna que usa la pantalla de prueba de Meta.
3. **La app suscripta al campo `messages`.** Puede quedar la lista de campos **vacía** con la URL
   perfectamente guardada. `GET /{app-id}/subscriptions?access_token={app-id}|{app-secret}`.

## Configuración actual

| Qué | Dónde |
|---|---|
| Webhook | `https://panel.clausina.ar/webhook/whatsapp` (panel, no n8n) |
| Campos suscriptos | `messages`, `message_template_status_update`, `phone_number_quality_update`, `account_update` |
| Token | usuario del sistema, **no vence** |
| Firma | validada con `WHATSAPP_APP_SECRET`; sin firma el webhook devuelve 403 |
| Bitácora | `contenido.whatsapp_mensaje`, entrantes y salientes, podada a 90 días |

Variables en el env del panel: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_APP_SECRET`.

## Trampas encontradas

- **El número de prueba es asimétrico:** cualquiera puede escribirle, pero él sólo puede
  responder a los números de su lista de autorizados. Un mensaje entrante que funciona no
  garantiza que la respuesta salga.
- **`hello_world` sólo se puede mandar desde números de prueba.** Con el número real, el primer
  contacto necesita una plantilla propia aprobada — o que el usuario escriba primero.
- **El identificador del número cambia** al pasar de prueba a producción. El token temporal de
  24 h también vence, obviamente: para producción va uno de usuario del sistema.
- **El webhook va antes de `express.json`**: la firma se calcula sobre el cuerpo crudo y, si el
  parser lo toca primero, ya no se pueden reconstruir los bytes.

## Pendientes

1. **Interpretar requerimientos.** Hoy la respuesta sólo confirma identidad y qué negocios
   maneja. Falta que entienda el pedido y lo encole.
2. **Plantillas** para que ClaUsina inicie: aviso de pieza lista para aprobar, con botones.
3. **Verificación del negocio** (CUIT). Sin ella, tope de 250 conversaciones iniciadas cada 24 h
   — para el volumen actual sobra.
4. **Notas de voz por WhatsApp**: la transcripción ya existe y es agnóstica del canal; hay que
   bajar el audio por la Cloud API en vez de por Telegram.

Relacionado: `MENSAJERIA_TELEGRAM_WHATSAPP.md`, `USUARIOS_Y_ROLES.md`.
