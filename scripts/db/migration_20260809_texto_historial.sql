-- ClaUsina — historial de los textos largos del perfil (brief y estilo).
--
-- NACE DE UN INCIDENTE REAL (09/08/2026): editando el brief de Cortafuego, el contenido quedó
-- reducido de 9018 a 342 caracteres —sobrevivió sólo la cola, desde el cursor hasta el final— y
-- el guardado lo aceptó sin decir nada. Se recuperó del respaldo de las 07:00, pero las ediciones
-- de esa mañana se perdieron para siempre.
--
-- Dos defensas, y esta es la segunda: aunque algo pise el texto, la versión anterior queda a un
-- clic. La primera es la guarda contra recortes bruscos, que vive en el código.
--
-- Sólo los campos donde un borrado accidental duele: son textos largos, escritos a mano y sin
-- otra copia. El resto del perfil son datos cortos que se vuelven a tipear en diez segundos.
BEGIN;

CREATE TABLE IF NOT EXISTS contenido.perfil_texto_hist (
  id          bigserial PRIMARY KEY,
  negocio_id  uuid NOT NULL REFERENCES contenido.negocios(id) ON DELETE CASCADE,
  campo       text NOT NULL,
  contenido   text NOT NULL,
  largo       integer NOT NULL,
  usuario_id  uuid,
  guardado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT perfil_texto_hist_campo_chk CHECK (campo IN ('brief_md', 'estilo_md'))
);
-- Se lee siempre igual: "las últimas versiones de ESTE campo de ESTE negocio".
CREATE INDEX IF NOT EXISTS perfil_texto_hist_ix
  ON contenido.perfil_texto_hist (negocio_id, campo, guardado_en DESC);

COMMIT;
