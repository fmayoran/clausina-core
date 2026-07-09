-- Credenciales de pauta (Meta Ads) en el perfil de la marca, para gestión self-service desde
-- el panel. Los IDs no son secretos (como ig_user_id); el token va CIFRADO (AES-256-GCM con
-- APP_ENC_KEY, que vive en infra) — nunca en claro en la DB ni editable/visible en el panel.
ALTER TABLE contenido.proyecto_perfil
  ADD COLUMN IF NOT EXISTS meta_ads_account_id text,
  ADD COLUMN IF NOT EXISTS meta_ads_page_id    text,
  ADD COLUMN IF NOT EXISTS meta_ads_ig_id      text,
  ADD COLUMN IF NOT EXISTS meta_ads_token_enc  text;   -- ciphertext 'gcm$<iv>$<ct||tag>'
