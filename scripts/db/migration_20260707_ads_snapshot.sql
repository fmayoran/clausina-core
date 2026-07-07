-- Pauta (Meta Marketing API, read-only): snapshot del reporte de anuncios por marca.
-- Un cron (cf-pauta-sync) le pega a Meta con el token de la cápsula y guarda acá el último
-- estado; el panel lee de esta tabla (no hace llamadas externas en cada carga).
CREATE TABLE IF NOT EXISTS contenido.ads_snapshot (
  proyecto_id  uuid PRIMARY KEY REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  capturado_en timestamptz NOT NULL DEFAULT now(),
  data         jsonb       NOT NULL
);
COMMENT ON TABLE contenido.ads_snapshot IS 'Último snapshot de pauta (Meta Marketing API) por marca. Escribe cf-pauta-sync; lee el panel.';
