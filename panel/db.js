// Capa de datos del panel — TODA la SQL vive acá (aislada para portar fácil a FastAPI a futuro).
// Lectura sobre el schema `contenido` (base `claude`). Conexión por variables de entorno PG*.
const { Pool } = require('pg');
const cryptoAds = require('./crypto_ads');

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
            pp.slogan, pp.logo, pp.brief_md, pp.estilo_md, pp.actualizado_en,
            pp.meta_ads_account_id, pp.meta_ads_page_id, pp.meta_ads_ig_id,
            (pp.meta_ads_token_enc IS NOT NULL) AS meta_ads_token_set,
            (pp.ig_token_enc IS NOT NULL) AS ig_token_set
       FROM contenido.proyectos p LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
      WHERE p.id=$1`, [proyectoId]);
  return r || {};
}

// --- Capacidades por marca ---------------------------------------------------------------
// No toda marca usa toda la plataforma. Estado = flag explícito (habilitada) + configuración
// VERIFICADA contra la config real (no se guarda, así el flag no puede mentir).
// Siempre activas (no son capacidades): identidad, brief, biblioteca.
const CAPS = [
  { id: 'estilo',    label: 'Estilo de marca',    icon: 'palette',           href: 'estilo',    desc: 'Sistema de diseño e identidad visual' },
  { id: 'instagram', label: 'Instagram',          icon: 'instagram',         href: 'instagram', desc: 'Publicaciones del feed' },
  { id: 'pauta',     label: 'Pauta Instagram',    icon: 'badge-dollar-sign', href: 'pauta',     desc: 'Publicidad y pauta (Meta Ads)', depende: ['instagram'] },
  { id: 'pantalla',  label: 'Avisos en pantalla', icon: 'megaphone',         href: 'avisos',    desc: 'Avisos para la pantalla de calle' },
  { id: 'web',       label: 'Web / Landing',      icon: 'globe',             href: 'landing',   desc: 'Sitio de la marca' },
];

function evaluarCap(cap, d, cfg) {
  const faltan = [];
  if (cap.id === 'estilo') {
    if ((d.estilo_md || '').length <= 20) faltan.push('sistema de diseño');
  } else if (cap.id === 'instagram') {
    if (!d.ig_handle) faltan.push('cuenta @');
    if (!d.ig_user_id) faltan.push('IG user id');
    if (!d.ig_token_enc) faltan.push('token de Instagram');
  } else if (cap.id === 'pauta') {
    if (!d.meta_ads_account_id) faltan.push('ad account id');
    if (!d.meta_ads_page_id) faltan.push('page id');
    if (!d.meta_ads_ig_id) faltan.push('IG account id (ads)');
    if (!d.meta_ads_token_enc) faltan.push('token de Meta Ads');
  } else if (cap.id === 'web') {
    if (!d.dominio_web) faltan.push('dominio');
    if (!cfg.modo) faltan.push('modo (administrada o referencia)');
  }
  // 'pantalla' no requiere config extra: la pantalla es un recurso del sistema.
  return { configurada: faltan.length === 0, faltan };
}

async function getCapacidades(proyectoId) {
  const { rows: [d] } = await pool.query(
    `SELECT p.ig_handle, p.ig_user_id, p.dominio_web, pp.estilo_md, pp.ig_token_enc,
            pp.meta_ads_account_id, pp.meta_ads_page_id, pp.meta_ads_ig_id, pp.meta_ads_token_enc
       FROM contenido.proyectos p LEFT JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id
      WHERE p.id=$1`, [proyectoId]);
  const { rows } = await pool.query(
    'SELECT capacidad, habilitada, config FROM contenido.proyecto_capacidad WHERE proyecto_id=$1', [proyectoId]);
  const byId = {}; rows.forEach(r => { byId[r.capacidad] = r; });
  return CAPS.map(c => {
    const fila = byId[c.id] || { habilitada: false, config: {} };
    const cfg = fila.config || {};
    const ev = evaluarCap(c, d || {}, cfg);
    return { id: c.id, label: c.label, icon: c.icon, href: c.href, desc: c.desc,
             depende: c.depende || [], habilitada: !!fila.habilitada, config: cfg, ...ev };
  });
}

// Contactos de la marca (dueño, community manager, pauta…). A quién escribirle, y a futuro
// a quién notificarle cuando su aviso sale en pantalla.
async function getContactos(proyectoId) {
  const { rows } = await pool.query(
    'SELECT id, nombre, rol, whatsapp, email, notas FROM contenido.proyecto_contacto ' +
    'WHERE proyecto_id=$1 ORDER BY orden, creado_en', [proyectoId]);
  return rows;
}

// Guardado por reemplazo: la UI manda la lista completa (es corta y se edita como un bloque).
async function guardarContactos(proyectoId, lista) {
  const items = (Array.isArray(lista) ? lista : [])
    .map(c => ({
      nombre: String(c.nombre || '').trim().slice(0, 120),
      rol: String(c.rol || '').trim().slice(0, 60) || null,
      whatsapp: String(c.whatsapp || '').trim().slice(0, 40) || null,
      email: String(c.email || '').trim().slice(0, 160) || null,
      notas: String(c.notas || '').trim().slice(0, 300) || null,
    }))
    .filter(c => c.nombre);   // sin nombre no es un contacto
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query('DELETE FROM contenido.proyecto_contacto WHERE proyecto_id=$1', [proyectoId]);
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      await cli.query(
        `INSERT INTO contenido.proyecto_contacto (proyecto_id, nombre, rol, whatsapp, email, notas, orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [proyectoId, c.nombre, c.rol, c.whatsapp, c.email, c.notas, i]);
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally {
    cli.release();
  }
  return { ok: true, contactos: await getContactos(proyectoId) };
}

// Aviso cargado A MANO (no lo hizo el creativo): material ya listo, de la biblioteca o de disco.
// Entra por la MISMA puerta que los del creativo: nace 'pendiente_aprobacion'. Nada va a la
// pantalla sin el visto de Fer.
async function crearAvisoManual(proyectoId, d) {
  const titulo = String(d.titulo || '').trim().slice(0, 160);
  const url = String(d.url || '').trim();
  if (!titulo) return { ok: false, error: 'titulo_requerido' };
  if (!url) return { ok: false, error: 'media_requerida' };
  const tipo = d.tipo === 'video' ? 'video' : 'image';
  const dur = Math.max(1, Math.min(120, parseInt(d.duracion_s, 10) || 10));
  const momento = String(d.momento || '').trim().slice(0, 80) || null;

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [pz] } = await cli.query(
      `INSERT INTO contenido.piezas (proyecto_id, titulo_interno, canal, estado, notas)
         VALUES ($1,$2,'aviso','pendiente_aprobacion',$3) RETURNING id, numero`,
      [proyectoId, titulo, 'Cargado a mano (material ya listo).']);
    const { rows: [rv] } = await cli.query(
      `INSERT INTO contenido.revisiones (pieza_id, nro, estado, canal, duracion_s, momento)
         VALUES ($1, 1, 'pendiente_aprobacion', 'instagram', $2, $3) RETURNING id`,
      [pz.id, dur, momento]);
    await cli.query(
      `INSERT INTO contenido.media (pieza_id, orden, tipo, url, poster_url) VALUES ($1,1,$2,$3,$4)`,
      [pz.id, tipo, url, d.poster_url || null]);
    await cli.query('UPDATE contenido.piezas SET revision_vigente=$1 WHERE id=$2', [rv.id, pz.id]);
    await cli.query('COMMIT');
    return { ok: true, id: pz.id, numero: pz.numero };
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally {
    cli.release();
  }
}

// Config de plataforma: lo transversal a todas las marcas (hoy, la lente de Instagram).
// Mismo criterio que los tokens de marca: cifrado en la DB, write-only hacia el navegador.
async function getLente() {
  const { rows } = await pool.query(
    "SELECT clave, valor, (valor_enc IS NOT NULL) AS seteado FROM contenido.plataforma_config " +
    "WHERE clave IN ('ig_lente_id','ig_lente_token')");
  const id = rows.find(r => r.clave === 'ig_lente_id');
  const tk = rows.find(r => r.clave === 'ig_lente_token');
  return { ig_lente_id: (id && id.valor) || '', token_set: !!(tk && tk.seteado) };
}

async function getLenteToken() {
  const { rows } = await pool.query(
    "SELECT valor_enc FROM contenido.plataforma_config WHERE clave='ig_lente_token'");
  if (!rows[0] || !rows[0].valor_enc) return null;
  return cryptoAds.decrypt(rows[0].valor_enc);
}

async function guardarLente(d) {
  const id = (d.ig_lente_id || '').trim();
  const tok = (d.token || '').trim();
  // Ciframos ANTES de escribir nada: si falta la clave, no dejamos la config a medias.
  let enc = null;
  if (tok) {
    if (!cryptoAds.hasKey()) return { ok: false, error: 'no_enc_key' };
    enc = cryptoAds.encrypt(tok);
  }
  await pool.query(
    "UPDATE contenido.plataforma_config SET valor=$1, actualizado_en=now() WHERE clave='ig_lente_id'",
    [id || null]);
  if (enc) {
    await pool.query(
      "UPDATE contenido.plataforma_config SET valor_enc=$1, actualizado_en=now() WHERE clave='ig_lente_token'",
      [enc]);
  }
  return { ok: true, ...(await getLente()) };
}

// Descubrimiento: el analista lee la presencia digital pública (web + IG) y devuelve una base de
// identidad para pre-cargar el wizard. Corre antes de que la marca exista -> cuelga de su propia
// tabla, no de proyecto_id (se enlaza después, si el alta se concreta).
async function crearDescubrimiento(d) {
  const web = (d.web || '').trim();
  const ig = (d.instagram || '').trim();
  if (!web && !ig) return { ok: false, error: 'sin_fuentes' };
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.marca_descubrimiento (nombre, web, instagram, notas)
       VALUES ($1,$2,$3,$4) RETURNING id`,
    [(d.nombre || '').trim() || null, web || null, ig || null, (d.notas || '').trim() || null]);
  return { ok: true, id: r.id };
}

async function getDescubrimiento(id) {
  const { rows } = await pool.query(
    'SELECT id, estado, resultado, error FROM contenido.marca_descubrimiento WHERE id=$1', [id]);
  return rows[0] || null;
}

// Alta de marca desde el panel (wizard). Crea proyecto + perfil + capacidades y ENCOLA el
// scaffold de la cápsula (artefacto derivado de la DB). No toca el disco directamente.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
async function crearMarca(d) {
  const nombre = (d.nombre || '').trim();
  const slug = (d.slug || '').trim().toLowerCase();
  if (!nombre) return { ok: false, error: 'nombre_requerido' };
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'slug_invalido' };
  const dup = await pool.query('SELECT 1 FROM contenido.proyectos WHERE slug=$1', [slug]);
  if (dup.rowCount) return { ok: false, error: 'slug_duplicado' };
  // Capacidades elegidas + sus dependencias (pauta arrastra instagram).
  const set = new Set(Array.isArray(d.capacidades) ? d.capacidades : []);
  CAPS.forEach(c => { if (set.has(c.id)) (c.depende || []).forEach(x => set.add(x)); });
  const txt = v => ((v || '').trim() || null);

  const { rows: [p] } = await pool.query(
    `INSERT INTO contenido.proyectos (slug, nombre, dominio_web, ig_handle, email, whatsapp)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [slug, nombre, txt(d.dominio_web), txt(d.ig_handle), txt(d.email), txt(d.whatsapp)]);
  await pool.query(
    `INSERT INTO contenido.proyecto_perfil (proyecto_id, slogan, brief_md, estilo_md, logo, actualizado_en)
       VALUES ($1,$2,$3,$4,$5, now())`,
    [p.id, txt(d.slogan), txt(d.brief_md), txt(d.estilo_md), txt(d.logo)]);
  // Trazabilidad: de qué análisis salió esta marca.
  if (d.descubrimiento_id) {
    await pool.query('UPDATE contenido.marca_descubrimiento SET proyecto_id=$1 WHERE id=$2',
      [p.id, d.descubrimiento_id]).catch(() => {});
  }
  for (const cap of CAPS) {
    const on = set.has(cap.id);
    const config = (cap.id === 'web' && on) ? { modo: (d.web_modo === 'administrada' ? 'administrada' : 'referencia') } : {};
    await pool.query(
      `INSERT INTO contenido.proyecto_capacidad (proyecto_id, capacidad, habilitada, config)
         VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
      [p.id, cap.id, on, JSON.stringify(config)]);
  }
  await pool.query("INSERT INTO contenido.marca_capsula_req (slug, accion) VALUES ($1,'scaffold')", [slug]);
  _marcasAt = 0;
  return { ok: true, slug };
}

// Vista de agencia: todas las marcas con el estado de cada capacidad (grilla marca × capacidad).
async function getCapacidadesTodas() {
  const marcas = await getMarcas();
  const out = [];
  for (const m of marcas) {
    out.push({ slug: m.slug, nombre: m.nombre, logo: m.logo, activo: m.activo,
               capacidades: await getCapacidades(m.id) });
  }
  return out;
}

async function setCapacidad(proyectoId, capId, { habilitada, config }) {
  const cap = CAPS.find(c => c.id === capId);
  if (!cap) return { ok: false, error: 'capacidad_desconocida' };
  if (habilitada && (cap.depende || []).length) {
    const { rows } = await pool.query(
      'SELECT capacidad FROM contenido.proyecto_capacidad WHERE proyecto_id=$1 AND habilitada', [proyectoId]);
    const on = new Set(rows.map(r => r.capacidad));
    const falta = cap.depende.filter(x => !on.has(x));
    if (falta.length) return { ok: false, error: 'depende', depende: falta };
  }
  await pool.query(
    `INSERT INTO contenido.proyecto_capacidad (proyecto_id, capacidad, habilitada, config, actualizado_en)
       VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb), now())
     ON CONFLICT (proyecto_id, capacidad) DO UPDATE SET habilitada=$3,
       config = CASE WHEN $4 IS NULL THEN contenido.proyecto_capacidad.config ELSE $4::jsonb END,
       actualizado_en = now()`,
    [proyectoId, capId, !!habilitada, config ? JSON.stringify(config) : null]);
  // Cascada: apagar una capacidad apaga las que dependen de ella.
  if (!habilitada) {
    const dependientes = CAPS.filter(c => (c.depende || []).includes(capId)).map(c => c.id);
    if (dependientes.length) {
      await pool.query(
        `UPDATE contenido.proyecto_capacidad SET habilitada=false, actualizado_en=now()
          WHERE proyecto_id=$1 AND capacidad = ANY($2::text[])`, [proyectoId, dependientes]);
    }
  }
  return { ok: true };
}

// Token de IG de una marca desde el perfil (descifrado), o null. Lo usa el panel (menciones/métricas).
async function getIgToken(slug) {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT pp.ig_token_enc FROM contenido.proyectos p JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id WHERE p.slug=$1`, [slug]);
    if (r && r.ig_token_enc) return cryptoAds.decrypt(r.ig_token_enc);
  } catch (e) { console.error('getIgToken', e.message); }
  return null;
}
async function guardarPerfil(proyectoId, d) {
  const nn = s => (s != null && String(s).trim() !== '') ? String(s).trim() : null;
  // Cifrar los tokens ANTES de escribir nada (si falta la clave, falla limpio sin guardar a medias).
  let tokEnc = null, igTokEnc = null;
  if (nn(d.meta_ads_token) || nn(d.ig_token)) {
    if (!cryptoAds.hasKey()) { const e = new Error('APP_ENC_KEY no configurada en el panel'); e.code = 'no_enc_key'; throw e; }
    if (nn(d.meta_ads_token)) tokEnc = cryptoAds.encrypt(nn(d.meta_ads_token));
    if (nn(d.ig_token)) igTokEnc = cryptoAds.encrypt(nn(d.ig_token));
  }
  if (nn(d.nombre)) await pool.query('UPDATE contenido.proyectos SET nombre=$2 WHERE id=$1', [proyectoId, nn(d.nombre)]);
  await pool.query(
    `UPDATE contenido.proyectos SET ig_handle=$2, dominio_web=$3, ig_user_id=$4, telegram_chat_id=$5, email=$6, whatsapp=$7 WHERE id=$1`,
    [proyectoId, nn(d.ig_handle), nn(d.dominio_web), nn(d.ig_user_id), nn(d.telegram_chat_id), nn(d.email), nn(d.whatsapp)]);
  await pool.query(`
    INSERT INTO contenido.proyecto_perfil (proyecto_id, slogan, logo, brief_md, estilo_md, actualizado_en)
    VALUES ($1,$2,$3,$4,$5, now())
    ON CONFLICT (proyecto_id) DO UPDATE SET slogan=$2, logo=$3, brief_md=$4, estilo_md=$5, actualizado_en=now()`,
    [proyectoId, nn(d.slogan), nn(d.logo), nn(d.brief_md), nn(d.estilo_md)]);
  // Pauta: IDs en claro (COALESCE: vacío = no toca); token cifrado, write-only.
  await pool.query(
    `UPDATE contenido.proyecto_perfil SET
       meta_ads_account_id = COALESCE($2, meta_ads_account_id),
       meta_ads_page_id    = COALESCE($3, meta_ads_page_id),
       meta_ads_ig_id      = COALESCE($4, meta_ads_ig_id)
     WHERE proyecto_id=$1`,
    [proyectoId, nn(d.meta_ads_account_id), nn(d.meta_ads_page_id), nn(d.meta_ads_ig_id)]);
  if (tokEnc) await pool.query('UPDATE contenido.proyecto_perfil SET meta_ads_token_enc=$2 WHERE proyecto_id=$1', [proyectoId, tokEnc]);
  if (igTokEnc) {
    await pool.query('UPDATE contenido.proyecto_perfil SET ig_token_enc=$2 WHERE proyecto_id=$1', [proyectoId, igTokEnc]);
    // La DB es la fuente de verdad: pedimos regenerar los secretos derivados (credencial de n8n).
    await pool.query('INSERT INTO contenido.secrets_sync_req (slug) SELECT slug FROM contenido.proyectos WHERE id=$1', [proyectoId]);
  }
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
           COALESCE(r.colaboradores, (SELECT ig_colaboradores FROM contenido.proyectos WHERE id=pz.proyecto_id)) AS colaboradores,
           (r.bitacora IS NOT NULL) AS tiene_bitacora,
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
    -- Sólo requerimientos que esperan algo (sin pieza generada aún). Una vez que generaron su
    -- pieza, ésta vive en el board de Instagram/aprobación, así que salen de la cola.
    WHERE b.proyecto_id = $1
      AND b.pieza_id IS NULL
      AND b.estado IN ('propuesta','pendiente','procesando','error','revisar','revisando')
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
async function pedirPropuestas(enfasis, canal, cantidad, proyectoId, material) {
  const n = Math.min(8, Math.max(1, parseInt(cantidad, 10) || 5));
  const { rows: [s] } = await pool.query(
    `INSERT INTO contenido.solicitudes_propuesta (enfasis, canal, cantidad, proyecto_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [enfasis || null, canal === 'aviso' ? 'aviso' : 'instagram', n, proyectoId]);
  const mats = Array.isArray(material) ? material.slice(0, 10) : [];
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i];
    if (!m || !m.media_path) continue;
    await pool.query(
      `INSERT INTO contenido.solicitud_propuesta_material (solicitud_id, media_path, media_type, filename, orden)
         VALUES ($1,$2,$3,$4,$5)`,
      [s.id, String(m.media_path).replace(/^\/?(media\/)?/, ''), m.media_type === 'video' ? 'video' : 'photo', (m.filename || '').slice(0, 120) || null, i]);
  }
  return true;
}

// Agrega un material (file_id de Telegram) a la galería del requerimiento. NO cambia el estado:
// el requerimiento sigue como 'propuesta' hasta que Fer aprieta "Generar publicación".
async function addMaterial(briefId, mediaPath, mediaType, filename) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.brief_material (brief_id, media_path, media_type, filename, orden)
       SELECT $1, $2, $3, $4, COALESCE((SELECT max(orden)+1 FROM contenido.brief_material WHERE brief_id=$1), 0)
       WHERE EXISTS (SELECT 1 FROM contenido.tg_briefs WHERE id=$1 AND estado IN ('propuesta','error'))
     RETURNING id, media_type, filename, orden`, [briefId, mediaPath, mediaType, filename || null]);
  return rows[0] || null;
}

// Lista los materiales aportados a un requerimiento (para la galería del modal).
async function getMateriales(briefId) {
  const { rows } = await pool.query(
    `SELECT id, media_type, filename, orden FROM contenido.brief_material
      WHERE brief_id=$1 ORDER BY orden, creado_en`, [briefId]);
  return rows;
}

// Origen de un material puntual (para el proxy de miniatura): media_path (disco) o file_id (Telegram legacy).
async function getMaterialFile(mid) {
  const { rows } = await pool.query(
    `SELECT file_id AS media_file_id, media_type, media_path FROM contenido.brief_material WHERE id=$1`, [mid]);
  return rows[0] || null;
}

// Quita un material de la galería (antes de generar).
async function delMaterial(briefId, mid) {
  const { rows } = await pool.query(
    `DELETE FROM contenido.brief_material WHERE id=$1 AND brief_id=$2 RETURNING media_path`, [mid, briefId]);
  return rows[0] || null;   // { media_path } si borró (para limpiar el archivo), null si no
}

// --- Material aportado AL RECHAZAR una pieza ---
// Se adjunta a la galería del brief que generó la pieza (brief.pieza_id), para que la rutina de
// corrección lo descargue y lo use al reprocesar. Solo mientras la pieza está pendiente de aprobación
// (el panel sube el material ANTES de confirmar el rechazo).
async function addMaterialPorPieza(piezaId, mediaPath, mediaType, filename) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.brief_material (brief_id, media_path, media_type, filename, orden)
       SELECT b.id, $2, $3, $4, COALESCE((SELECT max(orden)+1 FROM contenido.brief_material WHERE brief_id=b.id), 0)
       FROM contenido.tg_briefs b
       JOIN contenido.piezas pz ON pz.id = b.pieza_id
       JOIN contenido.revisiones r ON r.id = pz.revision_vigente
       WHERE b.pieza_id = $1 AND r.estado = 'pendiente_aprobacion'
     RETURNING id, media_type, filename, orden`, [piezaId, mediaPath, mediaType, filename || null]);
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
  const { rows } = await pool.query(
    `DELETE FROM contenido.brief_material bm USING contenido.tg_briefs b
      WHERE bm.id = $2 AND bm.brief_id = b.id AND b.pieza_id = $1 RETURNING bm.media_path`, [mid, piezaId]);
  return rows[0] || null;
}

// "Generar publicación": guarda los comentarios y manda el requerimiento al circuito -> 'pendiente'.
async function generarReq(id, comentarios) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.tg_briefs SET comentarios=$2, estado='pendiente'
      WHERE id=$1 AND estado IN ('propuesta','error')`, [id, (comentarios || '').slice(0, 2000) || null]);
  return rowCount > 0;
}

// "Pedir nueva versión": guarda los comentarios y manda la propuesta a que el creativo
// REESCRIBA el concepto (loop de refinamiento) -> 'revisar'. NO genera la pieza.
async function revisarReq(id, comentarios) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.tg_briefs SET comentarios=$2, estado='revisar'
      WHERE id=$1 AND pieza_id IS NULL AND estado='propuesta'`, [id, (comentarios || '').slice(0, 2000) || null]);
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

// Sala de máquinas: pulso operativo del MOTOR (agnóstico de marca). Dos lecturas:
//  - pipeline: cuántas piezas hay en cada etapa del circuito, agregado de todas las marcas.
//  - procesos: el latido de los crons/workers (batch_runs) con su intervalo esperado, para saber
//    si cada proceso está al día o "sin latido" (atrasado respecto de intervalo_s).
async function getMaquinas() {
  const pipeline = (await pool.query(`
    SELECT
      ((SELECT count(*) FROM contenido.tg_briefs WHERE pieza_id IS NULL AND estado='propuesta')
        + (SELECT count(*) FROM contenido.solicitudes_propuesta WHERE estado IN ('pendiente','procesando')))::int AS propuestas,
      (SELECT count(*) FROM contenido.tg_briefs WHERE pieza_id IS NULL AND estado IN ('pendiente','procesando'))::int AS generando,
      (SELECT count(*) FROM contenido.tg_briefs WHERE pieza_id IS NULL AND estado IN ('revisar','revisando'))::int AS revisando,
      (SELECT count(*) FROM contenido.tg_briefs WHERE estado='error')::int AS errores,
      (SELECT count(*) FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente
         WHERE r.estado='pendiente_aprobacion')::int AS espera,
      (SELECT count(*) FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente
         WHERE r.estado='rechazada')::int AS correccion,
      (SELECT count(*) FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente
         WHERE r.estado='rechazada' AND r.nro>=5)::int AS escalado,
      (SELECT count(*) FROM contenido.piezas WHERE estado='publicada')::int AS publicado,
      (SELECT count(*) FROM contenido.piezas WHERE estado='publicada' AND actualizado_en::date = now()::date)::int AS publicado_hoy
  `)).rows[0];
  const procesos = (await pool.query(`
    SELECT proceso, last_msg, intervalo_s,
           EXTRACT(EPOCH FROM (now() - last_run))::int AS hace_s
    FROM contenido.batch_runs
    WHERE proceso IN ('worker','dispatcher','correccion','propuestas','ingesta_briefs')
    ORDER BY array_position(ARRAY['ingesta_briefs','propuestas','worker','dispatcher','correccion'], proceso);`)).rows;
  // Flujo de landing/web (contenido.landing_cambios): otra máquina del motor.
  const landing = (await pool.query(`
    SELECT
      count(*) FILTER (WHERE estado IN ('pendiente','procesando'))::int AS generando,
      count(*) FILTER (WHERE estado='borrador')::int AS borrador,
      count(*) FILTER (WHERE estado='aprobada')::int AS publicando,
      count(*) FILTER (WHERE estado='error')::int AS errores
    FROM contenido.landing_cambios`)).rows[0];
  return { pipeline, procesos, landing };
}

// Biblioteca de medios de la marca: piezas (de la base) + material aportado (media store).
async function getBiblioteca(proyectoId) {
  const piezas = (await pool.query(`
    SELECT m.url, m.tipo, m.poster_url, m.orden,
           pz.id AS pieza_id, pz.canal::text AS canal, pz.titulo_interno AS titulo,
           r.estado::text AS estado, COALESCE(r.publicado_en, pz.actualizado_en) AS fecha
      FROM contenido.media m
      JOIN contenido.piezas pz ON pz.id = m.pieza_id
      JOIN contenido.revisiones r ON r.id = pz.revision_vigente
     WHERE pz.proyecto_id = $1 AND r.estado <> 'descartada'
     ORDER BY COALESCE(r.publicado_en, pz.actualizado_en) DESC, m.orden`, [proyectoId])).rows;
  const material = (await pool.query(`
    SELECT bm.media_path, bm.media_type, bm.filename, bm.creado_en,
           CASE WHEN bm.media_path LIKE 'material/pieza/%' THEN 'de un rechazo' ELSE 'de una propuesta' END AS contexto
      FROM contenido.brief_material bm
      JOIN contenido.tg_briefs b ON b.id = bm.brief_id
     WHERE b.proyecto_id = $1 AND bm.media_path IS NOT NULL
     ORDER BY bm.creado_en DESC`, [proyectoId])).rows;
  const perfil = (await pool.query(`SELECT logo FROM contenido.proyecto_perfil WHERE proyecto_id = $1`, [proyectoId])).rows[0] || {};
  const items = (await pool.query(`
    SELECT id, codigo, media_path, tipo, nombre, carpeta, origen, resumen, creado_en
      FROM contenido.biblioteca_item WHERE proyecto_id = $1 ORDER BY creado_en DESC`, [proyectoId])).rows;
  const carpetas = (await pool.query(`
    SELECT nombre FROM contenido.biblioteca_carpeta WHERE proyecto_id = $1 ORDER BY orden, nombre`, [proyectoId])).rows.map(r => r.nombre);
  const trabajando = (await pool.query(`
    SELECT id, instruccion, estado, resumen, creado_en
      FROM contenido.solicitudes_biblioteca
     WHERE proyecto_id = $1 AND estado IN ('pendiente','procesando','error')
     ORDER BY creado_en DESC LIMIT 40`, [proyectoId])).rows;
  return { piezas, material, logo: perfil.logo || null, items, carpetas, trabajando };
}

// Garantiza las carpetas de taller por defecto para un proyecto.
async function ensureCarpetasBiblioteca(proyectoId) {
  await pool.query(
    `INSERT INTO contenido.biblioteca_carpeta (proyecto_id, nombre, orden)
     VALUES ($1,'En proceso',10),($1,'Terminado',20)
     ON CONFLICT (proyecto_id, nombre) DO NOTHING`, [proyectoId]);
}
async function crearCarpetaBiblioteca(proyectoId, nombre) {
  await pool.query(
    `INSERT INTO contenido.biblioteca_carpeta (proyecto_id, nombre) VALUES ($1,$2)
     ON CONFLICT (proyecto_id, nombre) DO NOTHING`, [proyectoId, String(nombre).slice(0, 60)]);
  return true;
}
// Borra una carpeta solo si está vacía y no es una de las por defecto.
async function delCarpetaBiblioteca(proyectoId, nombre) {
  if (nombre === 'En proceso' || nombre === 'Terminado') return false;
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contenido.biblioteca_item WHERE proyecto_id=$1 AND carpeta=$2`, [proyectoId, nombre]);
  if (rows[0].n > 0) return false;
  await pool.query(`DELETE FROM contenido.biblioteca_carpeta WHERE proyecto_id=$1 AND nombre=$2`, [proyectoId, nombre]);
  return true;
}
async function crearItemBiblioteca(proyectoId, mediaPath, tipo, nombre, carpeta, origen) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.biblioteca_item (proyecto_id, media_path, tipo, nombre, carpeta, origen)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [proyectoId, mediaPath, tipo === 'video' ? 'video' : 'image', (nombre || '').slice(0, 120) || null, carpeta || 'En proceso', origen || 'subido']);
  return rows[0].id;
}
async function moverItemBiblioteca(proyectoId, id, carpeta) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.biblioteca_item SET carpeta=$3 WHERE id=$1 AND proyecto_id=$2`, [id, proyectoId, String(carpeta).slice(0, 60)]);
  return rowCount > 0;
}
async function delItemBiblioteca(proyectoId, id) {
  const { rows } = await pool.query(
    `DELETE FROM contenido.biblioteca_item WHERE id=$1 AND proyecto_id=$2 RETURNING media_path`, [id, proyectoId]);
  return rows[0] || null;
}

// Nueva solicitud al bibliotecario (crear/editar un asset). La toma el worker.
async function crearSolicitudBiblioteca(proyectoId, instruccion, origenUrl, origenTipo) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.solicitudes_biblioteca (proyecto_id, instruccion, origen_url, origen_tipo)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [proyectoId, String(instruccion).slice(0, 2000), origenUrl || null, origenTipo || null]);
  return rows[0].id;
}

// Borra una solicitud/asset del bibliotecario; devuelve resultado_path para limpiar el archivo.
async function delSolicitudBiblioteca(proyectoId, id) {
  const { rows } = await pool.query(
    `DELETE FROM contenido.solicitudes_biblioteca WHERE id=$1 AND proyecto_id=$2 RETURNING resultado_path`, [id, proyectoId]);
  return rows[0] || null;
}

// Bitácora de generación (relato de alto nivel) de la revisión vigente de una pieza.
async function getBitacora(piezaId) {
  const { rows } = await pool.query(
    `SELECT r.bitacora, pz.titulo_interno, r.nro
       FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id = pz.revision_vigente
      WHERE pz.id = $1`, [piezaId]);
  return rows[0] || null;
}

// Collaborators por-post (IG Collab): NULL=default de marca, {}=sin collab, {handles}=invitar. Los fija Fer al aprobar.
async function setColaboradores(piezaId, list) {
  const clean = [...new Set((Array.isArray(list) ? list : [])
    .map(h => String(h).trim().replace(/^@+/, '').toLowerCase()).filter(Boolean).slice(0, 20))];
  const { rowCount } = await pool.query(
    `UPDATE contenido.revisiones SET colaboradores=$2
       WHERE id=(SELECT revision_vigente FROM contenido.piezas WHERE id=$1) AND estado='pendiente_aprobacion'`,
    [piezaId, clean]);
  return rowCount > 0;
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

// --- Pauta (Meta Marketing API, read-only): último snapshot guardado por cf-pauta-sync ---
async function getPauta(proyectoId) {
  const { rows: [r] } = await pool.query(
    `SELECT capturado_en, data FROM contenido.ads_snapshot WHERE proyecto_id=$1`, [proyectoId]);
  if (!r) return { configurada: false };
  return { configurada: true, capturado_en: r.capturado_en, ...r.data };
}

// Serie diaria para el gráfico de evolución.
async function getPautaEvolucion(proyectoId) {
  const { rows } = await pool.query(
    `SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, gasto::float AS gasto,
            impresiones::int AS impresiones, alcance::int AS alcance, clics::int AS clics
       FROM contenido.ads_daily WHERE proyecto_id=$1 ORDER BY fecha`, [proyectoId]);
  return rows;
}

// Botón "Actualizar ahora": deja un pedido que el dispatcher consume y corre el sync.
async function pedirRefrescoPauta() {
  await pool.query(`INSERT INTO contenido.pauta_sync_req DEFAULT VALUES`);
  return true;
}

// --- Campañas de pauta: el creativo propone; Fer aprueba; se crean PAUSADAS en Meta ---
async function crearSolicitudCampania(proyectoId, instruccion) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.solicitudes_campania (proyecto_id, instruccion) VALUES ($1, $2) RETURNING id`,
    [proyectoId, (instruccion || '').slice(0, 2000) || null]);
  return r.id;
}

async function getCampanias(proyectoId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.estado, c.nombre, c.objetivo, c.pieza_id, c.razon, c.audiencia, c.presupuesto,
            c.fecha_inicio, c.fecha_fin, c.url_destino, c.cta, c.resumen,
            c.meta_campaign_id, c.creado_en, c.aprobado_en,
            pz.numero AS pieza_numero, r.ig_permalink AS pieza_permalink, r.caption AS pieza_caption,
            m.url AS pieza_url, m.poster_url AS pieza_poster, m.tipo AS pieza_tipo
       FROM contenido.campanias c
       LEFT JOIN contenido.piezas pz ON pz.id = c.pieza_id
       LEFT JOIN contenido.revisiones r ON r.pieza_id = c.pieza_id AND r.estado='publicada'
       LEFT JOIN contenido.media m ON m.pieza_id = c.pieza_id AND m.orden = 1
      WHERE c.proyecto_id = $1 AND c.estado <> 'descartada'
      ORDER BY c.creado_en DESC`, [proyectoId]);
  const { rows: [t] } = await pool.query(
    `SELECT count(*)::int AS n FROM contenido.solicitudes_campania
      WHERE proyecto_id=$1 AND estado IN ('pendiente','procesando')`, [proyectoId]);
  return { campanias: rows, trabajando: t ? t.n : 0 };
}

async function aprobarCampania(proyectoId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.campanias SET estado='aprobada', aprobado_en=now(), actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado='propuesta'`, [id, proyectoId]);
  return rowCount > 0;
}

async function rechazarCampania(proyectoId, id, motivo) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.campanias SET estado='rechazada', resumen=$3, actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado IN ('propuesta','aprobada')`,
    [id, proyectoId, (motivo || 'rechazada').slice(0, 2000)]);
  return rowCount > 0;
}

async function descartarCampania(proyectoId, id) {
  // Si ya existe en Meta, dejamos el pedido 'descartar' (el worker la borra allá y marca descartada).
  // Si no, se descarta directo.
  const { rowCount } = await pool.query(
    `UPDATE contenido.campanias
        SET estado = CASE WHEN meta_campaign_id IS NOT NULL THEN 'descartar' ELSE 'descartada' END,
            actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado NOT IN ('descartada','descartar')`, [id, proyectoId]);
  return rowCount > 0;
}

// Activar/pausar: el panel deja un pedido ('activar'/'pausar'); el worker lo aplica en Meta.
async function activarCampania(proyectoId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.campanias SET estado='activar', actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado='pausada' AND meta_campaign_id IS NOT NULL`, [id, proyectoId]);
  return rowCount > 0;
}
async function pausarCampania(proyectoId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.campanias SET estado='pausar', actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado='activa'`, [id, proyectoId]);
  return rowCount > 0;
}
// Posts ya publicados en IG que pueden usarse como creativo de una campaña.
async function getCreativosDisponibles(proyectoId) {
  const { rows } = await pool.query(
    `SELECT pz.id AS pieza_id, pz.numero, r.caption, r.ig_permalink AS permalink,
            m.url, m.poster_url, m.tipo
       FROM contenido.piezas pz
       JOIN contenido.revisiones r ON r.pieza_id = pz.id AND r.estado='publicada'
       JOIN contenido.media m ON m.pieza_id = pz.id AND m.orden = 1
      WHERE pz.proyecto_id = $1 AND pz.canal='instagram'
      ORDER BY pz.numero DESC LIMIT 40`, [proyectoId]);
  return rows;
}

// Cambiar el creativo (pieza) de una propuesta — sólo antes de crearse en Meta.
async function setCreativoCampania(proyectoId, id, piezaId) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.campanias SET pieza_id=$3, actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado='propuesta'
        AND EXISTS (SELECT 1 FROM contenido.piezas WHERE id=$3 AND proyecto_id=$2)`,
    [id, proyectoId, piezaId]);
  return rowCount > 0;
}

async function reintentarCampania(proyectoId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.campanias SET estado='aprobada', resumen=NULL, actualizado_en=now()
      WHERE id=$1 AND proyecto_id=$2 AND estado='error' AND meta_campaign_id IS NULL`, [id, proyectoId]);
  return rowCount > 0;
}

async function health() {
  await pool.query('SELECT 1');
  return true;
}

module.exports = { getMarcas, getProyectoId, getPerfil, getIgToken, guardarPerfil, setLogo, getResumenAgencia,
  getCapacidades, getCapacidadesTodas, setCapacidad, crearMarca,
  crearDescubrimiento, getDescubrimiento,
  getLente, getLenteToken, guardarLente,
  getContactos, guardarContactos, crearAvisoManual,
  getPiezas, getPiezaCanal, avisoEstado, setColaboradores, getRequerimientos, getBriefMedia, getStatus, getMaquinas, getTokenPendiente, getBitacora, getBiblioteca, crearSolicitudBiblioteca, delSolicitudBiblioteca,
  ensureCarpetasBiblioteca, crearCarpetaBiblioteca, delCarpetaBiblioteca, crearItemBiblioteca, moverItemBiblioteca, delItemBiblioteca,
  pedirPropuestas, addMaterial, getMateriales, getMaterialFile, delMaterial,
  addMaterialPorPieza, getMaterialesPorPieza, delMaterialPorPieza, generarReq, revisarReq, activarReq, descartarReq, insertMencion,
  getPostIdsPublicados, upsertMetricas,
  getPantallaActiva, getPantallaPorSlug, getPantallas, crearPantalla, actualizarPantalla, eliminarPantalla, getProgramaActivo,
  getAvisosAprobados, getProgramas, getPrograma, crearPrograma, guardarPrograma, activarPrograma, eliminarPrograma, getActivoPlaylist,
  getLandingCambios, crearLandingCambio, aprobarLanding, rechazarLanding,
  getAuditoria, getPauta, getPautaEvolucion, pedirRefrescoPauta,
  crearSolicitudCampania, getCampanias, aprobarCampania, rechazarCampania, descartarCampania,
  activarCampania, pausarCampania, reintentarCampania, getCreativosDisponibles, setCreativoCampania,
  health };
