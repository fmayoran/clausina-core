-- Config de PLATAFORMA (no de marca): lo que usa ClaUsina como agencia, transversal a todas.
-- Primer uso: la "lente" de Instagram (business_discovery) para leer perfiles públicos de
-- marcas que todavía no gestionamos. Es de la agencia, no de una marca.
--
-- Mismo criterio que el perfil de marca: los ids no-secretos en claro, el token CIFRADO
-- (AES-256-GCM con APP_ENC_KEY) y write-only desde el panel (nunca vuelve al navegador).
CREATE TABLE IF NOT EXISTS contenido.plataforma_config (
  clave          text PRIMARY KEY,
  valor          text,          -- valores no secretos (ej. el id de la cuenta lente)
  valor_enc      text,          -- valores secretos (formato gcm$<iv>$<ct||tag>)
  descripcion    text,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

INSERT INTO contenido.plataforma_config (clave, descripcion) VALUES
  ('ig_lente_id',    'Cuenta IG Business que ClaUsina usa para consultar perfiles públicos (business_discovery). Hoy: Cortafuego. Pendiente: migrar a la cuenta de ClaUsina.'),
  ('ig_lente_token', 'Token de la lente. Necesita: instagram_basic, instagram_manage_insights, pages_read_engagement, pages_show_list.')
ON CONFLICT (clave) DO NOTHING;
