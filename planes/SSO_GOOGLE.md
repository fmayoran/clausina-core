# Entrar con Google (SSO) — configuración pendiente

El código está desplegado y **degrada solo**: mientras no existan las credenciales, el botón no
aparece y todo sigue funcionando con contraseña. Al cargarlas, el botón aparece solo.

## Decisión de fondo: no hay alta libre

Autenticar (quién sos) y autorizar (qué negocio podés tocar) son cosas distintas. Un alta libre
sólo resuelve la primera y dejaría un endpoint de escritura sin autenticar abierto a internet,
más una pila de cuentas huérfanas que alguien tiene que policiar.

**El SSO autentica; el acceso lo sigue dando `contenido.usuario`.** Si alguien entra con Google y
su mail no está en la tabla, ve "esa cuenta todavía no tiene acceso, pedíselo a tu administrador".
Eso es lo que reemplaza al sign up: nadie se da acceso a sí mismo.

## Los 6 pasos en Google Cloud (15 minutos)

1. Entrar a `console.cloud.google.com` con la cuenta de ClaUsina y **crear un proyecto**
   (por ejemplo "ClaUsina Panel").
2. **APIs y servicios → Pantalla de consentimiento de OAuth**. Tipo: **Externo**.
   Nombre de la app: `ClaUsina`. Mail de asistencia y de contacto: el tuyo.
3. En **Permisos**, dejar sólo `openid`, `.../auth/userinfo.email` y `.../auth/userinfo.profile`.
   Son **permisos no sensibles**: no disparan revisión de Google. A diferencia de Meta, acá no
   hay verificación de empresa ni CUIT de por medio.
4. Publicar la app (**Publicar aplicación**). Con esos permisos el paso es automático; si queda
   en modo Prueba, sólo entran los mails que cargues como testers.
5. **Credenciales → Crear credenciales → ID de cliente de OAuth**. Tipo: **Aplicación web**.
   - Orígenes autorizados de JavaScript: `https://panel.clausina.ar`
   - **URI de redireccionamiento autorizado: `https://panel.clausina.ar/auth/google/callback`**
     (tiene que ser exacto, incluido el `https` y sin barra al final)
6. Copiar el **ID de cliente** y el **secreto de cliente**.

## Cargar las credenciales

Van al env del panel en EasyPanel (clausina → panel → Environment), no a un archivo del repo:

```
GOOGLE_CLIENT_ID=<id de cliente>
GOOGLE_CLIENT_SECRET=<secreto>
```

Opcional, sólo si el panel cambiara de dominio: `PANEL_URL=https://panel.clausina.ar`
(si no está, la URL de retorno se deduce del request).

Al deployar, `GET /api/auth/config` pasa a devolver `{"google":true}` y el botón aparece.

## Cómo se invita a alguien

No hay link secreto ni token de invitación, y no hace falta mandar mail desde el panel: el acceso
ya está dado por el email en la base, y Google prueba que la cuenta es de esa persona.

1. Panel → **Usuarios** → nuevo usuario, con su mail de Google y los negocios que gestiona.
2. Botón de **invitación** en su fila: copia el texto listo para mandarle por donde quieras.
3. La persona entra a `panel.clausina.ar`, toca "Entrar con Google", y ya está adentro.

La contraseña sigue existiendo como **puerta de emergencia del admin**: si Google se cae o el
proyecto queda mal configurado, no podés quedarte afuera de tu propia plataforma.

## Detalles de implementación

- `panel/auth.js`: flujo OIDC completo, sin librerías nuevas.
- La firma del `id_token` **no** se verifica a propósito: el token llega del endpoint de Google
  por TLS, en respuesta a un POST nuestro autenticado con el `client_secret`. Google documenta
  que en ese caso alcanza con validar los claims (`iss`, `aud`, `exp`, `email_verified`).
- Estado anti-CSRF firmado con `PANEL_SECRET`, en cookie de 10 minutos. Probado: un callback con
  estado inventado se rechaza.

Relacionado: `USUARIOS_Y_ROLES.md`.
