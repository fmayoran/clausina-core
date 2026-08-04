-- ClaUsina v2.0 — F1: identidad estructurada.
-- La identidad ya existía como PROSA (negocio_perfil.brief_md): sirve al creativo pero no se puede
-- consultar. Esto agrega la capa estructurada, que es la que después permite filtrar, segmentar y
-- —en F7— que un agente externo encuentre al negocio. Ver core/planes/V2.md.
-- Idempotente: se puede correr de nuevo sin romper nada.
BEGIN;

-- ── Taxonomía de actividades ────────────────────────────────────────────────
-- Curada a propósito, NO texto libre: el matcheo del catálogo depende de que dos parrillas
-- estén clasificadas igual. Arranca con lo que necesitan los 8 negocios reales y se extiende.
CREATE TABLE IF NOT EXISTS contenido.actividad (
  id       serial PRIMARY KEY,
  codigo   text UNIQUE NOT NULL,          -- 'gastronomia.parrilla'
  nombre   text NOT NULL,
  padre_id int REFERENCES contenido.actividad(id),
  activa   boolean NOT NULL DEFAULT true,
  orden    int NOT NULL DEFAULT 100
);

-- ── Vocabulario controlado de atributos ─────────────────────────────────────
-- Si cada negocio escribe el suyo, el filtro "pet friendly" no encuentra al que puso
-- "acepta mascotas". Por eso catálogo y no jsonb libre.
CREATE TABLE IF NOT EXISTS contenido.atributo (
  codigo text PRIMARY KEY,
  nombre text NOT NULL,
  grupo  text NOT NULL DEFAULT 'general',  -- agrupa la UI; no restringe quién lo puede usar
  orden  int NOT NULL DEFAULT 100
);

-- ── Ficha estructurada del negocio ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contenido.negocio_identidad (
  negocio_id       uuid PRIMARY KEY REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  actividad_id     int REFERENCES contenido.actividad(id),
  -- hasta dónde llega
  zona_modo        text NOT NULL DEFAULT 'radio'
                     CHECK (zona_modo IN ('radio','localidades','nacional')),
  zona_km          int,
  zona_localidades text[] NOT NULL DEFAULT '{}',
  -- cuánto sale. Nullable a propósito: un municipio no tiene ticket.
  ticket_min       numeric(12,2),
  ticket_max       numeric(12,2),
  moneda           text NOT NULL DEFAULT 'ARS',
  ticket_unidad    text CHECK (ticket_unidad IN ('persona','orden','mes','hora','clase')),
  -- a quién le habla:  {edades:[25,55], momentos:['noche','finde'], intereses:[...]}
  publico          jsonb NOT NULL DEFAULT '{}'::jsonb,
  atributos        text[] NOT NULL DEFAULT '{}',
  -- {lun:[["19:00","00:30"]], mar:[...]}
  horarios         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL = la ficha es una PROPUESTA sin confirmar por una persona.
  revisado_en      timestamptz,
  revisado_por     uuid REFERENCES contenido.usuario(id) ON DELETE SET NULL,
  actualizado_en   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_coherente CHECK (ticket_min IS NULL OR ticket_max IS NULL OR ticket_min <= ticket_max),
  CONSTRAINT radio_positivo   CHECK (zona_km IS NULL OR zona_km > 0)
);

CREATE INDEX IF NOT EXISTS negocio_identidad_actividad_ix ON contenido.negocio_identidad (actividad_id);
CREATE INDEX IF NOT EXISTS negocio_identidad_atributos_ix ON contenido.negocio_identidad USING gin (atributos);

-- ── Sedes ───────────────────────────────────────────────────────────────────
-- Una dirección sola no alcanza: FarmaNobel tiene 2 sucursales y Formación Independiente 4 sedes.
-- La geografía del catálogo se resuelve por sede, no por negocio.
CREATE TABLE IF NOT EXISTS contenido.negocio_sede (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negocio_id uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  nombre     text,                        -- 'El Pato', 'Sede Quilmes'
  direccion  text,
  localidad  text,
  partido    text,
  provincia  text,
  pais       text NOT NULL DEFAULT 'AR',
  lat        double precision,
  lon        double precision,
  telefono   text,
  principal  boolean NOT NULL DEFAULT false,
  orden      int NOT NULL DEFAULT 100,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS negocio_sede_negocio_ix ON contenido.negocio_sede (negocio_id);
-- Una sola sede principal por negocio (la base lo garantiza, no el código del panel).
CREATE UNIQUE INDEX IF NOT EXISTS negocio_sede_principal_ux
  ON contenido.negocio_sede (negocio_id) WHERE principal;

-- ── Semilla: taxonomía ──────────────────────────────────────────────────────
INSERT INTO contenido.actividad (codigo, nombre, orden) VALUES
  ('gastronomia',  'Gastronomía',   10),
  ('deporte',      'Deporte',       20),
  ('educacion',    'Educación',     30),
  ('salud',        'Salud',         40),
  ('inmobiliario', 'Inmobiliario',  50),
  ('retail',       'Comercio',      60),
  ('servicios',    'Servicios',     70),
  ('gobierno',     'Gobierno',      80)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO contenido.actividad (codigo, nombre, padre_id, orden)
SELECT v.codigo, v.nombre, p.id, v.orden
  FROM (VALUES
    ('gastronomia.parrilla',           'Parrilla / asador',        'gastronomia',  10),
    ('gastronomia.restaurante',        'Restaurante',              'gastronomia',  20),
    ('gastronomia.pizzeria',           'Pizzería',                 'gastronomia',  30),
    ('gastronomia.cafeteria',          'Cafetería',                'gastronomia',  40),
    ('gastronomia.bar',                'Bar',                      'gastronomia',  50),
    ('deporte.complejo',               'Complejo deportivo',       'deporte',      10),
    ('deporte.gimnasio',               'Gimnasio',                 'deporte',      20),
    ('deporte.club',                   'Club',                     'deporte',      30),
    ('educacion.escuela_deportiva',    'Escuela deportiva',        'educacion',    10),
    ('educacion.instituto',            'Instituto',                'educacion',    20),
    ('educacion.cursos',               'Cursos y capacitación',    'educacion',    30),
    ('salud.farmacia',                 'Farmacia',                 'salud',        10),
    ('salud.consultorio',              'Consultorio',              'salud',        20),
    ('salud.centro_diagnostico',       'Centro de diagnóstico',    'salud',        30),
    ('inmobiliario.desarrollo',        'Desarrollo inmobiliario',  'inmobiliario', 10),
    ('inmobiliario.inmobiliaria',      'Inmobiliaria',             'inmobiliario', 20),
    ('retail.indumentaria',            'Indumentaria',             'retail',       10),
    ('retail.perfumeria',              'Perfumería',               'retail',       20),
    ('retail.tienda',                  'Tienda',                   'retail',       30),
    ('servicios.marketing',            'Marketing y comunicación', 'servicios',    10),
    ('servicios.profesional',          'Servicios profesionales',  'servicios',    20),
    ('gobierno.municipio',             'Municipio',                'gobierno',     10)
  ) AS v(codigo, nombre, padre, orden)
  JOIN contenido.actividad p ON p.codigo = v.padre
ON CONFLICT (codigo) DO NOTHING;

-- ── Semilla: atributos ──────────────────────────────────────────────────────
INSERT INTO contenido.atributo (codigo, nombre, grupo, orden) VALUES
  ('estacionamiento',  'Estacionamiento',        'acceso',     10),
  ('accesible',        'Accesible',              'acceso',     20),
  ('transporte_publico','Cerca de transporte',   'acceso',     30),
  ('pet_friendly',     'Pet friendly',           'acceso',     40),
  ('aire_libre',       'Espacio al aire libre',  'lugar',      10),
  ('cubierto',         'Cubierto',               'lugar',      20),
  ('iluminacion',      'Iluminación nocturna',   'lugar',      30),
  ('vestuarios',       'Vestuarios',             'lugar',      40),
  ('wifi',             'WiFi',                   'lugar',      50),
  ('delivery',         'Delivery',               'servicio',   10),
  ('take_away',        'Take away',              'servicio',   20),
  ('reserva_previa',   'Reserva previa',         'servicio',   30),
  ('turno_online',     'Turno online',           'servicio',   40),
  ('envio_domicilio',  'Envío a domicilio',      'servicio',   50),
  ('tienda_online',    'Tienda online',          'servicio',   60),
  ('apto_celiacos',    'Apto celíacos',          'gastronomia',10),
  ('menu_vegetariano', 'Opción vegetariana',     'gastronomia',20),
  ('carta_vinos',      'Carta de vinos',         'gastronomia',30),
  ('tarjeta',          'Tarjetas de crédito',    'pago',       10),
  ('mercado_pago',     'Mercado Pago',           'pago',       20),
  ('obra_social',      'Obras sociales',         'pago',       30),
  ('escuela',          'Escuela / clases',       'oferta',     10),
  ('torneos',          'Torneos',                'oferta',     20),
  ('eventos',          'Eventos privados',       'oferta',     30)
ON CONFLICT (codigo) DO NOTHING;

COMMIT;
