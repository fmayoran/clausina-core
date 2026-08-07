-- ClaUsina v2.0 / F6 — el beneficio elige sobre qué diseño base sale su invitación.
--
-- Hasta ahora la invitación heredaba el modo de la marca del negocio, y para una marca oscura
-- eso significa imprimir en negro: gasta tinta, se ve peor en papel común y no es lo que uno
-- quiere para algo que se reparte en mano. El default es 'claro' a propósito: lo impreso se
-- piensa sobre papel blanco, y quien quiera la versión oscura ahora tiene que pedirla.
BEGIN;

ALTER TABLE contenido.beneficio
  ADD COLUMN IF NOT EXISTS tema text NOT NULL DEFAULT 'claro';

ALTER TABLE contenido.beneficio
  DROP CONSTRAINT IF EXISTS beneficio_tema_check;
ALTER TABLE contenido.beneficio
  ADD CONSTRAINT beneficio_tema_check CHECK (tema IN ('claro', 'oscuro'));

COMMIT;
