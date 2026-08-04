-- ClaUsina v2.0 / F1b — los atributos dependen del rubro.
-- "No son los mismos para Cortafuego, que es un restaurante, que para Ardora Sport, que es un
-- complejo deportivo" (Fer, 04/08). Ofrecer los 24 a todos ensucia la carga y empuja a marcar
-- cosas que no aplican.
--
-- REGLA: un atributo SIN filas acá es UNIVERSAL (se ofrece a todos los rubros). Con filas, se
-- ofrece sólo a esas actividades. El mapeo apunta a la actividad RAÍZ (gastronomía, deporte…),
-- que es la granularidad que hace falta; la tabla admite hojas si algún día se necesita.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.atributo_actividad (
  atributo_codigo text NOT NULL REFERENCES contenido.atributo(codigo) ON DELETE CASCADE,
  actividad_id    int  NOT NULL REFERENCES contenido.actividad(id) ON DELETE CASCADE,
  PRIMARY KEY (atributo_codigo, actividad_id)
);
CREATE INDEX IF NOT EXISTS atributo_actividad_act_ix ON contenido.atributo_actividad (actividad_id);

-- Farmacia y perfumería: un solo rubro. Más barato que modelar actividades secundarias, y
-- resuelve el caso real (FarmaNobel es las dos cosas).
UPDATE contenido.actividad SET nombre = 'Farmacia / perfumería' WHERE codigo = 'salud.farmacia';
-- La perfumería suelta de retail deja de tener sentido como rubro aparte.
UPDATE contenido.actividad SET activa = false WHERE codigo = 'retail.perfumeria';

-- ── Mapeo ───────────────────────────────────────────────────────────────────
-- Quedan UNIVERSALES (a propósito, sin filas): estacionamiento, accesible, transporte_publico,
-- pet_friendly, wifi, tarjeta, mercado_pago, aire_libre, cubierto, eventos.
INSERT INTO contenido.atributo_actividad (atributo_codigo, actividad_id)
SELECT v.attr, a.id
  FROM (VALUES
    ('apto_celiacos',    'gastronomia'),
    ('menu_vegetariano', 'gastronomia'),
    ('carta_vinos',      'gastronomia'),
    ('take_away',        'gastronomia'),
    ('delivery',         'gastronomia'),
    ('delivery',         'retail'),
    ('delivery',         'salud'),
    ('reserva_previa',   'gastronomia'),
    ('reserva_previa',   'deporte'),
    ('reserva_previa',   'servicios'),
    ('iluminacion',      'deporte'),
    ('vestuarios',       'deporte'),
    ('torneos',          'deporte'),
    ('escuela',          'deporte'),
    ('escuela',          'educacion'),
    ('turno_online',     'salud'),
    ('turno_online',     'servicios'),
    ('turno_online',     'deporte'),
    ('obra_social',      'salud'),
    -- FarmaNobel tiene tienda online y vende por WhatsApp: esto NO es exclusivo de retail.
    ('tienda_online',    'retail'),
    ('tienda_online',    'salud'),
    ('envio_domicilio',  'retail'),
    ('envio_domicilio',  'salud')
  ) AS v(attr, act)
  JOIN contenido.actividad a ON a.codigo = v.act
  JOIN contenido.atributo t ON t.codigo = v.attr
ON CONFLICT DO NOTHING;

COMMIT;

-- ── Control: ningún negocio puede quedar con un atributo que su rubro ya no admite ──
-- (si esto devuelve filas, hay que revisarlas a mano antes de que el panel las descarte al guardar)
SELECT n.slug, a.codigo AS rubro, x.attr AS atributo_huerfano
  FROM contenido.negocio_identidad i
  JOIN contenido.negocios n ON n.id = i.negocio_id
  JOIN contenido.actividad a ON a.id = i.actividad_id
  CROSS JOIN LATERAL unnest(i.atributos) AS x(attr)
 WHERE EXISTS (SELECT 1 FROM contenido.atributo_actividad m WHERE m.atributo_codigo = x.attr)
   AND NOT EXISTS (
     SELECT 1 FROM contenido.atributo_actividad m
      WHERE m.atributo_codigo = x.attr
        AND m.actividad_id IN (a.id, COALESCE(a.padre_id, a.id)));
