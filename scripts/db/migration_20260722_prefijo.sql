-- Prefijo de código por negocio: el badge de las piezas mostraba "CF-" (Cortafuego) para TODOS
-- los negocios, confundiendo de quién es cada pieza. Ahora cada negocio tiene su prefijo.
-- La numeración sigue siendo global (secuencia única); el prefijo desambigua el negocio.
ALTER TABLE contenido.negocios ADD COLUMN IF NOT EXISTS prefijo text;

-- Semilla: Cortafuego conserva "CF" (histórico); el resto, un código legible por negocio.
UPDATE contenido.negocios SET prefijo = CASE slug
  WHEN 'cortafuego'              THEN 'CF'
  WHEN 'ardora'                 THEN 'AR'
  WHEN 'ardora-sport'           THEN 'AS'
  WHEN 'berazategui'            THEN 'MB'
  WHEN 'clausina'               THEN 'CU'
  WHEN 'farmanobel'             THEN 'FN'
  WHEN 'formacion-independiente' THEN 'FI'
  WHEN 'ibitat'                 THEN 'IB'
  WHEN 'set-point-wilde'        THEN 'SP'
  ELSE upper(left(regexp_replace(slug, '[^a-z]', '', 'g'), 3))
END
WHERE prefijo IS NULL;
