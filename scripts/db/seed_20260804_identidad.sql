-- ClaUsina v2.0 / F1 — ficha de identidad PROPUESTA para los 8 negocios activos.
-- Todo lo de acá sale de lo que el propio brief del negocio dice (negocio_perfil.brief_md).
-- `revisado_en` queda en NULL a propósito: es una propuesta, la confirma una persona desde el panel.
--
-- LO QUE NO SE CARGA, Y POR QUÉ:
--   · ticket_min/max — ningún brief dice precios. Inventar un rango en el campo que después
--     define si el negocio aparece en una búsqueda por presupuesto sería peor que dejarlo vacío.
--   · lat/lon — no hay geocodificador. Se completan cuando haga falta el radio real.
--   · horarios — los briefs no los detallan.
-- Idempotente: se puede correr de nuevo.
BEGIN;

-- ── Ficha por negocio ───────────────────────────────────────────────────────
INSERT INTO contenido.negocio_identidad
  (negocio_id, actividad_id, zona_modo, zona_km, zona_localidades, ticket_unidad, publico, atributos)
SELECT n.id, a.id, v.zona_modo, v.zona_km, v.zona_loc, v.unidad, v.publico::jsonb, v.attrs
  FROM (VALUES
    -- Parrilla del Paseo Ardora. Dos momentos declarados en el brief: mediodía express
    -- (take away + delivery) y noche a la carta (vinos, ticket alto).
    ('cortafuego', 'gastronomia.parrilla', 'localidades', NULL,
     ARRAY['Ranelagh','Hudson','Berazategui'], 'persona',
     '{"momentos":["mediodia","noche"]}',
     ARRAY['take_away','delivery','carta_vinos']),

    -- Fútbol 5/7/11 y pádel en sintético con iluminación artificial, torneos y escuela de pádel.
    ('ardora-sport', 'deporte.complejo', 'radio', 10,
     ARRAY[]::text[], 'hora',
     '{"momentos":["tarde","noche","finde"]}',
     ARRAY['iluminacion','escuela','torneos','aire_libre']),

    -- Municipio: la zona ES el partido, y no tiene ticket.
    ('berazategui', 'gobierno.municipio', 'localidades', NULL,
     ARRAY['Berazategui'], NULL,
     '{}',
     ARRAY[]::text[]),

    -- La agencia. Opera a distancia: sin sede que importe y alcance nacional.
    ('clausina', 'servicios.marketing', 'nacional', NULL,
     ARRAY[]::text[], 'mes',
     '{}',
     ARRAY[]::text[]),

    -- Farmacia + perfumería con tienda online propia y venta por WhatsApp.
    ('farmanobel', 'salud.farmacia', 'localidades', NULL,
     ARRAY['El Pato','Ingeniero Allan','Berazategui'], 'orden',
     '{}',
     ARRAY['tienda_online']),

    -- Escuela oficial de fútbol de Independiente: 5 a 18 años, cuota mensual.
    ('formacion-independiente', 'educacion.escuela_deportiva', 'localidades', NULL,
     ARRAY['Ranelagh','Berazategui','Ezpeleta','Quilmes'], 'mes',
     '{"edades":[5,18],"momentos":["tarde","finde"]}',
     ARRAY['escuela']),

    -- Desarrollo inmobiliario: zona sur de CABA + el proyecto Ardora en Berazategui.
    ('ibitat', 'inmobiliario.desarrollo', 'localidades', NULL,
     ARRAY['Ciudad Autónoma de Buenos Aires','Berazategui'], NULL,
     '{}',
     ARRAY[]::text[]),

    -- Tenis y pádel en el predio del CAI Wilde: 3 canchas cubiertas, 2 al aire libre,
    -- staff de instructores y reservas por WhatsApp.
    ('set-point-wilde', 'deporte.complejo', 'radio', 10,
     ARRAY[]::text[], 'hora',
     '{"momentos":["tarde","noche","finde"]}',
     ARRAY['cubierto','aire_libre','escuela','reserva_previa'])
  ) AS v(slug, act, zona_modo, zona_km, zona_loc, unidad, publico, attrs)
  JOIN contenido.negocios n ON n.slug = v.slug
  JOIN contenido.actividad a ON a.codigo = v.act
ON CONFLICT (negocio_id) DO NOTHING;   -- no pisa una ficha que alguien ya editó

-- ── Sedes ───────────────────────────────────────────────────────────────────
-- Sólo para negocios que todavía no tienen ninguna cargada (así no duplica al re-correr).
INSERT INTO contenido.negocio_sede
  (negocio_id, nombre, direccion, localidad, partido, provincia, principal, orden)
SELECT n.id, v.nombre, v.direccion, v.localidad, v.partido, v.provincia, v.principal, v.orden
  FROM (VALUES
    ('cortafuego',              NULL,          'Av. Valentín Vergara 3200 y Calle 32', 'Ranelagh', 'Berazategui', 'Buenos Aires', true,  0),
    ('ardora-sport',            NULL,          'Av. Valentín Vergara 3100',            'Ranelagh', 'Berazategui', 'Buenos Aires', true,  0),
    ('farmanobel',              'El Pato',     'Calle 514 N° 1344',                    'El Pato',  'Berazategui', 'Buenos Aires', true,  0),
    ('farmanobel',              'Plastino',    'Colectora Autovía 2',                  NULL,       'Berazategui', 'Buenos Aires', false, 1),
    ('formacion-independiente', 'Ardora Sport','Av. Valentín Vergara 3100',            'Ranelagh', 'Berazategui', 'Buenos Aires', true,  0),
    ('formacion-independiente', 'Berazategui', NULL,                                   NULL,       'Berazategui', 'Buenos Aires', false, 1),
    ('formacion-independiente', 'Ezpeleta',    NULL,                                   'Ezpeleta', 'Quilmes',     'Buenos Aires', false, 2),
    ('formacion-independiente', 'Quilmes',     NULL,                                   'Quilmes',  'Quilmes',     'Buenos Aires', false, 3),
    ('ibitat',                  NULL,          'Rondeau 2858',                         'Parque Patricios', 'Comuna 4', 'Ciudad Autónoma de Buenos Aires', true, 0),
    ('set-point-wilde',         NULL,          'Robles 6414 esq. Las Flores',          'Wilde',    'Avellaneda',  'Buenos Aires', true,  0)
  ) AS v(slug, nombre, direccion, localidad, partido, provincia, principal, orden)
  JOIN contenido.negocios n ON n.slug = v.slug
 WHERE NOT EXISTS (SELECT 1 FROM contenido.negocio_sede s WHERE s.negocio_id = n.id);

COMMIT;
