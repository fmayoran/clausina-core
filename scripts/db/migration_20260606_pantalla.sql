-- Avisos de la pantalla de calle (DOOH) en la base, para visualizar y hacer seguimiento (06/06/2026).
-- El panel los lista y reproduce (sirve los mp4/poster desde pantalla/ montado en el contenedor).
-- archivo/poster son rutas relativas dentro de pantalla/ (ej. avisos/aviso_x.mp4). Fuente para el
-- programador dinámico de Fase 2 (elige por daypart/clima/transito/momento).
CREATE TABLE IF NOT EXISTS contenido.pantalla_avisos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo          text NOT NULL,
  archivo         text NOT NULL,
  poster          text,
  duracion_s      int,
  daypart         text DEFAULT 'cualquiera',   -- manana | mediodia | tarde | noche | cualquiera
  clima           text DEFAULT 'cualquiera',   -- frio | lluvia | calor | cualquiera
  transito        text DEFAULT 'cualquiera',   -- alto | normal | cualquiera
  momento         text DEFAULT 'generico',     -- pre-apertura | apertura | promo-relampago | generico
  copy            text,
  estado          text NOT NULL DEFAULT 'listo', -- borrador | listo | en-pantalla | retirado
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);
