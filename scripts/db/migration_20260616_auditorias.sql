-- Auditorías de presencia digital por proyecto (snapshot: KPIs + recomendaciones).
-- Se visualizan en el panel; a futuro se generan periódicamente por cron.
CREATE TABLE IF NOT EXISTS contenido.auditorias (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id    uuid NOT NULL REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  canal          text NOT NULL DEFAULT 'instagram',   -- instagram | web | global
  periodo        text,                                -- ej. 'histórico', 'últimos 90 días'
  kpis           jsonb NOT NULL,                       -- datos para los gráficos
  recomendaciones text,                                -- resumen/acciones (markdown)
  creada_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auditorias_proy_canal_idx ON contenido.auditorias(proyecto_id, canal, creada_en DESC);
