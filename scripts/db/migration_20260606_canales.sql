-- Intake único + canales de publicación (06/06/2026). Fase 1: cambios ADITIVOS (no rompen lo vivo;
-- todo lo existente queda como canal='instagram'). Ver planes/ARQUITECTURA_CANALES.md.

-- La pieza ahora tiene canal de publicación.
ALTER TABLE contenido.piezas ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'instagram';  -- instagram | aviso

-- La revisión suma los campos propios de un aviso de pantalla (NULL para Instagram).
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS daypart text;     -- manana|mediodia|tarde|noche|cualquiera
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS clima text;       -- frio|lluvia|calor|cualquiera
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS transito text;    -- alto|normal|cualquiera
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS momento text;     -- pre-apertura|apertura|promo-relampago|generico
ALTER TABLE contenido.revisiones ADD COLUMN IF NOT EXISTS duracion_s int;

-- El requerimiento declara a qué canal apunta.
ALTER TABLE contenido.tg_briefs ADD COLUMN IF NOT EXISTS canal_destino text NOT NULL DEFAULT 'instagram'; -- instagram | aviso

CREATE INDEX IF NOT EXISTS piezas_canal_idx ON contenido.piezas(canal);
