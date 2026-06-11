-- Fase 3: avisos absorbidos en piezas/revisiones/media (canal='aviso'). Migra el aviso existente
-- de pantalla_avisos y retira la tabla vieja. solicitudes_propuesta gana canal.
ALTER TABLE contenido.solicitudes_propuesta ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'instagram';

DO $mig$
DECLARE pid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contenido.piezas WHERE canal='aviso') THEN
    INSERT INTO contenido.piezas (proyecto_id, titulo_interno, canal, notas)
    VALUES ('1937dba3-cd87-4a03-8e5d-7f3ae7c492f9', 'Muy pronto — pre-apertura', 'aviso', 'Migrado de pantalla_avisos')
    RETURNING id INTO pid;

    INSERT INTO contenido.revisiones (pieza_id, nro, estado, formato, caption, daypart, clima, transito, momento, duracion_s)
    VALUES (pid, 1, 'pendiente_aprobacion'::contenido.estado_pub, 'feed',
            'Muy pronto · CORTAFUEGO · @cortafuego.ar', 'cualquiera', 'cualquiera', 'cualquiera', 'pre-apertura', 10);

    INSERT INTO contenido.media (pieza_id, orden, tipo, url, poster_url)
    VALUES (pid, 1, 'video'::contenido.tipo_media,
            'media/avisos/aviso_muy-pronto_pre-apertura_20260606.mp4',
            'media/avisos/aviso_muy-pronto_pre-apertura_20260606.jpg');
  END IF;
END $mig$;

DROP TABLE IF EXISTS contenido.pantalla_avisos;
