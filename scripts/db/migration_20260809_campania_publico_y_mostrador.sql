-- ClaUsina v2.0 / F7a — dos cosas que faltaban para que una campaña sea usable de verdad.
--
-- 1. EL PÚBLICO DE LA CAMPAÑA. Una campaña se define por a quién le habla, no sólo por qué
--    quiere lograr. Es además lo que el creativo necesita para proponer acciones que sirvan.
--
-- 2. CANJE SIN RESERVA. `invitacion_uso.reserva_id` era obligatorio: un código sólo podía
--    consumirse reservando. Eso deja afuera al público de paso —el mediodía express, donde
--    nadie reserva un sandwich— que es justamente donde un código REUTILIZABLE repartido en
--    folleto o publicado en la pantalla de la esquina tiene más sentido. Sin esto, ese público
--    aparece como orgánico aunque sea el que más funciona.
BEGIN;

ALTER TABLE contenido.campania ADD COLUMN IF NOT EXISTS publico text;

-- El uso puede no tener reserva: lo carga alguien del mostrador cuando la persona llega con el
-- código en la mano.
ALTER TABLE contenido.invitacion_uso ALTER COLUMN reserva_id DROP NOT NULL;

-- El único era total y ahora tiene que ser parcial: una reserva sigue admitiendo un solo uso,
-- pero varios canjes de mostrador conviven sin reserva. Sin `WHERE`, dos canjes sin reserva
-- chocarían entre sí por tener los dos NULL en algunos motores, y acá directamente impediría
-- el segundo uso del mismo código.
DROP INDEX IF EXISTS contenido.invitacion_uso_reserva_ux;
CREATE UNIQUE INDEX invitacion_uso_reserva_ux
  ON contenido.invitacion_uso (reserva_id) WHERE reserva_id IS NOT NULL;

-- De dónde vino el canje. Se guarda explícito y no se deduce de si hay reserva: mañana puede
-- haber otros orígenes (delivery, mail) y "reserva_id IS NULL" dejaría de significar mostrador.
ALTER TABLE contenido.invitacion_uso ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'reserva';
ALTER TABLE contenido.invitacion_uso DROP CONSTRAINT IF EXISTS invitacion_uso_canal_chk;
ALTER TABLE contenido.invitacion_uso
  ADD CONSTRAINT invitacion_uso_canal_chk CHECK (canal IN ('reserva','mostrador'));

COMMIT;
