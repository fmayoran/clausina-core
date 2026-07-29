-- Registro de cada corrida de job del worker.
--
-- Por qué: `worker.py` recibía el (ok, detalle) de TODOS los handlers y sólo lo imprimía al
-- journal de systemd. Un job que fallaba no dejaba rastro en ningún lado que Fer pudiera ver:
-- el pedido quedaba en 'procesando' y había que leer `journalctl -u cf-worker` para enterarse.
-- Registrar el resultado en el centro (worker.py) cubre los 15 handlers de una, en vez de
-- parchear script por script.

CREATE TABLE IF NOT EXISTS contenido.job_runs (
  id            bigserial PRIMARY KEY,
  tipo          text        NOT NULL,
  negocio_slug  text,
  ok            boolean     NOT NULL,
  detalle       text,
  duracion_ms   integer,
  creado_en     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobruns_creado ON contenido.job_runs (creado_en DESC);
-- Índice parcial: las consultas que importan (verificador, panel) miran sólo los fallos.
CREATE INDEX IF NOT EXISTS idx_jobruns_fallos ON contenido.job_runs (creado_en DESC) WHERE NOT ok;

COMMENT ON TABLE contenido.job_runs IS
  'Resultado de cada job del worker. Lo escribe workers/worker.py; lo poda db_backup.sh a 30 días.';
