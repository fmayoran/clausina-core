// Capa de datos del panel — TODA la SQL vive acá (aislada para portar fácil a FastAPI a futuro).
// Lectura sobre el schema `contenido` (base `claude`). Conexión por variables de entorno PG*.
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'crm_pgvector',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'claude',
  max: 4,
  idleTimeoutMillis: 30000,
});

// --- Marcas (tenants) ---
// Cache en memoria de las marcas (proyectos): el panel resuelve la marca activa en cada request.
let _marcas = null, _marcasAt = 0;
async function getMarcas() {
  if (!_marcas || Date.now() - _marcasAt > 60000) {
    const { rows } = await pool.query(
      `SELECT p.id, p.slug, p.nombre, p.activo, pp.logo
         FROM contenido.proyectos p LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
        ORDER BY p.activo DESC, p.creado_en`);
    _marcas = rows; _marcasAt = Date.now();
  }
  return _marcas;
}
async function getProyectoId(slug) {
  const f = (await getMarcas()).find(x => x.slug === slug);
  return f ? f.id : null;
}

// --- Perfil del proyecto (registro que consume el creativo): marca + slogan + logo + brief ---
async function getPerfil(proyectoId) {
  const { rows: [r] } = await pool.query(
    `SELECT p.nombre, p.ig_handle, p.ig_user_id, p.dominio_web, p.telegram_chat_id, p.email, p.whatsapp,
            pp.slogan, pp.logo, pp.brief_md, pp.actualizado_en
       FROM contenido.proyectos p LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
      WHERE p.id=$1`, [proyectoId]);
  return r || {};
}
async function guardarPerfil(proyectoId, d) {
  const nn = s => (s != null && String(s).trim() !== '') ? String(s).trim() : null;
  if (nn(d.nombre)) await pool.query('UPDATE contenido.proyectos SET nombre=$2 WHERE id=$1', [proyectoId, nn(d.nombre)]);
  await pool.query(
    `UPDATE contenido.proyectos SET ig_handle=$2, dominio_web=$3, ig_user_id=$4, telegram_chat_id=$5, email=$6, whatsapp=$7 WHERE id=$1`,
    [proyectoId, nn(d.ig_handle), nn(d.dominio_web), nn(d.ig_user_id), nn(d.telegram_chat_id), nn(d.email), nn(d.whatsapp)]);
  await pool.query(`
    INSERT INTO contenido.proyecto_perfil (proyecto_id, slogan, logo, brief_md, actualizado_en)
    VALUES ($1,$2,$3,$4, now())
    ON CONFLICT (proyecto_id) DO UPDATE SET slogan=$2, logo=$3, brief_md=$4, actualizado_en=now()`,
    [proyectoId, nn(d.slogan), nn(d.logo), nn(d.brief_md)]);
  _marcasAt = 0;   // el nombre pudo cambiar -> refrescar cache de marcas
  return true;
}
// Actualiza SOLO el logo (sin tocar slogan/brief). Lo usa la subida de archivo del perfil.
async function setLogo(proyectoId, url) {
  await pool.query(`
    INSERT INTO contenido.proyecto_perfil (proyecto_id, logo, actualizado_en)
    VALUES ($1,$2, now())
    ON CONFLICT (proyecto_id) DO UPDATE SET logo=$2, actualizado_en=now()`,
    [proyectoId, url]);
  _marcasAt = 0;   // el logo se cachea en la lista de marcas
  return true;
}

// Piezas con su revisión vigente + media principal (para el board por estado). Scopeado por marca.
async function getPiezas(canal, proyectoId) {
  const params = [proyectoId];
  let where = 'WHERE pz.proyecto_id = $1';
  if (canal) { params.push(canal); where += ` AND pz.canal = $${params.length}`; }
  const { rows } = await pool.query(`
    SELECT pz.id, pz.numero, pz.canal, pz.titulo_interno, pz.estado, pz.creado_en, pz.actualizado_en,
           r.nro, r.formato, r.motivo_rechazo, r.derivado_en,
           r.ig_post_id, r.ig_permalink, r.publicado_en, r.caption,
           r.daypart, r.clima, r.transito, r.momento, r.duracion_s,
           im.views AS m_views, im.reach AS m_reach, im.likes AS m_likes,
           (SELECT json_build_object('url', m.url, 'tipo', m.tipo, 'poster_url', m.poster_url)
              FROM contenido.media m WHERE m.pieza_id = pz.id AND m.orden = 1) AS media,
           (SELECT COALESCE(json_agg(json_build_object('url', m.url, 'tipo', m.tipo, 'poster_url', m.poster_url) ORDER BY m.orden), '[]'::json)
              FROM contenido.media m WHERE m.pieza_id = pz.id) AS medios,
           (SELECT count(*)::int FROM contenido.media m WHERE m.pieza_id = pz.id) AS n_media,
           (SELECT count(*)::int FROM contenido.revisiones rr WHERE rr.pieza_id = pz.id) AS n_revisiones
    FROM contenido.piezas pz
    JOIN contenido.revisiones r ON r.id = pz.revision_vigente
    LEFT JOIN contenido.ig_metricas im ON im.ig_post_id = r.ig_post_id
    ${where}
    ORDER BY COALESCE(r.publicado_en, pz.actualizado_en) DESC
    LIMIT 300;`, params);
  return rows;
}

// Canal + token + estado de la revisión vigente (para ramificar la acción por canal).
async function getPiezaCanal(id) {
  const { rows } = await pool.query(
    `SELECT pz.canal, r.token, r.estado FROM contenido.piezas pz
       JOIN contenido.revisiones r ON r.id = pz.revision_vigente WHERE pz.id = $1`, [id]);
  return rows[0] || null;
}

// Avisos: cambio de estado directo en la base (no hay API externa). Aprobar=publicada (en pantalla).
async function avisoEstado(id, estado, motivo) {
  const setPub = estado === 'publicada' ? ', publicado_en = now()' : '';
  const { rowCount } = await pool.query(
    `UPDATE contenido.revisiones SET estado = $2::contenido.estado_pub,
       motivo_rechazo = CASE WHEN $2='rechazada' THEN NULLIF($3,'') ELSE motivo_rechazo END ${setPub}
     WHERE id = (SELECT revision_vigente FROM contenido.piezas WHERE id = $1)
       AND estado = 'pendiente_aprobacion'`, [id, estado, motivo || null]);
  return rowCount > 0;
}

// IDs de posts publicados (para refrescar métricas).
async function getPostIdsPublicados() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ig_post_id FROM contenido.revisiones WHERE estado='publicada' AND ig_post_id IS NOT NULL`);
  return rows.map(r => r.ig_post_id);
}

// Upsert de métricas de un post.
async function upsertMetricas(id, v) {
  // proyecto_id se deriva de la pieza dueña del post (no hace falta pasarlo): cada métrica queda en su marca.
  await pool.query(
    `INSERT INTO contenido.ig_metricas (ig_post_id, views, reach, likes, comments, saved, shares, total_interactions, proyecto_id, actualizado_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
       (SELECT pz.proyecto_id FROM contenido.revisiones r JOIN contenido.piezas pz ON pz.id=r.pieza_id WHERE r.ig_post_id=$1 LIMIT 1), now())
     ON CONFLICT (ig_post_id) DO UPDATE SET
       views=$2, reach=$3, likes=$4, comments=$5, saved=$6, shares=$7, total_interactions=$8, actualizado_en=now()`,
    [id, v.views || 0, v.reach || 0, v.likes || 0, v.comments || 0, v.saved || 0, v.shares || 0, v.total_interactions || 0]);
}

// Cola de requerimientos: brief + la pieza que generó (correlación) y su estado derivado.
// Se mantiene visible hasta que la pieza llegue a un estado terminal (publicada/descartada).
async function getRequerimientos(proyectoId) {
  const { rows } = await pool.query(`
    SELECT b.id, b.estado AS brief_estado, b.origen, b.canal_destino, b.titulo AS req_titulo, b.requiere_material, b.enlace,
           b.media_type, (b.voice_file_id IS NOT NULL) AS tiene_audio,
           (b.media_file_id IS NOT NULL) AS tiene_media, b.comentarios,
           (SELECT count(*)::int FROM contenido.brief_material bm WHERE bm.brief_id = b.id) AS n_material,
           COALESCE(NULLIF(b.transcripcion,''), b.texto) AS texto, b.creado_en,
           b.pieza_id, pz.numero AS pieza_numero, pz.titulo_interno AS pieza_titulo,
           r.estado AS pieza_estado, r.nro AS pieza_rev
    FROM contenido.tg_briefs b
    LEFT JOIN contenido.piezas pz ON pz.id = b.pieza_id
    LEFT JOIN contenido.revisiones r ON r.id = pz.revision_vigente
    WHERE b.proyecto_id = $1 AND (
            (b.pieza_id IS NULL AND b.estado IN ('propuesta','pendiente','procesando','error'))
         OR (b.pieza_id IS NOT NULL AND r.estado IN ('pendiente_aprobacion','rechazada','aprobada','borrador')))
    ORDER BY (b.estado='propuesta') DESC, b.creado_en DESC
    LIMIT 100;`, [proyectoId]);
  // Pedidos de propuestas en curso (placeholder en la cola mientras el creativo elabora).
  const { rows: sol } = await pool.query(`
    SELECT id, estado AS brief_estado, canal AS canal_destino, enfasis, creado_en, true AS es_solicitud
    FROM contenido.solicitudes_propuesta WHERE proyecto_id = $1 AND estado IN ('pendiente','procesando')
    ORDER BY creado_en DESC`, [proyectoId]);
  return [...sol, ...rows];
}

// Inserta una mención entrante en la cola (dedupe por ref_externa = ig media id). Devuelve true si era nueva.
const TG_CHAT = process.env.PANEL_TG_CHAT || '811183062';
async function insertMencion(refId, username, permalink, proyectoId) {
  const titulo = `Mención de @${username}`;
  const texto = `@${username} etiquetó a la marca en Instagram.\n\nSi generás, armá una pieza de marca para agradecer o aprovechar la mención (tono de marca, sin emojis).\nPost original: ${permalink}`;
  const { rows } = await pool.query(
    `INSERT INTO contenido.tg_briefs (chat_id, origen, estado, titulo, texto, enlace, ref_externa, proyecto_id)
     SELECT $1, 'mencion', 'propuesta', $2, $3, $4, $5, $6
     WHERE NOT EXISTS (SELECT 1 FROM contenido.tg_briefs WHERE ref_externa = $5)
     RETURNING id`, [TG_CHAT, titulo, texto, permalink || null, refId, proyectoId]);
  return rows.length > 0;
}

// Pedido de propuestas al creativo (lo levanta el cron propuestas_local.sh). cantidad: 1..8.
async function pedirPropuestas(enfasis, canal, cantidad, proyectoId) {
  const n = Math.min(8, Math.max(1, parseInt(cantidad, 10) || 5));
  await pool.query(`INSERT INTO contenido.solicitudes_propuesta (enfasis, canal, cantidad, proyecto_id) VALUES ($1,$2,$3,$4)`,
    [enfasis || null, canal === 'aviso' ? 'aviso' : 'instagram', n, proyectoId]);
  return true;
}

// Agrega un material (file_id de Telegram) a la galería del requerimiento. NO cambia el estado:
// el requerimiento sigue como 'propuesta' hasta que Fer aprieta "Generar publicación".
async function addMaterial(briefId, fileId, mediaType, filename) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.brief_material (brief_id, file_id, media_type, filename, orden)
       SELECT $1, $2, $3, $4, COALESCE((SELECT max(orden)+1 FROM contenido.brief_material WHERE brief_id=$1), 0)
       WHERE EXISTS (SELECT 1 FROM contenido.tg_briefs WHERE id=$1 AND estado IN ('propuesta','error'))
     RETURNING id, media_type, filename, orden`, [briefId, fileId, mediaType, filename || null]);
  return rows[0] || null;
}

// Lista los materiales aportados a un requerimiento (para la galería del modal).
async function getMateriales(briefId) {
  const { rows } = await pool.query(
    `SELECT id, media_type, filename, orden FROM contenido.brief_material
      WHERE brief_id=$1 ORDER BY orden, creado_en`, [briefId]);
  return rows;
}

// file_id de un material puntual (para el proxy de miniatura).
async function getMaterialFile(mid) {
  const { rows } = await pool.query(
    `SELECT file_id AS media_file_id, media_type FROM contenido.brief_material WHERE id=$1`, [mid]);
  return rows[0] || null;
}

// Quita un material de la galería (antes de generar).
async function delMaterial(briefId, mid) {
  const { rowCount } = await pool.query(
    `DELETE FROM contenido.brief_material WHERE id=$1 AND brief_id=$2`, [mid, briefId]);
  return rowCount > 0;
}

// --- Material aportado AL RECHAZAR una pieza ---
// Se adjunta a la galería del brief que generó la pieza (brief.pieza_id), para que la rutina de
// corrección lo descargue y lo use al reprocesar. Solo mientras la pieza está pendiente de aprobación
// (el panel sube el material ANTES de confirmar el rechazo).
async function addMaterialPorPieza(piezaId, fileId, mediaType, filename) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.brief_material (brief_id, file_id, media_type, filename, orden)
       SELECT b.id, $2, $3, $4, COALESCE((SELECT max(orden)+1 FROM contenido.brief_material WHERE brief_id=b.id), 0)
       FROM contenido.tg_briefs b
       JOIN contenido.piezas pz ON pz.id = b.pieza_id
       JOIN contenido.revisiones r ON r.id = pz.revision_vigente
       WHERE b.pieza_id = $1 AND r.estado = 'pendiente_aprobacion'
     RETURNING id, media_type, filename, orden`, [piezaId, fileId, mediaType, filename || null]);
  return rows[0] || null;
}
async function getMaterialesPorPieza(piezaId) {
  const { rows } = await pool.query(
    `SELECT bm.id, bm.media_type, bm.filename, bm.orden
       FROM contenido.brief_material bm JOIN contenido.tg_briefs b ON b.id = bm.brief_id
      WHERE b.pieza_id = $1 ORDER BY bm.orden, bm.creado_en`, [piezaId]);
  return rows;
}
async function delMaterialPorPieza(piezaId, mid) {
  const { rowCount } = await pool.query(
    `DELETE FROM contenido.brief_material bm USING contenido.tg_briefs b
      WHERE bm.id = $2 AND bm.brief_id = b.id AND b.pieza_id = $1`, [piezaId, mid]);
  return rowCount > 0;
}

// "Generar publicación": guarda los comentarios y manda el requerimiento al circuito -> 'pendiente'.
async function generarReq(id, comentarios) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.tg_briefs SET comentarios=$2, estado='pendiente'
      WHERE id=$1 AND estado IN ('propuesta','error')`, [id, (comentarios || '').slice(0, 2000) || null]);
  return rowCount > 0;
}

// Activa una propuesta que no requiere material nuevo -> 'pendiente'.
async function activarReq(id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.tg_briefs SET estado='pendiente' WHERE id=$1 AND estado='propuesta'`, [id]);
  return rowCount > 0;
}

// Descarta un requerimiento/propuesta -> sale de la cola.
async function descartarReq(id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.tg_briefs SET estado='descartada' WHERE id=$1 AND estado IN ('propuesta','pendiente','error')`, [id]);
  return rowCount > 0;
}

// file_id de la media de un requerimiento (para el proxy de miniatura).
async function getBriefMedia(id) {
  const { rows } = await pool.query(
    `SELECT media_file_id, media_type FROM contenido.tg_briefs WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Estado de los workers (infra global, igual para todas las marcas): worker (procesando/en espera),
// dispatcher (salud del chequeo) y última corrida real de cada proceso. La barra de control lo lee.
async function getStatus(_proyectoId) {
  const { rows } = await pool.query(`
    SELECT proceso, last_msg,
           EXTRACT(EPOCH FROM (now() - last_run))::int AS hace_s
    FROM contenido.batch_runs
    WHERE proceso IN ('worker','dispatcher','correccion','propuestas','ingesta_briefs')
    ORDER BY proceso;`);
  return rows;
}

// Token de la revisión vigente SOLO si está pendiente de aprobación.
// El token es la credencial que usan los webhooks de n8n (cf-pub-publish / cf-pub-decide).
// Vive server-side: nunca se expone en la API pública del board.
async function getTokenPendiente(piezaId) {
  const { rows } = await pool.query(
    `SELECT r.token, r.formato
       FROM contenido.piezas pz
       JOIN contenido.revisiones r ON r.id = pz.revision_vigente
      WHERE pz.id = $1 AND r.estado = 'pendiente_aprobacion'`, [piezaId]);
  return rows[0] || null;
}

// --- Programación de pantalla ---
const _avisoMedia = `(SELECT json_build_object('url',m.url,'poster_url',m.poster_url) FROM contenido.media m WHERE m.pieza_id=pz.id AND m.orden=1)`;

// Resumen de la agencia: un renglón por proyecto con descripción + indicadores (para el dashboard).
async function getResumenAgencia() {
  const { rows } = await pool.query(`
    SELECT p.id, p.slug, p.nombre, p.activo, p.ig_handle, p.dominio_web, pp.logo,
      coalesce(nullif(pp.slogan,''), left(coalesce(pp.brief_md,''), 160)) AS descripcion,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.proyecto_id=p.id AND pz.canal='instagram' AND pz.estado='pendiente_aprobacion') AS ig_pend,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.proyecto_id=p.id AND pz.canal='instagram' AND pz.estado='publicada') AS ig_pub,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.proyecto_id=p.id AND pz.canal='aviso' AND pz.estado='pendiente_aprobacion') AS av_pend,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.proyecto_id=p.id AND pz.canal='aviso' AND pz.estado='publicada') AS av_pub,
      ((SELECT count(*) FROM contenido.tg_briefs b
          LEFT JOIN contenido.piezas pz ON pz.id=b.pieza_id LEFT JOIN contenido.revisiones r ON r.id=pz.revision_vigente
          WHERE b.proyecto_id=p.id AND ((b.pieza_id IS NULL AND b.estado IN ('propuesta','pendiente','procesando','error'))
                 OR (b.pieza_id IS NOT NULL AND r.estado IN ('pendiente_aprobacion','rechazada','aprobada','borrador'))))
       + (SELECT count(*) FROM contenido.solicitudes_propuesta s WHERE s.proyecto_id=p.id AND s.estado IN ('pendiente','procesando')))::int AS req_cola
    FROM contenido.proyectos p
    LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
    ORDER BY p.activo DESC, p.creado_en`);
  return rows;
}

// --- Pantallas: la programación es a nivel PANTALLA (activo compartido), cross-proyecto ---
let _pantalla = null, _pantallaAt = 0;
async function getPantallaActiva() {
  // Default para la programación: la activa, o cualquiera si ninguna está activa (no dejar la gestión sin pantalla).
  if (!_pantalla || Date.now() - _pantallaAt > 60000) {
    const { rows } = await pool.query(
      `SELECT id, slug, nombre, vnnox_player_ids, ancho, alto, activo FROM contenido.pantallas ORDER BY activo DESC, creado_en LIMIT 1`);
    _pantalla = rows[0] || null; _pantallaAt = Date.now();
  }
  return _pantalla;
}
async function getPantallaPorSlug(slug) {
  // No filtra por activo: se puede programar/seleccionar una pantalla aunque esté marcada inactiva.
  const { rows } = await pool.query(
    `SELECT id, slug, nombre, vnnox_player_ids, ancho, alto, activo FROM contenido.pantallas WHERE slug=$1`, [slug]);
  return rows[0] || null;
}

// Gestión de pantallas (multi-pantalla).
async function getPantallas() {
  const { rows } = await pool.query(`
    SELECT pa.id, pa.slug, pa.nombre, pa.ubicacion, pa.ancho, pa.alto, pa.vnnox_player_ids, pa.activo,
           (SELECT count(*)::int FROM contenido.programas p WHERE p.pantalla_id=pa.id) AS n_programas,
           (SELECT p.nombre FROM contenido.programas p WHERE p.pantalla_id=pa.id AND p.activo LIMIT 1) AS programa_activo
    FROM contenido.pantallas pa ORDER BY pa.creado_en`);
  return rows;
}
async function crearPantalla(d) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.pantallas (slug, nombre, ubicacion, ancho, alto, vnnox_player_ids, activo)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [d.slug, d.nombre, d.ubicacion || null, d.ancho || null, d.alto || null, d.vnnox_player_ids || [], d.activo !== false]);
  _pantallaAt = 0;
  return r.id;
}
async function actualizarPantalla(id, d) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.pantallas SET nombre=$2, ubicacion=$3, ancho=$4, alto=$5, vnnox_player_ids=$6, activo=$7 WHERE id=$1`,
    [id, d.nombre, d.ubicacion || null, d.ancho || null, d.alto || null, d.vnnox_player_ids || [], d.activo !== false]);
  _pantallaAt = 0;
  return rowCount > 0;
}
async function eliminarPantalla(id) {
  const { rows: [c] } = await pool.query(`SELECT count(*)::int AS n FROM contenido.programas WHERE pantalla_id=$1`, [id]);
  if (c.n > 0) return { ok: false, error: 'tiene_programas', n: c.n };
  const { rowCount } = await pool.query(`DELETE FROM contenido.pantallas WHERE id=$1`, [id]);
  _pantallaAt = 0;
  return { ok: rowCount > 0 };
}

// Avisos aprobados de TODOS los proyectos (con su marca) para armar el mix de la pantalla.
async function getAvisosAprobados() {
  const { rows } = await pool.query(`
    SELECT pz.id, pz.numero, pz.titulo_interno, r.duracion_s, r.momento, ${_avisoMedia} AS media,
           p.slug AS marca_slug, p.nombre AS marca_nombre
    FROM contenido.piezas pz
      JOIN contenido.revisiones r ON r.id = pz.revision_vigente
      JOIN contenido.proyectos p ON p.id = pz.proyecto_id
    WHERE pz.canal='aviso' AND pz.estado='publicada'
    ORDER BY pz.numero DESC`);
  return rows;
}

async function getProgramas(pantallaId) {
  const { rows } = await pool.query(`
    SELECT p.id, p.nombre, p.activo, p.actualizado_en,
           (SELECT count(*)::int FROM contenido.programa_items i WHERE i.programa_id=p.id) AS n_items
    FROM contenido.programas p WHERE p.pantalla_id=$1 ORDER BY p.activo DESC, p.actualizado_en DESC`, [pantallaId]);
  return rows;
}

async function getPrograma(id, pantallaId) {
  const { rows: [p] } = await pool.query(`SELECT id, nombre, activo FROM contenido.programas WHERE id=$1 AND pantalla_id=$2`, [id, pantallaId]);
  if (!p) return null;
  const { rows: items } = await pool.query(`
    SELECT i.orden, pz.id AS pieza_id, pz.numero, pz.titulo_interno, r.duracion_s, ${_avisoMedia} AS media,
           pr.slug AS marca_slug, pr.nombre AS marca_nombre
    FROM contenido.programa_items i
      JOIN contenido.piezas pz ON pz.id=i.pieza_id
      JOIN contenido.revisiones r ON r.id=pz.revision_vigente
      JOIN contenido.proyectos pr ON pr.id=pz.proyecto_id
    WHERE i.programa_id=$1 ORDER BY i.orden`, [id]);
  p.items = items;
  return p;
}

async function crearPrograma(nombre, pantallaId) {
  const { rows: [r] } = await pool.query(`INSERT INTO contenido.programas (nombre, pantalla_id) VALUES ($1,$2) RETURNING id`, [nombre || 'Programa', pantallaId]);
  return r.id;
}

async function guardarPrograma(id, nombre, piezaIds, pantallaId) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // Verifica que el programa sea de ESTA pantalla antes de tocarlo.
    const { rowCount: own } = await cli.query('SELECT 1 FROM contenido.programas WHERE id=$1 AND pantalla_id=$2', [id, pantallaId]);
    if (!own) { await cli.query('ROLLBACK'); return false; }
    if (nombre != null) await cli.query('UPDATE contenido.programas SET nombre=$2 WHERE id=$1', [id, nombre]);
    await cli.query('DELETE FROM contenido.programa_items WHERE programa_id=$1', [id]);
    for (let k = 0; k < piezaIds.length; k++)
      await cli.query('INSERT INTO contenido.programa_items (programa_id, orden, pieza_id) VALUES ($1,$2,$3)', [id, k, piezaIds[k]]);
    await cli.query('UPDATE contenido.programas SET actualizado_en=now() WHERE id=$1', [id]);
    await cli.query('COMMIT');
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
  return true;
}

async function activarPrograma(id, pantallaId) {
  // Un solo programa activo por pantalla (desactiva los otros de la MISMA pantalla).
  const { rowCount } = await pool.query(
    `UPDATE contenido.programas SET activo=(id=$1), actualizado_en=now()
       WHERE pantalla_id=$2 AND (activo OR id=$1)`, [id, pantallaId]);
  return rowCount > 0;
}

async function eliminarPrograma(id, pantallaId) {
  const { rowCount } = await pool.query(`DELETE FROM contenido.programas WHERE id=$1 AND pantalla_id=$2`, [id, pantallaId]);
  return rowCount > 0;
}

// Playlist del programa ACTIVO de una pantalla (la consume el player). Mezcla avisos de varios proyectos.
async function getActivoPlaylist(pantallaId) {
  const { rows: [p] } = await pool.query(`SELECT id, nombre, actualizado_en FROM contenido.programas WHERE activo AND pantalla_id=$1 LIMIT 1`, [pantallaId]);
  if (!p) return { version: 'none', nombre: null, items: [] };
  const { rows: items } = await pool.query(`
    SELECT (SELECT m.url FROM contenido.media m WHERE m.pieza_id=pz.id AND m.orden=1) AS url,
           (SELECT m.poster_url FROM contenido.media m WHERE m.pieza_id=pz.id AND m.orden=1) AS poster,
           r.duracion_s AS dur
    FROM contenido.programa_items i JOIN contenido.piezas pz ON pz.id=i.pieza_id JOIN contenido.revisiones r ON r.id=pz.revision_vigente
    WHERE i.programa_id=$1 ORDER BY i.orden`, [p.id]);
  return { version: p.id + ':' + new Date(p.actualizado_en).getTime(), nombre: p.nombre, items: items.filter(x => x.url) };
}

// Programa ACTIVO de una pantalla, con sus avisos (para el tablero Audiovisual).
async function getProgramaActivo(pantallaId) {
  const { rows: [p] } = await pool.query(
    `SELECT id, nombre FROM contenido.programas WHERE activo AND pantalla_id=$1 LIMIT 1`, [pantallaId]);
  if (!p) return null;
  const { rows: items } = await pool.query(`
    SELECT i.orden, pz.numero, pz.titulo_interno, r.duracion_s, ${_avisoMedia} AS media, pr.slug AS marca_slug, pr.nombre AS marca_nombre
    FROM contenido.programa_items i
      JOIN contenido.piezas pz ON pz.id=i.pieza_id
      JOIN contenido.revisiones r ON r.id=pz.revision_vigente
      JOIN contenido.proyectos pr ON pr.id=pz.proyecto_id
    WHERE i.programa_id=$1 ORDER BY i.orden`, [p.id]);
  return { id: p.id, nombre: p.nombre, items };
}

// --- Landings: requerimientos de cambio de landing (borrador -> preview -> aprobación -> producción) ---
async function getLandingCambios(proyectoId) {
  const { rows } = await pool.query(
    `SELECT id, requerimiento, estado, preview_url, commit_sha, resumen, motivo_rechazo, creado_en, actualizado_en
       FROM contenido.landing_cambios WHERE proyecto_id=$1 ORDER BY creado_en DESC LIMIT 30`, [proyectoId]);
  return rows;
}
async function crearLandingCambio(proyectoId, requerimiento) {
  const r = (requerimiento || '').trim();
  if (!r) return null;
  const { rows: [row] } = await pool.query(
    `INSERT INTO contenido.landing_cambios (proyecto_id, requerimiento) VALUES ($1,$2) RETURNING id`, [proyectoId, r]);
  return row.id;
}
// Aprobar: solo si es un borrador de ESTE proyecto -> 'aprobada' (el motor hace el merge a producción).
async function aprobarLanding(proyectoId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.landing_cambios SET estado='aprobada', actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado='borrador'`, [id, proyectoId]);
  return rowCount > 0;
}
// Rechazar: agrega el motivo al requerimiento y vuelve a 'pendiente' -> el motor regenera el borrador.
async function rechazarLanding(proyectoId, id, motivo) {
  const m = (motivo || '').trim();
  const { rowCount } = await pool.query(
    `UPDATE contenido.landing_cambios
        SET requerimiento = requerimiento || E'\n\nCorrección pedida: ' || $3,
            motivo_rechazo = $3, estado='pendiente', branch=NULL, preview_url=NULL, actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado='borrador'`, [id, proyectoId, m || 'ajustes']);
  return rowCount > 0;
}

// --- Auditoría de presencia digital (snapshot más reciente por proyecto/canal) ---
async function getAuditoria(proyectoId, canal) {
  const { rows: [r] } = await pool.query(
    `SELECT canal, periodo, kpis, recomendaciones, creada_en FROM contenido.auditorias
      WHERE proyecto_id=$1 AND canal=$2 ORDER BY creada_en DESC LIMIT 1`, [proyectoId, canal || 'instagram']);
  return r || null;
}

async function health() {
  await pool.query('SELECT 1');
  return true;
}

module.exports = { getMarcas, getProyectoId, getPerfil, guardarPerfil, setLogo, getResumenAgencia,
  getPiezas, getPiezaCanal, avisoEstado, getRequerimientos, getBriefMedia, getStatus, getTokenPendiente,
  pedirPropuestas, addMaterial, getMateriales, getMaterialFile, delMaterial,
  addMaterialPorPieza, getMaterialesPorPieza, delMaterialPorPieza, generarReq, activarReq, descartarReq, insertMencion,
  getPostIdsPublicados, upsertMetricas,
  getPantallaActiva, getPantallaPorSlug, getPantallas, crearPantalla, actualizarPantalla, eliminarPantalla, getProgramaActivo,
  getAvisosAprobados, getProgramas, getPrograma, crearPrograma, guardarPrograma, activarPrograma, eliminarPrograma, getActivoPlaylist,
  getLandingCambios, crearLandingCambio, aprobarLanding, rechazarLanding,
  getAuditoria,
  health };
