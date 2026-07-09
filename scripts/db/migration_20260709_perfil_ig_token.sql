-- Token de Instagram cifrado en el perfil (mismo patrón que Meta Ads): manejable desde el panel.
-- Consumidores del token IG: el panel (menciones/métricas, lee de acá con fallback a env) y n8n
-- (publicación, sigue con su credencial propia por ahora).
ALTER TABLE contenido.proyecto_perfil
  ADD COLUMN IF NOT EXISTS ig_token_enc text;   -- ciphertext 'gcm$<iv>$<ct||tag>'
