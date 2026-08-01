# Usuarios, autenticación y roles (plan — 29/07/2026)

Base para todo lo que viene: canal hacia el cliente (WhatsApp), comandos de voz, y que un
negocio se pueda operar sin que Fer sea el único con llave.

## Punto de partida

- **No hay usuarios.** Una sola contraseña compartida (`PANEL_PASSWORD`) y una cookie firmada
  con HMAC cuyo contenido es únicamente `{exp}`: no lleva identidad.
- **El negocio activo sale de una cookie que el servidor no valida** (`cf_marca`, `server.js`).
  Hoy es inocuo porque el único usuario es Fer. Con un cliente adentro, cambiar el slug en la
  cookie del navegador da acceso al negocio de otro. **Este es el agujero que hay que cerrar.**
- De 106 rutas del panel, **67 resuelven el negocio por un único middleware**. Blindar ahí
  adentro cubre todas: no hay que tocar 67 endpoints.

## Modelo

```
contenido.usuario
  id, email (único), nombre, password_hash, rol_plataforma ('admin'|'usuario'),
  telegram_chat_id, whatsapp, activo, creado_en, ultimo_acceso_en

contenido.usuario_negocio          -- N:N — un usuario gestiona varios negocios
  usuario_id, negocio_id, rol ('aprobador'|'editor')
  PK (usuario_id, negocio_id)
```

`telegram_chat_id` y `whatsapp` viven en el **usuario**, no en el negocio. Hoy están dispersos
(`negocios.telegram_chat_id`, `negocio_contacto.whatsapp`) y por eso ningún canal sabe *quién*
está del otro lado. Esto es lo que después habilita aprobar por WhatsApp.

## Roles

| Rol | Alcance | Puede |
|---|---|---|
| `admin` | plataforma | Todo, en todos los negocios: sala de máquinas, integridad, secretos, alta/baja de negocios y usuarios. Es Fer. |
| `aprobador` | un negocio | Ve solo sus negocios. Aprueba, rechaza, descarta, publica. Es el dueño del negocio. |
| `editor` | un negocio | Prepara y pide, **no aprueba**. Un community manager. |

La distinción que importa es **quién aprueba**: la regla de la plataforma es que nada sale sin
visto humano, así que el rol se define por esa compuerta. `editor` es el complemento natural y
no cuesta nada tenerlo desde el principio.

## Autenticación

Sin dependencias nuevas, igual que el resto del motor:

- **Contraseña:** hash con `crypto.scrypt` (viene en Node). Misma filosofía que `crypto_ads.js`.
- **Sesión:** la cookie HMAC que ya existe, con el payload pasando de `{exp}` a `{uid, exp}`.
- **Compatibilidad:** Fer se siembra como `admin` con la `PANEL_PASSWORD` actual, así nada se
  corta durante la transición.

## Aislamiento entre negocios

1. El middleware de `cf_marca` **valida el slug contra `usuario_negocio`**. Si el usuario no lo
   tiene asignado, no entra (el admin pasa por encima). Un solo lugar, 67 rutas cubiertas.
2. Rutas solo-admin: sala de máquinas, integridad, verificación, perfil con tokens cifrados,
   gestión de usuarios, alta/baja de negocios.
3. Aprobar y publicar exigen `aprobador` o `admin`.
4. **El callback de Telegram valida el chat**: hoy cualquier chat que tenga el botón puede
   aprobar. Pasa a resolver `chat_id → usuario → rol en ese negocio`.

## Fuera de alcance en esta fase (pendientes)

- **`/media` se sirve sin sesión** (`server.js`). Con varios inquilinos, el material de un
  negocio es alcanzable por URL si se adivina la ruta. Hay que decidir si se firma o se protege.
- Invitaciones y recuperación de contraseña por mail: por ahora el admin crea los usuarios a mano.
- Vista simplificada del panel para el cliente: por ahora ve el panel completo, con oculto lo
  que su rol no puede usar.

Relacionado: `MENSAJERIA_TELEGRAM_WHATSAPP.md`.
