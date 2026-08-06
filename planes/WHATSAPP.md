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

## Un número por negocio (decidido el 05/08/2026)

El diseño original —**un solo número de ClaUsina** hablando con todos— sirve para la conversación
con el **operador** y no para la conversación con el **cliente final**. Son dos cosas distintas y
se separan:

| Conversación | Número | Estado |
|---|---|---|
| ClaUsina ↔ operador del negocio | el de ClaUsina (+54 9 11 7261-3604) | andando |
| Negocio ↔ su cliente final | **uno propio por negocio** | en alta |

**Por qué, en dos hechos que se pueden verificar contra la API:**

1. **La calificación de calidad es por número** (`quality_rating` en el objeto del teléfono). Con
   un número compartido, un negocio que junta reportes o bloqueos **se lleva puestos a todos los
   demás**. Es el único de los problemas que no tiene arreglo posterior.
2. **El nombre visible es por número** (`verified_name`). Un comensal que reservó en un asador
   recibiría un mensaje de "ClaUsina", una empresa de la que nunca oyó hablar — que es justo lo
   que hace que la gente reporte, y lo que baja la calificación del punto 1.

Y un tercero que apareció al construirlo: **las plantillas son por cuenta (WABA), no por número**.
Por eso hace falta guardar el WABA además del id del número.

### El costo que hay que plantearle al negocio ANTES

Un número en Cloud API **no puede usarse al mismo tiempo en la app de WhatsApp Business**. Si el
negocio migra su número, su gente deja de poder contestar desde el celular: todo pasa a entrar por
ClaUsina. Para un local donde alguien atiende desde el mostrador eso es un cambio de operación, no
una configuración. Tres de los ocho negocios ya tienen número propio (Ardora Sport, Formación
Independiente, Ibitat).

### Cómo se configura

Capacidad **WhatsApp** (grupo Comunicación), pantalla propia. `negocio_perfil.wa_phone_id` y
`wa_waba_id` en claro, `wa_token_enc` cifrado y write-only — la regla de secretos de siempre.

**Al cliente final sólo se le escribe desde el número de su negocio.** Si el negocio no tiene el
suyo cargado, el aviso no sale: mandarle un mensaje de "ClaUsina" a un comensal es la forma más
rápida de que lo reporte.

### El diagnóstico

La pantalla trae un verificador que comprueba **lo que la interfaz de Meta no dice**: token, modo
LIVE, calidad, nombre visible, webhook apuntando a ClaUsina, **cuenta suscripta a la app** y
estado de las plantillas. Cada punto salió de una trampa real de las que están más arriba — el
webhook figura validado en verde aunque falte la suscripción, y ninguna avisa por la otra.

### Cortafuego, el primer negocio con número propio (05/08/2026)

| Qué | Valor |
|---|---|
| Número | **+54 9 11 7261-9610** · nombre visible `cortafuego.ar` |
| Id del número | `1302397302949753` |
| Cuenta (WABA) | `1002128032447490` — dueña: portafolio `cortafuego.ar` |
| App | **Cortafuego** (`1715760772940180`), no la de ClaUsina |
| Token | usuario del sistema `cortafuego-bot`, cifrado en el perfil |

**Por qué la app es la de Cortafuego y no la de ClaUsina.** El camino correcto era **Socios**:
Cortafuego le comparte su cuenta al portafolio de ClaUsina (`1357666785901841`) y un solo token
administra todas las cuentas. Meta lo rechazó con "no se pueden asignar activos", casi con
seguridad porque **ClaUsina todavía no está verificada como negocio** — el mismo pendiente del CUIT.

La salida fue agregarle el producto WhatsApp a la app del propio Cortafuego y generar el token ahí.

**La consecuencia, que hay que tener presente:** ese número **puede enviar pero no recibir**. El
webhook valida la firma de Meta con el secreto de la app de ClaUsina, y lo que entre por la app de
Cortafuego viene firmado con otro. Alcanza para los avisos —que es lo que bloqueaba F6— pero no
para que un cliente le responda al negocio.

**Cuando salga la verificación de ClaUsina hay que migrar a Socios.** El trabajo hecho no se tira:
sólo cambia de dónde sale el token, y ahí se resuelve también lo de recibir.

### Error a no repetir

Las primeras plantillas (`reserva_nueva`, `reserva_confirmada`) se crearon en el **WABA de
prueba**, porque era el id que había a mano. El número de producción vive en otro WABA, y como las
plantillas son por cuenta, **no sirven**. Quedaron ahí inertes: el token no tiene permiso para
borrarlas. Hay que rehacerlas en el WABA de producción de cada negocio.

## El canal como producto configurable (06/08/2026)

Fer: *"comenzar a armar un configurador del canal de WhatsApp API del negocio"*. El número deja de
ser una configuración técnica y pasa a ser un canal que el negocio arma. Pantalla **WhatsApp**, tres
solapas.

### Número
Lo de antes: ids, token, secreto de la app y el diagnóstico.

### Asistente
- **El saludo lo escribe el negocio.** Antes estaba en el código.
- **Elige qué operaciones ofrece el bot.** La lista de opciones **no es "todas las capacidades del
  negocio"**: es la intersección entre lo que el bot sabe atender (`CAPS_BOT`) y lo que el negocio
  tiene habilitado. Si una capacidad está apagada, la casilla se ve pero no se puede marcar y dice
  por qué. Hoy el bot sabe una sola cosa: tomar reservas.

### Inbox
Lo que no encaja en ninguna operación **no puede quedar sin respuesta**. El asistente ofrece
"Otra consulta", acusa recibo —sin prometer plazos que no controlamos— y el mensaje queda en un
inbox por negocio para que lo lea una persona. Se responde desde ahí.

**La ventana de 24 h se muestra explícitamente.** Pasada, Meta no deja responder libre; la pantalla
lo dice **antes** de que alguien escriba una respuesta que no va a salir.

### Reservar por WhatsApp

Canal alternativo a la página. Funciona porque **el cliente escribe primero**: eso abre la ventana
y permite contestar con botones y listas **sin plantillas aprobadas** — por eso se pudo probar
antes de que Meta aprobara nada.

**La ventana deja escribirle, no cambia quién aprueba.** La reserva entra por `crearReserva`, con
las mismas validaciones y el mismo lock de capacidad que la página y el panel. No hay una segunda
puerta para reservar, hay un segundo mostrador para el mismo trámite.

El flujo es **guiado y no de texto libre** a propósito: interpretar "una mesa para el finde a la
noche" es tentador y frágil, y una lista de días no se malinterpreta.

### Cambios de esquema que esto exigió

- `wa_conversacion` — dónde quedó cada cliente. Se descarta a los 30 min: retomar un flujo de ayer
  con la fecha que eligió ayer sería peor que volver a empezar.
- `whatsapp_mensaje.negocio_id` — la bitácora se diseñó para **un** número y sin esto no hay inbox
  posible, porque no se sabe a quién mostrarle qué.

## Pendientes

1. **Interpretar requerimientos.** Hoy la respuesta sólo confirma identidad y qué negocios
   maneja. Falta que entienda el pedido y lo encole.
2. **Plantillas** para que ClaUsina inicie: aviso de pieza lista para aprobar, con botones.
3. **Verificación del negocio** (CUIT). Sin ella, tope de 250 conversaciones iniciadas cada 24 h
   — para el volumen actual sobra.
4. **Notas de voz por WhatsApp**: la transcripción ya existe y es agnóstica del canal; hay que
   bajar el audio por la Cloud API en vez de por Telegram.

Relacionado: `MENSAJERIA_TELEGRAM_WHATSAPP.md`, `USUARIOS_Y_ROLES.md`.
