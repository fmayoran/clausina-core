-- Usuarios, autenticación y roles.
--
-- Antes de esto el panel tenía UNA contraseña compartida y una cookie firmada que sólo llevaba
-- la fecha de vencimiento: no había identidad. Y el negocio activo salía de la cookie `cf_marca`
-- SIN validar, así que cambiarla daba acceso al negocio de otro. Inocuo mientras el único
-- usuario era Fer; inaceptable en cuanto entra un cliente.
--
-- Ver core/planes/USUARIOS_Y_ROLES.md

CREATE TABLE IF NOT EXISTS contenido.usuario (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text        NOT NULL,
  nombre           text        NOT NULL,
  password_hash    text,                          -- scrypt: scrypt$<salt_hex>$<hash_hex>
  rol_plataforma   text        NOT NULL DEFAULT 'usuario',
  -- Los identificadores de canal cuelgan del USUARIO, no del negocio. Antes estaban dispersos
  -- (negocios.telegram_chat_id, negocio_contacto.whatsapp) y por eso ningún canal sabía QUIÉN
  -- estaba del otro lado. Esto es lo que después habilita aprobar por WhatsApp.
  telegram_chat_id text,
  whatsapp         text,
  activo           boolean     NOT NULL DEFAULT true,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  ultimo_acceso_en timestamptz,
  CONSTRAINT usuario_rol_plataforma_ck CHECK (rol_plataforma IN ('admin', 'usuario'))
);

-- El email identifica al usuario: único sin importar mayúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuario_email ON contenido.usuario (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuario_tg ON contenido.usuario (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- N:N: un usuario gestiona más de un negocio, un negocio tiene más de un usuario.
CREATE TABLE IF NOT EXISTS contenido.usuario_negocio (
  usuario_id uuid        NOT NULL REFERENCES contenido.usuario(id) ON DELETE CASCADE,
  negocio_id uuid        NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  rol        text        NOT NULL DEFAULT 'aprobador',
  creado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, negocio_id),
  -- La compuerta que define el rol es QUIÉN APRUEBA: la regla de la plataforma es que nada sale
  -- sin visto humano. 'editor' prepara y pide, pero no aprueba.
  CONSTRAINT usuario_negocio_rol_ck CHECK (rol IN ('aprobador', 'editor'))
);

CREATE INDEX IF NOT EXISTS idx_usuario_negocio_negocio ON contenido.usuario_negocio (negocio_id);

COMMENT ON TABLE contenido.usuario IS
  'Usuarios del panel. rol_plataforma=admin ve todo; el resto sólo los negocios de usuario_negocio.';
COMMENT ON TABLE contenido.usuario_negocio IS
  'Qué negocios gestiona cada usuario y con qué rol. Lo consulta el middleware que valida cf_marca.';
