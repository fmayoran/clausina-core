# Google Workspace para clausina.ar

Objetivo doble: correo propio de la agencia (hoy sale desde una casilla de Gmail que ni siquiera
lleva la marca) y una identidad de ClaUsina para ser dueña del proyecto de Google Cloud del SSO.

## Reparto del trabajo

| Paso | Quién |
|---|---|
| Alta, plan y pago en Workspace | **Fer** (pide identidad y medio de pago) |
| Verificación del dominio, MX, SPF, DMARC, DKIM en Cloudflare | **Claude** (tengo la API) |
| Generar la clave DKIM en la consola de Workspace | **Fer** (dos clics) |
| Migrar el envío de mail de la plataforma a la casilla nueva | **Claude** |

## Punto de partida (verificado)

- DNS de `clausina.ar` en **Cloudflare** (`val`/`bruce.ns.cloudflare.com`), zona activa.
- **Sin registros MX ni TXT**: el dominio no tiene correo. Los `A` apuntan a Cloudflare (la landing).
- El token de Cloudflare que tenemos **puede leer y escribir DNS de esa zona** (probado).
- El mail de agencia sale hoy de una cuenta `@gmail.com`.

## Tu parte, paso a paso

1. Entrar a `workspace.google.com` → **Comenzar**.
2. Plan **Business Starter** (unos USD 7 por usuario al mes; suele venir con período de prueba).
   **Con un solo usuario alcanza para arrancar**: los alias (`info@`, `hola@`, `no-reply@`) son
   gratis y no cuentan como usuarios.
3. Cuando pregunte por el dominio, elegir **"Sí, tengo uno que puedo usar"** y poner `clausina.ar`.
4. Crear la cuenta de administrador: **`fernando@clausina.ar`**, y sumar `hola@` e `info@` como
   alias. Esta misma cuenta es la que después va a ser dueña del proyecto de Google Cloud para
   el SSO — así la identidad de la plataforma queda en tu dominio.

   **Qué se paga y qué no** (la duda que siempre vuelve):
   - **Alias — gratis.** Hasta 30 por usuario. `hola@` e `info@` caen en la bandeja de
     `fernando@` y se puede responder desde ellas.
   - **Grupo — gratis.** Si más adelante alguien más tiene que leer `info@`, se crea como grupo
     en vez de alias.
   - **Usuario nuevo — paga licencia.** Lo que cuesta es que alguien **pueda entrar** con esa
     dirección, no que la dirección exista y reciba correo.

   El nombre principal **se puede cambiar después**: al renombrar, Google convierte la dirección
   vieja en alias automáticamente. La elección no es irreversible.
5. **Importante:** cuando ofrezca configurar el DNS automáticamente, elegir la opción
   **manual / "mi registrador no está en la lista"**. El dominio es `.ar` (NIC Argentina) con DNS
   en Cloudflare: la configuración automática de Google no aplica y puede confundir el proceso.
   **No cambies los nameservers**: si salen de Cloudflare, se cae la landing.
6. Google te va a mostrar un **registro TXT de verificación**, algo como
   `google-site-verification=AbCdEf...`. Pasámelo y lo aplico.

## Mi parte (script `core/scripts/dns_workspace.sh`)

Idempotente y acotado: **no toca los registros `A`**, así que la landing no corre riesgo.

```
dns_workspace.sh --estado                       # ver qué hay hoy
dns_workspace.sh --verificar "google-site-..."  # paso 1
dns_workspace.sh --correo                       # paso 2: MX + SPF + DMARC
dns_workspace.sh --dkim "v=DKIM1; k=rsa; p=..." # paso 3
```

Qué escribe cada uno:

- **Verificación:** `TXT clausina.ar = google-site-verification=...`
- **Correo:** `MX clausina.ar → smtp.google.com` (prioridad 1). Workspace usa **un solo MX** desde
  2023; los cinco registros `ASPMX`/`ALT1…` que aparecen en tutoriales viejos son legado.
- **SPF:** `v=spf1 include:_spf.google.com ~all` — autoriza a Google a mandar como `@clausina.ar`.
  `~all` es falla suave, lo recomendado al empezar.
- **DMARC:** `p=none` — sólo observa y reporta, no rechaza nada. Se endurece cuando haya semanas
  de reportes limpios.
- **DKIM:** la clave se genera en la consola de Workspace (Apps → Google Workspace → Gmail →
  Autenticar correo) y después la aplico.

## Después, lo que gana la plataforma

1. **El SSO queda bajo identidad de ClaUsina**: el proyecto de Google Cloud del
   `GOOGLE_CLIENT_ID` lo crea `fernando@clausina.ar`, no una cuenta personal ni la de un cliente.
   El mail de soporte de la pantalla de consentimiento —que el cliente ve— tiene que ser el de
   esa cuenta o el de un grupo que administre; si se prefiere algo menos personal, sirve un
   grupo `soporte@clausina.ar` (gratis). Ver `SSO_GOOGLE.md`.
2. **El mail de agencia deja de salir de un Gmail**: hay que mover `MAIL_USER` /
   `AGENCIA_MAIL_USER` a la casilla nueva. Con Workspace el SMTP funciona igual (usuario +
   contraseña de aplicación, que requiere verificación en dos pasos activada).
3. Con SPF y DKIM firmando, los avisos a clientes dejan de tener pinta de spam — hoy salen de
   una casilla de Gmail hablando en nombre de otra marca.

## Un aviso sobre el alcance del token de Cloudflare

El token puede escribir DNS de `clausina.ar`. Cuando terminemos, conviene revisar si su alcance
es más amplio de lo necesario. No es urgente, pero quedó anotado.

Relacionado: `SSO_GOOGLE.md`, `USUARIOS_Y_ROLES.md`.
