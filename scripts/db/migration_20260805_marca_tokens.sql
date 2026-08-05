-- ClaUsina v2.0 / F5b — tokens de marca estructurados.
-- Fer (05/08): que la página pública de reservas herede el look and feel de la landing.
--
-- POR QUÉ NO ALCANZA CON LO QUE HAY: el estilo de marca vive como PROSA (`negocio_perfil.estilo_md`)
-- y la prosa NO COINCIDE con la landing. En Cortafuego el estilo dice que el naranja es #FF5C00 y
-- la landing usa #ff4400; el fondo dice #000000 y la landing usa #080806. Leer la prosa daría una
-- página de un naranja PARECIDO PERO DISTINTO, que es peor que ser obviamente genérica.
--
-- Es el mismo problema de F1 y la misma solución: narrativa para el creativo, tokens para la
-- máquina. La fuente de verdad de los valores es la landing, que es lo que la gente ve.
BEGIN;

ALTER TABLE contenido.negocio_identidad
  ADD COLUMN IF NOT EXISTS marca jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN contenido.negocio_identidad.marca IS
  'Tokens visuales para superficies generadas (página pública de reservas, etc.): '
  '{modo, fondo, superficie, linea, texto, tenue, acento, acento_texto, fuente_titulo, fuente_texto}. '
  'Vacío = se usa la paleta de ClaUsina.';

-- El logo guardado es UNO SOLO y es la variante para fondo oscuro (el de Cortafuego es arte
-- blanco sobre transparente): sobre fondo claro desaparece. Se agrega el par.
ALTER TABLE contenido.negocio_perfil
  ADD COLUMN IF NOT EXISTS logo_claro text;
COMMENT ON COLUMN contenido.negocio_perfil.logo_claro IS
  'Variante del logo para fondo CLARO. NULL = se usa `logo` sobre un recuadro oscuro.';

-- ── Semilla: Cortafuego, con los valores REALES de su landing ────────────────
-- Tomados de marcas/cortafuego/assets/landing/index.html, no del estilo_md.
UPDATE contenido.negocio_identidad SET marca = jsonb_build_object(
    'modo',           'oscuro',
    'fondo',          '#080806',   -- --black
    'superficie',     '#111110',   -- --iron
    'linea',          '#252520',   -- --cement
    'texto',          '#f5f2ec',   -- --white
    'tenue',          '#8a8a82',   -- --ash
    'acento',         '#ff4400',   -- --fire
    'acento_texto',   '#f5f2ec',
    'fuente_titulo',  'Bebas Neue',
    'fuente_texto',   'Barlow Condensed'
  ), actualizado_en = now()
 WHERE negocio_id = (SELECT id FROM contenido.negocios WHERE slug = 'cortafuego');

COMMIT;
