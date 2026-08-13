// Capa de datos del panel — TODA la SQL vive acá (aislada para portar fácil a FastAPI a futuro).
// Lectura sobre el schema `contenido` (base `claude`). Conexión por variables de entorno PG*.
const { Pool } = require('pg');
const cryptoAds = require('./crypto_ads');
const tel = require('./telefono');
const inv = require('./invitaciones');

const pool = new Pool({
  host: process.env.PGHOST || 'crm_pgvector',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'claude',
  max: 4,
  idleTimeoutMillis: 30000,
});

// --- Usuarios y permisos ---
// El usuario llega con sus negocios ya resueltos: el middleware que valida la marca activa lo
// consulta en CADA request, así que hacerlo en dos consultas no tendría sentido.
const SQL_USUARIO = `
  SELECT u.id, u.email, u.nombre, u.password_hash, u.rol_plataforma,
         u.telegram_chat_id, u.whatsapp, u.activo,
         u.cargo, u.perfil_completado_en, u.invitado_en, u.ultimo_acceso_en, u.whatsapp_norm,
         COALESCE((SELECT json_agg(json_build_object('negocio_id', un.negocio_id, 'rol', un.rol, 'slug', n.slug))
                     FROM contenido.usuario_negocio un
                     JOIN contenido.negocios n ON n.id = un.negocio_id
                    WHERE un.usuario_id = u.id), '[]'::json) AS negocios
    FROM contenido.usuario u`;

async function getUsuarioPorEmail(email) {
  const { rows } = await pool.query(`${SQL_USUARIO} WHERE lower(u.email) = lower($1) AND u.activo`, [email]);
  return rows[0] || null;
}

async function getUsuario(id) {
  const { rows } = await pool.query(`${SQL_USUARIO} WHERE u.id = $1 AND u.activo`, [id]);
  return rows[0] || null;
}

async function getUsuarios() {
  const { rows } = await pool.query(
    `${SQL_USUARIO} ORDER BY u.rol_plataforma, lower(u.nombre)`);
  // El hash nunca sale del servidor.
  return rows.map(({ password_hash, ...u }) => u);
}

async function tocarAcceso(id) {
  await pool.query('UPDATE contenido.usuario SET ultimo_acceso_en = now() WHERE id = $1', [id]);
}

async function crearUsuario({ email, nombre, password_hash, rol_plataforma, telegram_chat_id, whatsapp }) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.usuario (email, nombre, password_hash, rol_plataforma, telegram_chat_id, whatsapp, whatsapp_norm)
     VALUES ($1, $2, $3, COALESCE($4,'usuario'), NULLIF($5,''), NULLIF($6,''), NULLIF($7,'')) RETURNING id`,
    [email, nombre, password_hash, rol_plataforma, telegram_chat_id || '', whatsapp || '',
     tel.normalizar(whatsapp || '')]);
  return rows[0].id;
}

/** Campos opcionales: los que vengan `undefined` no se tocan. La contraseña se pasa ya hasheada. */
async function actualizarUsuario(id, { nombre, rol_plataforma, telegram_chat_id, whatsapp, activo, password_hash }) {
  await pool.query(
    `UPDATE contenido.usuario SET
       nombre           = COALESCE($2, nombre),
       rol_plataforma   = COALESCE($3, rol_plataforma),
       telegram_chat_id = COALESCE($4, telegram_chat_id),
       whatsapp         = COALESCE($5, whatsapp),
       whatsapp_norm    = CASE WHEN $5 IS NULL THEN whatsapp_norm ELSE NULLIF($8,'') END,
       activo           = COALESCE($6, activo),
       password_hash    = COALESCE($7, password_hash)
     WHERE id = $1`,
    [id, nombre ?? null, rol_plataforma ?? null, telegram_chat_id ?? null,
     whatsapp ?? null, activo ?? null, password_hash ?? null,
     whatsapp == null ? null : tel.normalizar(whatsapp)]);
}

/** Lo que completa la propia persona en su primer ingreso. Marca el perfil como completo. */
async function completarPerfil(id, { nombre, whatsapp, cargo }) {
  await pool.query(
    `UPDATE contenido.usuario
        SET nombre = COALESCE(NULLIF($2,''), nombre),
            whatsapp = NULLIF($3,''),
            whatsapp_norm = NULLIF($5,''),
            cargo = NULLIF($4,''),
            perfil_completado_en = now()
      WHERE id = $1`,
    [id, nombre || '', whatsapp || '', cargo || '', tel.normalizar(whatsapp || '')]);
}

/** Registra un mensaje de WhatsApp. Best-effort: la bitácora nunca puede tumbar el webhook. */
async function logWhatsapp({ direccion, wa_id, usuario_id, mensaje_id, tipo, texto, crudo, estado, negocio_id, media_id, creado_en }) {
  try {
    await pool.query(
      `INSERT INTO contenido.whatsapp_mensaje
         (direccion, wa_id, usuario_id, mensaje_id, tipo, texto, crudo, estado, negocio_id, media_id, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [direccion, wa_id || null, usuario_id || null, mensaje_id || null,
       tipo || null, texto || null, crudo ? JSON.stringify(crudo) : null, estado || null,
       negocio_id || null, media_id || null, creado_en || null]);
    return true;
  } catch (e) { console.error('log whatsapp', e.message); return false; }
}

/**
 * La transcripción de una nota de voz, si ya la escribió el worker del host.
 * Se busca por el id de Meta y no por el de la fila porque el webhook atiende el mensaje ANTES
 * de guardarlo: cuando alguien necesita esperar la transcripción, todavía no hay id propio.
 */
async function transcripcionDe(mensajeId) {
  if (!mensajeId) return null;
  const { rows: [r] } = await pool.query(
    `SELECT texto FROM contenido.whatsapp_mensaje
      WHERE mensaje_id=$1 AND direccion='entrante' LIMIT 1`, [mensajeId]);
  return r && r.texto ? r.texto : null;
}

/** ¿Ya procesamos este mensaje? Meta reintenta si tardamos en responder. */
async function whatsappYaVisto(mensajeId) {
  if (!mensajeId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM contenido.whatsapp_mensaje WHERE mensaje_id=$1 AND direccion='entrante' LIMIT 1`,
    [mensajeId]);
  return rows.length > 0;
}

/**
 * ¿Ese número ya está cargado en otro usuario? Devuelve el email del dueño, o null.
 * `exceptoId` deja fuera al propio usuario para que pueda reguardar el suyo sin chocar.
 */
async function whatsappEnUso(numero, exceptoId) {
  const k = tel.clave(numero);
  if (!k) return null;
  const { rows } = await pool.query(
    `SELECT email FROM contenido.usuario
      WHERE right(whatsapp_norm, 10) = $1 AND ($2::uuid IS NULL OR id <> $2)`,
    [k, exceptoId || null]);
  return rows[0] ? rows[0].email : null;
}

/**
 * Busca por el número que llega de WhatsApp. Compara por los últimos 10 dígitos, así el con-9,
 * el sin-9 y el sin-código-de-país caen en el mismo casillero.
 *
 * Si el número está cargado en MÁS de un usuario devuelve null a propósito: preferimos no
 * autorizar antes que adivinar de quién es el mensaje.
 */
async function getUsuarioPorWhatsapp(numero) {
  const k = tel.clave(numero);
  if (!k) return null;
  const { rows } = await pool.query(
    `${SQL_USUARIO} WHERE right(u.whatsapp_norm, 10) = $1 AND u.activo`, [k]);
  if (rows.length !== 1) {
    if (rows.length > 1) console.error('whatsapp ambiguo:', k, '->', rows.map(r => r.email).join(', '));
    return null;
  }
  return rows[0];
}

/** Deja un token de un solo uso y devuelve cuándo vence. Pisa cualquiera anterior. */
async function guardarToken(id, hash, horas) {
  const { rows } = await pool.query(
    `UPDATE contenido.usuario SET token_hash=$2, token_expira=now() + ($3 || ' hours')::interval
      WHERE id=$1 RETURNING token_expira`, [id, hash, String(horas)]);
  return rows[0] && rows[0].token_expira;
}

/** Busca por token vigente. Devuelve null si no existe, venció, o el usuario está inactivo. */
async function getUsuarioPorToken(hash) {
  const { rows } = await pool.query(
    `${SQL_USUARIO} WHERE u.token_hash = $1 AND u.token_expira > now() AND u.activo`, [hash]);
  return rows[0] || null;
}

/** Un solo uso: al definir la contraseña, el token se quema. */
async function consumirToken(id, passwordHash) {
  await pool.query(
    `UPDATE contenido.usuario
        SET password_hash=$2, token_hash=NULL, token_expira=NULL,
            perfil_completado_en = COALESCE(perfil_completado_en, NULL)
      WHERE id=$1`, [id, passwordHash]);
}

async function marcarInvitado(id) {
  await pool.query('UPDATE contenido.usuario SET invitado_en = now() WHERE id = $1', [id]);
}

/** Reemplaza TODA la asignación de negocios del usuario. `negocios` = [{negocio_id, rol}]. */
async function setNegociosDeUsuario(usuarioId, negocios) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM contenido.usuario_negocio WHERE usuario_id = $1', [usuarioId]);
    for (const n of negocios || []) {
      await c.query(
        `INSERT INTO contenido.usuario_negocio (usuario_id, negocio_id, rol) VALUES ($1, $2, $3)`,
        [usuarioId, n.negocio_id, n.rol === 'editor' ? 'editor' : 'aprobador']);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK'); throw e;
  } finally {
    c.release();
  }
}

// --- Marcas (tenants) ---
// Cache en memoria de las marcas (proyectos): el panel resuelve la marca activa en cada request.
let _negocios = null, _negociosAt = 0;
async function getNegocios() {
  if (!_negocios || Date.now() - _negociosAt > 60000) {
    const { rows } = await pool.query(
      `SELECT p.id, p.slug, p.nombre, p.activo, p.gestion, p.prefijo, pp.logo
         FROM contenido.negocios p LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id=p.id
        ORDER BY p.activo DESC, p.creado_en`);
    _negocios = rows; _negociosAt = Date.now();
  }
  return _negocios;
}
async function getProyectoId(slug) {
  const f = (await getNegocios()).find(x => x.slug === slug);
  return f ? f.id : null;
}

// --- Perfil del proyecto (registro que consume el creativo): marca + slogan + logo + brief ---
async function getPerfil(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT p.nombre, p.ig_handle, p.ig_user_id, p.dominio_web, p.telegram_chat_id, p.email, p.whatsapp, p.gestion, p.prefijo,
            pp.slogan, pp.logo, pp.logo_claro, pp.brief_md, pp.estilo_md, pp.referencias_md, pp.actualizado_en,
            pp.meta_ads_account_id, pp.meta_ads_page_id, pp.meta_ads_ig_id,
            (pp.meta_ads_token_enc IS NOT NULL) AS meta_ads_token_set,
            (pp.ig_token_enc IS NOT NULL) AS ig_token_set
       FROM contenido.negocios p LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id=p.id
      WHERE p.id=$1`, [negocioId]);
  return r || {};
}

// --- Capacidades por marca ---------------------------------------------------------------
// No toda marca usa toda la plataforma. Estado = flag explícito (habilitada) + configuración
// VERIFICADA contra la config real (no se guarda, así el flag no puede mentir).
// Siempre activas (no son capacidades): identidad, brief, biblioteca.
// v2.0: cada capacidad pertenece a uno de los tres grupos (identidad / comunicacion / operacion).
// El grupo vive acá y no en la base a propósito: el catálogo ya tiene lógica asociada
// (evaluarCap, dependencias) y partirlo entre base y código lo empeoraría. Ver core/planes/V2.md.
const CAPS = [
  { id: 'estilo',    grupo: 'identidad',    label: 'Estilo de marca',    icon: 'palette',           href: 'identidad#estilo', desc: 'Sistema de diseño e identidad visual' },
  { id: 'instagram', grupo: 'comunicacion', label: 'Instagram',          icon: 'instagram',         href: 'instagram', desc: 'Publicaciones del feed' },
  { id: 'pauta',     grupo: 'comunicacion', label: 'Pauta Instagram',    icon: 'badge-dollar-sign', href: 'pauta',     desc: 'Publicidad y pauta (Meta Ads)', depende: ['instagram'] },
  { id: 'pantalla',  grupo: 'comunicacion', label: 'Avisos en pantalla', icon: 'megaphone',         href: 'avisos',    desc: 'Avisos para la pantalla de calle' },
  { id: 'web',       grupo: 'comunicacion', label: 'Web / Landing',      icon: 'globe',             href: 'landing',   desc: 'Sitio del negocio' },
  { id: 'whatsapp',  grupo: 'comunicacion', label: 'WhatsApp',            icon: 'message-circle',    href: 'whatsapp',  desc: 'Número propio del negocio para hablar con sus clientes' },
  { id: 'grafica',   grupo: 'comunicacion', label: 'Gráfica',            icon: 'layout-template',   href: 'grafica',   desc: 'Folletos, afiches y vía pública', depende: ['estilo'] },
  { id: 'clientes',  grupo: 'operacion',    label: 'Clientes',           icon: 'users-round',       href: 'clientes',  desc: 'Base de clientes del negocio' },
  { id: 'reservas',  grupo: 'operacion',    label: 'Reservas',           icon: 'calendar-check',    href: 'reservas',  desc: 'Turnos, disponibilidad y reservas', depende: ['clientes'] },
  { id: 'invitaciones', grupo: 'operacion', label: 'Invitaciones',       icon: 'ticket',            href: 'invitaciones', desc: 'Códigos con descuento para repartir', depende: ['reservas'] },
];
const GRUPOS_CAP = [
  { id: 'identidad',    label: 'Identidad',   desc: 'Quién es el negocio' },
  { id: 'comunicacion', label: 'Comunicación',desc: 'Cómo habla' },
  { id: 'operacion',    label: 'Operación',   desc: 'Qué puede hacer por un cliente' },
];

function evaluarCap(cap, d, cfg) {
  const faltan = [];
  if (cap.id === 'grafica') {
    if ((d.estilo_md || '').length <= 20) faltan.push('estilo de marca (define la identidad de las piezas)');
  } else if (cap.id === 'estilo') {
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
  } else if (cap.id === 'reservas') {
    if (!cfg.fuente_verdad) faltan.push('fuente de verdad (ClaUsina o sistema del negocio)');
    // Sin al menos un turno activo el módulo no puede aceptar nada: es config, no un detalle.
    if (!d.turnos_activos) faltan.push('al menos un turno activo');
  } else if (cap.id === 'whatsapp') {
    if (!d.wa_phone_id) faltan.push('id del número');
    // Sin el WABA no se pueden mirar las plantillas, que son por cuenta y no por número.
    if (!d.wa_waba_id) faltan.push('id de la cuenta (WABA)');
    if (!d.wa_token_enc) faltan.push('token');
  } else if (cap.id === 'invitaciones') {
    // Sin un beneficio cargado no hay nada que repartir: es configuración, no un detalle.
    if (!d.beneficios_activos) faltan.push('al menos un beneficio definido');
  } else if (cap.id === 'clientes') {
    // Decisión de Fer: la fuente de verdad se declara por capacidad y por negocio. Sin
    // declararla, ClaUsina podría terminar compitiendo con el sistema que el cliente ya usa.
    if (!cfg.fuente_verdad) faltan.push('fuente de verdad (ClaUsina o sistema del negocio)');
  }
  // 'pantalla' no requiere config extra: la pantalla es un recurso del sistema.
  return { configurada: faltan.length === 0, faltan };
}

async function getCapacidades(negocioId) {
  const { rows: [d] } = await pool.query(
    `SELECT p.ig_handle, p.ig_user_id, p.dominio_web, pp.estilo_md, pp.ig_token_enc,
            pp.meta_ads_account_id, pp.meta_ads_page_id, pp.meta_ads_ig_id, pp.meta_ads_token_enc,
            pp.wa_phone_id, pp.wa_waba_id, pp.wa_token_enc,
            (SELECT count(*) FROM contenido.turno t WHERE t.negocio_id=p.id AND t.activo)::int AS turnos_activos,
            (SELECT count(*) FROM contenido.beneficio b WHERE b.negocio_id=p.id AND b.activo)::int AS beneficios_activos
       FROM contenido.negocios p LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id=p.id
      WHERE p.id=$1`, [negocioId]);
  const { rows } = await pool.query(
    'SELECT capacidad, habilitada, config FROM contenido.negocio_capacidad WHERE negocio_id=$1', [negocioId]);
  const byId = {}; rows.forEach(r => { byId[r.capacidad] = r; });
  return CAPS.map(c => {
    const fila = byId[c.id] || { habilitada: false, config: {} };
    const cfg = fila.config || {};
    const ev = evaluarCap(c, d || {}, cfg);
    return { id: c.id, grupo: c.grupo, label: c.label, icon: c.icon, href: c.href, desc: c.desc,
             depende: c.depende || [], habilitada: !!fila.habilitada, config: cfg, ...ev };
  });
}

// Valida que un conjunto de URLs sean media de piezas de ESTE negocio (para la descarga).
async function urlsDeMediaDelNegocio(negocioId, urls) {
  if (!urls || !urls.length) return new Set();
  const { rows } = await pool.query(
    `SELECT DISTINCT m.url FROM contenido.media m
       JOIN contenido.piezas pz ON pz.id = m.pieza_id
      WHERE pz.negocio_id = $1 AND m.url = ANY($2)`, [negocioId, urls]);
  return new Set(rows.map(r => r.url));
}

// Contactos de la marca (dueño, community manager, pauta…). A quién escribirle, y a futuro
// a quién notificarle cuando su aviso sale en pantalla.
async function getContactos(negocioId) {
  const { rows } = await pool.query(
    'SELECT id, nombre, rol, whatsapp, email, notas FROM contenido.negocio_contacto ' +
    'WHERE negocio_id=$1 ORDER BY orden, creado_en', [negocioId]);
  return rows;
}

// Guardado por reemplazo: la UI manda la lista completa (es corta y se edita como un bloque).
async function guardarContactos(negocioId, lista) {
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
    await cli.query('DELETE FROM contenido.negocio_contacto WHERE negocio_id=$1', [negocioId]);
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      await cli.query(
        `INSERT INTO contenido.negocio_contacto (negocio_id, nombre, rol, whatsapp, email, notas, orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [negocioId, c.nombre, c.rol, c.whatsapp, c.email, c.notas, i]);
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally {
    cli.release();
  }
  return { ok: true, contactos: await getContactos(negocioId) };
}

// Aviso cargado A MANO (no lo hizo el creativo): material ya listo, de la biblioteca o de disco.
// Entra por la MISMA puerta que los del creativo: nace 'pendiente_aprobacion'. Nada va a la
// pantalla sin el visto de Fer.
async function crearAvisoManual(negocioId, d) {
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
      `INSERT INTO contenido.piezas (negocio_id, titulo_interno, canal, estado, notas)
         VALUES ($1,$2,'aviso','pendiente_aprobacion',$3) RETURNING id, numero`,
      [negocioId, titulo, 'Cargado a mano (material ya listo).']);
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

// Generación de estilo y manual de marca por el creativo (jobs). El manual necesita el estilo hecho.
async function pedirGeneracion(negocioId, tipo) {
  if (tipo !== 'estilo' && tipo !== 'manual') return { ok: false, error: 'tipo_invalido' };
  if (tipo === 'manual') {
    const { rows } = await pool.query(
      "SELECT length(coalesce(estilo_md,'')) AS n FROM contenido.negocio_perfil WHERE negocio_id=$1", [negocioId]);
    if (!rows[0] || rows[0].n <= 20) return { ok: false, error: 'falta_estilo' };
  }
  try {
    const { rows: [g] } = await pool.query(
      `INSERT INTO contenido.negocio_gen (negocio_id, tipo) VALUES ($1,$2) RETURNING id`,
      [negocioId, tipo]);
    return { ok: true, id: g.id };
  } catch (e) {
    if (e.code === '23505') return { ok: false, error: 'ya_en_curso' };  // índice único en curso
    throw e;
  }
}

// Estado de la generación para el panel: qué hay en curso y cómo quedó el manual.
async function getGeneracion(negocioId) {
  const { rows } = await pool.query(
    `SELECT tipo, estado, error FROM contenido.negocio_gen
       WHERE negocio_id=$1 AND estado IN ('pendiente','procesando')`, [negocioId]);
  const { rows: [p] } = await pool.query(
    `SELECT length(coalesce(estilo_md,'')) AS estilo_len,
            manual_html_url, manual_pdf_url, manual_generado_en
       FROM contenido.negocio_perfil WHERE negocio_id=$1`, [negocioId]);
  // Último error por tipo (para avisar si la última corrida falló y ya no está en curso).
  const { rows: err } = await pool.query(
    `SELECT DISTINCT ON (tipo) tipo, estado, error FROM contenido.negocio_gen
       WHERE negocio_id=$1 ORDER BY tipo, creado_en DESC`, [negocioId]);
  const ult = {}; err.forEach(r => { ult[r.tipo] = r; });
  const enCurso = t => rows.some(r => r.tipo === t);
  return {
    estilo:  { enCurso: enCurso('estilo'), hecho: (p && p.estilo_len > 20),
               error: (!enCurso('estilo') && ult.estilo && ult.estilo.estado === 'error') ? ult.estilo.error : null },
    manual:  { enCurso: enCurso('manual'),
               html_url: p && p.manual_html_url, pdf_url: p && p.manual_pdf_url,
               generado_en: p && p.manual_generado_en,
               error: (!enCurso('manual') && ult.manual && ult.manual.estado === 'error') ? ult.manual.error : null },
  };
}

// Catálogo de formatos de gráfica (medidas FINALES en mm, sin sangre: el job la suma).
const FORMATOS = [
  { id:'a6',        label:'Flyer A6',         ancho:105,  alto:148,  grupo:'Impresos' },
  { id:'a5',        label:'Flyer A5',         ancho:148,  alto:210,  grupo:'Impresos' },
  { id:'a4',        label:'Folleto A4',       ancho:210,  alto:297,  grupo:'Impresos' },
  { id:'triptico',  label:'Tríptico A4',      ancho:297,  alto:210,  grupo:'Impresos' },
  { id:'a3',        label:'Afiche A3',        ancho:297,  alto:420,  grupo:'Impresos' },
  { id:'a2',        label:'Afiche A2',        ancho:420,  alto:594,  grupo:'Impresos' },
  { id:'tarjeta',   label:'Tarjeta personal', ancho:90,   alto:50,   grupo:'Impresos' },
  { id:'sextuple',  label:'Séxtuple vía pública', ancho:2100, alto:1200, grupo:'Vía pública' },
  { id:'rollup',    label:'Roll-up',          ancho:800,  alto:2000, grupo:'Vía pública' },
  { id:'pasacalle', label:'Pasacalle',        ancho:3000, alto:1000, grupo:'Vía pública' },
  { id:'custom',    label:'A medida',         ancho:null, alto:null, grupo:'Vía pública' },
];

// --- Gráfica: piezas promocionales (folletos, afiches, vía pública) ---
/**
 * Las piezas del negocio. Las DESCARTADAS quedan afuera salvo que se pidan: descartar es decir
 * "esta no va", y que siga ocupando la grilla al lado de las vivas hace que descartar no se note.
 * No se borran —una pieza descartada puede volver, y el número ya se repartió—, sólo se corren
 * de la vista principal.
 */
async function getGraficas(negocioId, { descartadas = false } = {}) {
  const { rows } = await pool.query(`
    SELECT g.id, g.numero, g.nombre, g.formato, g.ancho_mm, g.alto_mm, g.mensaje, g.estado, g.version_actual,
           g.caras, g.fondo_modo, g.fondo_url, g.datos, g.actualizado_en,
           COALESCE(v.png_prev_url, v.png_url) AS png_url,
           v.png_dorso_url, v.pdf_url, v.estado AS v_estado, v.error AS v_error, v.nro AS v_nro
      FROM contenido.grafica g
      LEFT JOIN LATERAL (SELECT * FROM contenido.grafica_version x
                          WHERE x.grafica_id=g.id ORDER BY x.nro DESC LIMIT 1) v ON true
     WHERE g.negocio_id=$1 AND ($2 OR g.estado <> 'descartada')
     ORDER BY g.actualizado_en DESC`, [negocioId, descartadas]);
  return rows;
}

/** Cuántas hay descartadas, para poder ofrecerlas sin traerlas. */
async function contarGraficasDescartadas(negocioId) {
  const { rows: [r] } = await pool.query(
    "SELECT count(*)::int AS n FROM contenido.grafica WHERE negocio_id=$1 AND estado='descartada'",
    [negocioId]);
  return r ? r.n : 0;
}

async function getGrafica(negocioId, id) {
  const { rows: [g] } = await pool.query(
    'SELECT * FROM contenido.grafica WHERE id=$1 AND negocio_id=$2', [id, negocioId]);
  if (!g) return null;
  const { rows: vs } = await pool.query(
    `SELECT id, nro, instruccion, COALESCE(png_prev_url, png_url) AS png_url,
            png_dorso_url, pdf_url, html_url, estado, error, creado_en
       FROM contenido.grafica_version WHERE grafica_id=$1 ORDER BY nro DESC`, [id]);
  g.versiones = vs;
  return g;
}

// Crear la pieza y encolar su primera versión.
async function crearGrafica(negocioId, d) {
  const f = FORMATOS.find(x => x.id === d.formato);
  if (!f) return { ok: false, error: 'formato_invalido' };
  const ancho = f.ancho || Math.round(Number(d.ancho_mm) || 0);
  const alto  = f.alto  || Math.round(Number(d.alto_mm)  || 0);
  if (!(ancho > 0 && alto > 0)) return { ok: false, error: 'medidas_invalidas' };
  if (ancho > 6000 || alto > 6000) return { ok: false, error: 'medidas_excesivas' };
  const nombre = (d.nombre || '').trim().slice(0, 120) || (f.label + ' — ' + new Date().toLocaleDateString('es-AR'));
  const modo = ['biblioteca', 'subido', 'generar', 'sin_fondo'].includes(d.fondo_modo) ? d.fondo_modo : 'sin_fondo';
  const caras = Number(d.caras) === 2 ? 2 : 1;

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // El mensaje del dorso se guarda sólo si la pieza tiene dorso: si no, quedaría un texto
    // invisible que reaparece el día que alguien la pasa a dos caras.
    const dorso = caras === 2 ? ((d.mensaje_dorso || '').trim() || null) : null;
    // El fondo del dorso, con el mismo criterio: sólo existe si la pieza tiene dorso.
    const modoD = caras === 2 && ['biblioteca', 'subido', 'generar', 'sin_fondo'].includes(d.fondo_dorso_modo)
      ? d.fondo_dorso_modo : null;
    const { rows: [g] } = await cli.query(
      `INSERT INTO contenido.grafica (negocio_id, nombre, formato, ancho_mm, alto_mm, caras, mensaje,
                                      mensaje_dorso, fondo_modo, fondo_url, fondo_prompt,
                                      fondo_dorso_modo, fondo_dorso_url, fondo_dorso_prompt, datos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING id`,
      [negocioId, nombre, f.id, ancho, alto, caras, (d.mensaje || '').trim() || null, dorso,
       modo, (d.fondo_url || '').trim() || null, (d.fondo_prompt || '').trim() || null,
       modoD, modoD ? ((d.fondo_dorso_url || '').trim() || null) : null,
       modoD === 'generar' ? ((d.fondo_dorso_prompt || '').trim() || null) : null,
       JSON.stringify(d.datos || {})]);
    await cli.query(
      `INSERT INTO contenido.grafica_version (grafica_id, nro, instruccion) VALUES ($1, 1, $2)`,
      [g.id, (d.mensaje || '').trim() || null]);
    await cli.query('COMMIT');
    return { ok: true, id: g.id };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

/**
 * Duplica una pieza: misma definición (formato, medidas, fondo, datos, mensaje) con otro nombre.
 *
 * Se copia también la ÚLTIMA VERSIÓN LISTA, apuntando a los mismos archivos. Es a propósito: el
 * job de iteración parte del HTML de la versión anterior, así que la copia arranca del diseño
 * real y no de cero —que además costaría una generación con IA—. Los archivos se comparten y no
 * se duplican porque en cuanto se itera la copia se escriben los suyos; copiar de entrada un PDF
 * de imprenta de decenas de MB sería pagar disco por un estado que dura hasta el primer cambio.
 *
 * Lo que NO se copia: el número (cada pieza tiene el suyo, es su nombre en el panel), el estado
 * —una copia nace borrador aunque la original esté aprobada, porque nadie aprobó la copia— y el
 * historial de versiones anteriores, que es de la pieza original y no dice nada de esta.
 */
async function duplicarGrafica(negocioId, id, nombreNuevo) {
  const { rows: [g] } = await pool.query(
    'SELECT * FROM contenido.grafica WHERE id=$1 AND negocio_id=$2', [id, negocioId]);
  if (!g) return { ok: false, error: 'no_existe' };

  const nombre = String(nombreNuevo || '').trim().slice(0, 120) || `${g.nombre} (copia)`;
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [nueva] } = await cli.query(
      `INSERT INTO contenido.grafica (negocio_id, nombre, formato, ancho_mm, alto_mm, caras,
                                      mensaje, mensaje_dorso, fondo_modo, fondo_url, fondo_prompt,
                                      fondo_dorso_modo, fondo_dorso_url, fondo_dorso_prompt, datos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING id, numero`,
      [negocioId, nombre, g.formato, g.ancho_mm, g.alto_mm, g.caras, g.mensaje, g.mensaje_dorso,
       g.fondo_modo, g.fondo_url, g.fondo_prompt,
       g.fondo_dorso_modo, g.fondo_dorso_url, g.fondo_dorso_prompt, JSON.stringify(g.datos || {})]);

    const { rows: [v] } = await cli.query(
      `SELECT html_url, pdf_url, png_url, png_dorso_url, png_prev_url FROM contenido.grafica_version
        WHERE grafica_id=$1 AND estado='lista' ORDER BY nro DESC LIMIT 1`, [id]);
    if (v && v.html_url) {
      await cli.query(
        `INSERT INTO contenido.grafica_version
           (grafica_id, nro, instruccion, estado, html_url, pdf_url, png_url, png_dorso_url, png_prev_url, procesado_en)
         VALUES ($1, 1, $2, 'lista', $3, $4, $5, $6, $7, now())`,
        [nueva.id, `Copia de ${g.nombre}`, v.html_url, v.pdf_url, v.png_url, v.png_dorso_url, v.png_prev_url]);
      await cli.query('UPDATE contenido.grafica SET version_actual=1 WHERE id=$1', [nueva.id]);
    } else {
      // La original nunca llegó a diseñarse: la copia arranca igual que una pieza nueva, en cola.
      await cli.query(
        'INSERT INTO contenido.grafica_version (grafica_id, nro, instruccion) VALUES ($1, 1, $2)',
        [nueva.id, g.mensaje || null]);
    }
    await cli.query('COMMIT');
    return { ok: true, id: nueva.id, numero: nueva.numero, nombre };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

// Nueva iteración: se parte del diseño anterior y se aplica la instrucción de cambio.
async function iterarGrafica(negocioId, id, d) {
  const { rows: [g] } = await pool.query(
    'SELECT id, version_actual, caras FROM contenido.grafica WHERE id=$1 AND negocio_id=$2', [id, negocioId]);
  if (!g) return { ok: false, error: 'no_existe' };
  let txt = (d.instruccion || '').trim();

  // Cambio de fondo opcional durante la iteración, en la cara que se pida. Sin la cara, cambiar
  // la foto del dorso obligaba a pedirlo por texto y esperar que el creativo eligiera bien.
  const modo = ['biblioteca', 'subido', 'generar', 'sin_fondo'].includes(d.fondo_modo) ? d.fondo_modo : null;
  if (modo) {
    const alDorso = d.cara === 'dorso' && g.caras === 2;
    const col = alDorso
      ? { modo: 'fondo_dorso_modo', url: 'fondo_dorso_url', prompt: 'fondo_dorso_prompt', campo: 'fondo_dorso_url' }
      : { modo: 'fondo_modo', url: 'fondo_url', prompt: 'fondo_prompt', campo: 'fondo_url' };
    const url = (d.fondo_url || '').trim();
    const prompt = (d.fondo_prompt || '').trim();
    // El job genera un fondo IA cuando modo='generar' y la url viene vacía; para biblioteca/subido
    // guardamos la URL elegida; sin_fondo limpia la imagen.
    await pool.query(
      `UPDATE contenido.grafica SET ${col.modo}=$2, ${col.url}=$3, ${col.prompt}=$4 WHERE id=$1`,
      [id, modo, (modo === 'biblioteca' || modo === 'subido') ? (url || null) : null, modo === 'generar' ? (prompt || null) : null]);
    // El diseño anterior tiene el fondo viejo embebido: hay que decirle explícitamente que lo
    // cambie, y en qué cara — el HTML anterior trae las dos.
    const donde = alDorso ? 'del DORSO' : (g.caras === 2 ? 'del FRENTE' : '');
    const nota = {
      biblioteca: `Cambiá la imagen de fondo ${donde} por la nueva del contexto (${col.campo}).`,
      subido: `Cambiá la imagen de fondo ${donde} por la nueva del contexto (${col.campo}).`,
      generar: `Se generó un fondo nuevo ${donde}: usá esa imagen (${col.campo}) en lugar de la anterior.`,
      sin_fondo: `Quitá la imagen de fondo ${donde}: rediseñá esa cara sin foto, con fondo de color de la marca.`,
    }[modo].replace(/\s{2,}/g, ' ').replace(' :', ':');
    txt = txt ? `${txt}. ${nota}` : nota;
  }
  if (!txt) return { ok: false, error: 'sin_instruccion' };

  try {
    await pool.query(
      `INSERT INTO contenido.grafica_version (grafica_id, nro, instruccion)
         VALUES ($1, (SELECT coalesce(max(nro),0)+1 FROM contenido.grafica_version WHERE grafica_id=$1), $2)`,
      [id, txt]);
    return { ok: true };
  } catch (e) {
    if (e.code === '23505') return { ok: false, error: 'ya_en_curso' };
    throw e;
  }
}

async function estadoGrafica(negocioId, id, estado) {
  if (!['aprobada', 'descartada', 'lista'].includes(estado)) return { ok: false, error: 'estado_invalido' };
  const { rowCount } = await pool.query(
    'UPDATE contenido.grafica SET estado=$3, actualizado_en=now() WHERE id=$1 AND negocio_id=$2',
    [id, negocioId, estado]);
  return { ok: rowCount > 0 };
}

// Última verificación de integridad (la escribe el cron verificar_job.sh).
async function getVerificacion() {
  const { rows } = await pool.query(
    "SELECT valor, actualizado_en FROM contenido.plataforma_config WHERE clave='verificacion'");
  if (!rows[0] || !rows[0].valor) return null;
  try { return { chequeos: JSON.parse(rows[0].valor), cuando: rows[0].actualizado_en }; }
  catch (e) { return null; }
}

// Salud de los servicios de TERCEROS (la escribe el cron salud_externa_job.sh). Va aparte de
// la verificación de integridad porque mira afuera y falla distinto: un token que vence o una
// credencial que caduca no son una rotura nuestra, pero nos dejan sin publicar igual.
async function getSaludExterna() {
  const { rows } = await pool.query(
    "SELECT valor, actualizado_en FROM contenido.plataforma_config WHERE clave='salud_externa'");
  if (!rows[0] || !rows[0].valor) return null;
  try { return { chequeos: JSON.parse(rows[0].valor), cuando: rows[0].actualizado_en }; }
  catch (e) { return null; }
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
// tabla, no de negocio_id (se enlaza después, si el alta se concreta).
async function crearDescubrimiento(d) {
  const web = (d.web || '').trim();
  const ig = (d.instagram || '').trim();
  if (!web && !ig) return { ok: false, error: 'sin_fuentes' };
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.negocio_descubrimiento (nombre, web, instagram, notas)
       VALUES ($1,$2,$3,$4) RETURNING id`,
    [(d.nombre || '').trim() || null, web || null, ig || null, (d.notas || '').trim() || null]);
  return { ok: true, id: r.id };
}

async function getDescubrimiento(id) {
  const { rows } = await pool.query(
    'SELECT id, estado, resultado, error FROM contenido.negocio_descubrimiento WHERE id=$1', [id]);
  return rows[0] || null;
}

// Alta de marca desde el panel (wizard). Crea proyecto + perfil + capacidades y ENCOLA el
// scaffold de la cápsula (artefacto derivado de la DB). No toca el disco directamente.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
async function crearNegocio(d) {
  const nombre = (d.nombre || '').trim();
  const slug = (d.slug || '').trim().toLowerCase();
  if (!nombre) return { ok: false, error: 'nombre_requerido' };
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'slug_invalido' };
  const dup = await pool.query('SELECT 1 FROM contenido.negocios WHERE slug=$1', [slug]);
  if (dup.rowCount) return { ok: false, error: 'slug_duplicado' };
  // Capacidades elegidas + sus dependencias (pauta arrastra instagram).
  const set = new Set(Array.isArray(d.capacidades) ? d.capacidades : []);
  CAPS.forEach(c => { if (set.has(c.id)) (c.depende || []).forEach(x => set.add(x)); });
  const txt = v => ((v || '').trim() || null);

  const gestion = d.gestion === 'parcial' ? 'parcial' : 'integral';
  const { rows: [p] } = await pool.query(
    `INSERT INTO contenido.negocios (slug, nombre, dominio_web, ig_handle, email, whatsapp, gestion)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [slug, nombre, txt(d.dominio_web), txt(d.ig_handle), txt(d.email), txt(d.whatsapp), gestion]);
  await pool.query(
    `INSERT INTO contenido.negocio_perfil (negocio_id, slogan, brief_md, estilo_md, logo, actualizado_en)
       VALUES ($1,$2,$3,$4,$5, now())`,
    [p.id, txt(d.slogan), txt(d.brief_md), txt(d.estilo_md), txt(d.logo)]);
  // Trazabilidad: de qué análisis salió esta marca.
  if (d.descubrimiento_id) {
    await pool.query('UPDATE contenido.negocio_descubrimiento SET negocio_id=$1 WHERE id=$2',
      [p.id, d.descubrimiento_id]).catch(() => {});
  }
  for (const cap of CAPS) {
    const on = set.has(cap.id);
    const config = (cap.id === 'web' && on) ? { modo: (d.web_modo === 'administrada' ? 'administrada' : 'referencia') } : {};
    await pool.query(
      `INSERT INTO contenido.negocio_capacidad (negocio_id, capacidad, habilitada, config)
         VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
      [p.id, cap.id, on, JSON.stringify(config)]);
  }
  await pool.query("INSERT INTO contenido.negocio_capsula_req (slug, accion) VALUES ($1,'scaffold')", [slug]);
  _negociosAt = 0;
  return { ok: true, slug };
}

// Vista de agencia: todas las marcas con el estado de cada capacidad (grilla marca × capacidad).
async function getCapacidadesTodas() {
  const marcas = await getNegocios();
  const out = [];
  for (const m of marcas) {
    out.push({ slug: m.slug, nombre: m.nombre, logo: m.logo, activo: m.activo,
               capacidades: await getCapacidades(m.id) });
  }
  return out;
}

async function setCapacidad(negocioId, capId, { habilitada, config }) {
  const cap = CAPS.find(c => c.id === capId);
  if (!cap) return { ok: false, error: 'capacidad_desconocida' };
  if (habilitada && (cap.depende || []).length) {
    const { rows } = await pool.query(
      'SELECT capacidad FROM contenido.negocio_capacidad WHERE negocio_id=$1 AND habilitada', [negocioId]);
    const on = new Set(rows.map(r => r.capacidad));
    const falta = cap.depende.filter(x => !on.has(x));
    if (falta.length) return { ok: false, error: 'depende', depende: falta };
  }
  await pool.query(
    `INSERT INTO contenido.negocio_capacidad (negocio_id, capacidad, habilitada, config, actualizado_en)
       VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb), now())
     ON CONFLICT (negocio_id, capacidad) DO UPDATE SET habilitada=$3,
       config = CASE WHEN $4 IS NULL THEN contenido.negocio_capacidad.config ELSE $4::jsonb END,
       actualizado_en = now()`,
    [negocioId, capId, !!habilitada, config ? JSON.stringify(config) : null]);
  // Cascada: apagar una capacidad apaga las que dependen de ella.
  if (!habilitada) {
    const dependientes = CAPS.filter(c => (c.depende || []).includes(capId)).map(c => c.id);
    if (dependientes.length) {
      await pool.query(
        `UPDATE contenido.negocio_capacidad SET habilitada=false, actualizado_en=now()
          WHERE negocio_id=$1 AND capacidad = ANY($2::text[])`, [negocioId, dependientes]);
    }
  }
  return { ok: true };
}

// Token de IG de una marca desde el perfil (descifrado), o null. Lo usa el panel (menciones/métricas).
async function getIgToken(slug) {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT pp.ig_token_enc FROM contenido.negocios p JOIN contenido.negocio_perfil pp ON pp.negocio_id=p.id WHERE p.slug=$1`, [slug]);
    if (r && r.ig_token_enc) return cryptoAds.decrypt(r.ig_token_enc);
  } catch (e) { console.error('getIgToken', e.message); }
  return null;
}
/**
 * Los textos largos del perfil (brief, estilo) se guardan con dos redes, porque en septiembre de
 * un año cualquiera nadie se acuerda de que hubo un incidente:
 *
 *  1. GUARDA. Si lo que llega es drásticamente más corto que lo guardado, NO se escribe: se
 *     devuelve el detalle y la persona confirma. Pasó de verdad —9018 caracteres reemplazados
 *     por 342 sin que nada preguntara nada— y el texto sólo se recuperó del respaldo del día.
 *  2. HISTORIAL. Antes de pisar, la versión anterior se archiva. Aun cuando alguien confirme el
 *     recorte, volver atrás es un clic y no una restauración de base.
 *
 * Los umbrales apuntan a un caso concreto: perder de golpe la mayor parte de un texto escrito a
 * mano. Achicar un brief de 900 a 600 caracteres es edición normal y pasa sin molestar.
 */
const TEXTOS_LARGOS = ['brief_md', 'estilo_md', 'referencias_md'];
const RECORTE_MIN_CHARS = 400;   // por debajo de esto, cualquier cambio es edición normal
const RECORTE_PROPORCION = 0.5;  // perder más de la mitad es la señal

async function _guardarTextoLargo(cli, negocioId, campo, nuevo, usuarioId, confirmado) {
  const { rows: [prev] } = await cli.query(
    `SELECT ${campo} AS v FROM contenido.negocio_perfil WHERE negocio_id=$1`, [negocioId]);
  const viejo = (prev && prev.v) || '';
  if (viejo === (nuevo || '')) return null;              // sin cambios: ni guarda ni historial

  const perdidos = viejo.length - (nuevo || '').length;
  if (!confirmado && perdidos >= RECORTE_MIN_CHARS &&
      (nuevo || '').length < viejo.length * RECORTE_PROPORCION) {
    const e = new Error('recorte');
    e.code = 'recorte_grande';
    e.detalle = { campo, largo_actual: viejo.length, largo_nuevo: (nuevo || '').length, perdidos };
    throw e;
  }
  // El historial guarda lo que se está por PISAR, no lo nuevo: es lo que hace falta para volver.
  if (viejo) {
    await cli.query(
      `INSERT INTO contenido.perfil_texto_hist (negocio_id, campo, contenido, largo, usuario_id)
       VALUES ($1,$2,$3,$4,$5)`, [negocioId, campo, viejo, viejo.length, usuarioId || null]);
  }
  return true;
}

async function guardarPerfil(negocioId, d) {
  const nn = s => (s != null && String(s).trim() !== '') ? String(s).trim() : null;
  // Cifrar los tokens ANTES de escribir nada (si falta la clave, falla limpio sin guardar a medias).
  let tokEnc = null, igTokEnc = null;
  if (nn(d.meta_ads_token) || nn(d.ig_token)) {
    if (!cryptoAds.hasKey()) { const e = new Error('APP_ENC_KEY no configurada en el panel'); e.code = 'no_enc_key'; throw e; }
    if (nn(d.meta_ads_token)) tokEnc = cryptoAds.encrypt(nn(d.meta_ads_token));
    if (nn(d.ig_token)) igTokEnc = cryptoAds.encrypt(nn(d.ig_token));
  }
  if (nn(d.nombre)) await pool.query('UPDATE contenido.negocios SET nombre=$2 WHERE id=$1', [negocioId, nn(d.nombre)]);
  await pool.query(
    `UPDATE contenido.negocios SET ig_handle=$2, dominio_web=$3, ig_user_id=$4, telegram_chat_id=$5, email=$6, whatsapp=$7 WHERE id=$1`,
    [negocioId, nn(d.ig_handle), nn(d.dominio_web), nn(d.ig_user_id), nn(d.telegram_chat_id), nn(d.email), nn(d.whatsapp)]);
  if (typeof d.prefijo === 'string') {
    const pf = d.prefijo.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (pf) { await pool.query('UPDATE contenido.negocios SET prefijo=$2 WHERE id=$1', [negocioId, pf]); _negociosAt = 0; }
  }
  if (d.gestion === 'integral' || d.gestion === 'parcial') {
    await pool.query('UPDATE contenido.negocios SET gestion=$2 WHERE id=$1', [negocioId, d.gestion]);
    _negociosAt = 0;   // el inicio agrupa por esto: invalidar el cache
  }
  // Los textos largos pasan por la guarda y dejan su versión anterior en el historial. Va antes
  // del INSERT y en la misma conexión: si la guarda salta, no se escribe NADA del perfil — un
  // guardado a medias con el brief pisado sería el peor de los dos mundos.
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    for (const campo of TEXTOS_LARGOS) {
      await _guardarTextoLargo(cli, negocioId, campo, nn(d[campo]) || '', d.usuario_id,
                               d.confirmar_recorte === true);
    }
    await cli.query(`
      INSERT INTO contenido.negocio_perfil (negocio_id, slogan, logo, logo_claro, brief_md, estilo_md, referencias_md, actualizado_en)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now())
      ON CONFLICT (negocio_id) DO UPDATE SET slogan=$2, logo=$3, logo_claro=$4,
                                             brief_md=$5, estilo_md=$6, referencias_md=$7, actualizado_en=now()`,
      [negocioId, nn(d.slogan), nn(d.logo), nn(d.logo_claro), nn(d.brief_md), nn(d.estilo_md), nn(d.referencias_md)]);
    await cli.query('COMMIT');
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
  // Pauta: IDs en claro (COALESCE: vacío = no toca); token cifrado, write-only.
  await pool.query(
    `UPDATE contenido.negocio_perfil SET
       meta_ads_account_id = COALESCE($2, meta_ads_account_id),
       meta_ads_page_id    = COALESCE($3, meta_ads_page_id),
       meta_ads_ig_id      = COALESCE($4, meta_ads_ig_id)
     WHERE negocio_id=$1`,
    [negocioId, nn(d.meta_ads_account_id), nn(d.meta_ads_page_id), nn(d.meta_ads_ig_id)]);
  if (tokEnc) await pool.query('UPDATE contenido.negocio_perfil SET meta_ads_token_enc=$2 WHERE negocio_id=$1', [negocioId, tokEnc]);
  if (igTokEnc) {
    await pool.query('UPDATE contenido.negocio_perfil SET ig_token_enc=$2 WHERE negocio_id=$1', [negocioId, igTokEnc]);
    // La DB es la fuente de verdad: pedimos regenerar los secretos derivados (credencial de n8n).
    await pool.query('INSERT INTO contenido.secrets_sync_req (slug) SELECT slug FROM contenido.negocios WHERE id=$1', [negocioId]);
  }
  // El contexto que lee el creativo es una copia derivada de esto: se pide regenerarlo. Sin
  // esto, editar el brief en el panel no llegaba al agente hasta que corriera algún job.
  await pool.query(
    'INSERT INTO contenido.contexto_sync_req (slug) SELECT slug FROM contenido.negocios WHERE id=$1',
    [negocioId]).catch(() => {});
  _negociosAt = 0;   // el nombre pudo cambiar -> refrescar cache de marcas
  return true;
}
/** Las versiones anteriores de un texto largo, para poder volver sin ir al respaldo del día. */
async function getTextoHistorial(negocioId, campo) {
  if (!TEXTOS_LARGOS.includes(campo)) return [];
  const { rows } = await pool.query(
    `SELECT h.id, h.largo, h.guardado_en, u.nombre AS usuario
       FROM contenido.perfil_texto_hist h
       LEFT JOIN contenido.usuario u ON u.id = h.usuario_id
      WHERE h.negocio_id=$1 AND h.campo=$2 ORDER BY h.guardado_en DESC LIMIT 20`,
    [negocioId, campo]);
  return rows;
}

/** El contenido de una versión, para verla antes de restaurarla. */
async function getTextoVersion(negocioId, id) {
  const { rows: [r] } = await pool.query(
    `SELECT campo, contenido, largo, guardado_en FROM contenido.perfil_texto_hist
      WHERE id=$1 AND negocio_id=$2`, [id, negocioId]);
  return r || null;
}

// Actualiza SOLO el logo (sin tocar slogan/brief). Lo usa la subida de archivo del perfil.
/**
 * El logo del negocio. `variante='claro'` guarda la versión PARA FONDO CLARO — un logo es una
 * sola pieza pensada para un fondo, y sobre el contrario desaparece: sin las dos, cada pieza que
 * no sea del color de la marca tiene que inventar un parche.
 */
async function setLogo(negocioId, url, variante = 'oscuro') {
  const col = variante === 'claro' ? 'logo_claro' : 'logo';
  await pool.query(`
    INSERT INTO contenido.negocio_perfil (negocio_id, ${col}, actualizado_en)
    VALUES ($1,$2, now())
    ON CONFLICT (negocio_id) DO UPDATE SET ${col}=$2, actualizado_en=now()`,
    [negocioId, url]);
  _negociosAt = 0;   // el logo se cachea en la lista de marcas
  return true;
}

// --- Clientes (v2.0 / F3) ----------------------------------------------------------------
// Los datos son DEL NEGOCIO; ClaUsina los procesa. Todo va scopeado por negocio_id: no hay
// una sola consulta acá que pueda cruzar datos entre negocios, y eso es a propósito.
const ORIGENES = ['whatsapp', 'landing', 'carga', 'agente', 'importacion'];

async function getClientes(negocioId, { q, limit = 200, offset = 0 } = {}) {
  const params = [negocioId];
  let filtro = '';
  if (q && String(q).trim()) {
    const t = '%' + String(q).trim().toLowerCase() + '%';
    params.push(t);
    // La rama por teléfono normalizado sólo se agrega si la consulta PARECE un teléfono. Antes
    // iba siempre, con un centinela para "no es un teléfono"; eso obliga a inventar un valor que
    // no matchee nada y es justo donde se coló un byte NUL que rompía toda la búsqueda por texto.
    const clave = tel.clave(q);
    let porTel = '';
    if (clave) { params.push(clave); porTel = ` OR telefono_norm = $${params.length}`; }
    filtro = ` AND (lower(coalesce(nombre,'')) LIKE $2 OR lower(coalesce(email,'')) LIKE $2
                    OR coalesce(telefono,'') LIKE $2${porTel})`;
  }
  params.push(Math.min(+limit || 200, 1000), Math.max(+offset || 0, 0));
  const { rows } = await pool.query(
    `SELECT id, nombre, telefono, telefono_norm, email, notas, origen,
            consentimiento, consentimiento_en, ref_externa, creado_en, actualizado_en
       FROM contenido.cliente WHERE negocio_id=$1${filtro}
      ORDER BY creado_en DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const { rows: [c] } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE consentimiento)::int AS con_consentimiento
       FROM contenido.cliente WHERE negocio_id=$1`, [negocioId]);
  return { clientes: rows, total: c.total, con_consentimiento: c.con_consentimiento };
}

function _datosCliente(d) {
  const nn = s => (s != null && String(s).trim() !== '') ? String(s).trim() : null;
  // OJO: no llamarla `tel` — tapa al módulo telefono.js, que se importa con ese nombre.
  const numero = nn(d.telefono);
  return {
    nombre: nn(d.nombre),
    telefono: numero,
    telefono_norm: numero ? (tel.clave(numero) || null) : null,
    email: nn(d.email) ? nn(d.email).toLowerCase() : null,
    notas: nn(d.notas),
    origen: ORIGENES.includes(d.origen) ? d.origen : 'carga',
    consentimiento: !!d.consentimiento,
    ref_externa: nn(d.ref_externa),
  };
}

async function crearCliente(negocioId, d) {
  const c = _datosCliente(d);
  if (!c.nombre && !c.telefono_norm && !c.email) { const e = new Error('sin datos'); e.code = 'sin_datos'; throw e; }
  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO contenido.cliente
         (negocio_id, nombre, telefono, telefono_norm, email, notas, origen, consentimiento, ref_externa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [negocioId, c.nombre, c.telefono, c.telefono_norm, c.email, c.notas, c.origen, c.consentimiento, c.ref_externa]);
    return { ok: true, id: r.id };
  } catch (e) {
    if (e.code === '23505') { const x = new Error('teléfono repetido'); x.code = 'tel_repetido'; throw x; }
    throw e;
  }
}

async function actualizarCliente(negocioId, id, d) {
  const c = _datosCliente(d);
  if (!c.nombre && !c.telefono_norm && !c.email) { const e = new Error('sin datos'); e.code = 'sin_datos'; throw e; }
  try {
    // El negocio_id va en el WHERE, no sólo el id: sin eso, conocer un uuid ajeno alcanzaría.
    const { rowCount } = await pool.query(
      `UPDATE contenido.cliente SET nombre=$3, telefono=$4, telefono_norm=$5, email=$6,
              notas=$7, origen=$8, consentimiento=$9, ref_externa=$10
        WHERE id=$2 AND negocio_id=$1`,
      [negocioId, id, c.nombre, c.telefono, c.telefono_norm, c.email, c.notas, c.origen, c.consentimiento, c.ref_externa]);
    return { ok: rowCount > 0 };
  } catch (e) {
    if (e.code === '23505') { const x = new Error('teléfono repetido'); x.code = 'tel_repetido'; throw x; }
    throw e;
  }
}

// El cliente tiene ON DELETE RESTRICT desde reserva: borrar a alguien no puede hacer desaparecer
// en silencio una reserva agendada. Pero eso no significa que no se pueda borrar nunca — significa
// que hay que decirlo y que quien borra decida.
async function borrarCliente(negocioId, id, conReservas = false) {
  const { rows: [c] } = await pool.query(
    `SELECT count(*)::int AS n FROM contenido.reserva
      WHERE cliente_id=$1 AND negocio_id=$2`, [id, negocioId]);
  if (c.n && !conReservas) {
    const e = new Error('tiene reservas'); e.code = 'con_reservas'; e.detalle = { reservas: c.n }; throw e;
  }
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    let reservas = 0;
    if (c.n) {
      const r = await cli.query(
        'DELETE FROM contenido.reserva WHERE cliente_id=$1 AND negocio_id=$2', [id, negocioId]);
      reservas = r.rowCount;
    }
    const { rowCount } = await cli.query(
      'DELETE FROM contenido.cliente WHERE id=$1 AND negocio_id=$2', [id, negocioId]);
    await cli.query('COMMIT');
    return { ok: rowCount > 0, reservas };
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); }
}

// Exportar y borrar en bloque: son la contracara de "los datos son del negocio". Si un negocio
// se va, se lleva su base y ClaUsina la borra. Tienen que existir desde el día uno.
async function exportarClientes(negocioId) {
  const { rows } = await pool.query(
    `SELECT nombre, telefono, email, notas, origen, consentimiento, consentimiento_en, creado_en
       FROM contenido.cliente WHERE negocio_id=$1 ORDER BY creado_en`, [negocioId]);
  const esc = v => {
    if (v == null) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const cols = ['nombre','telefono','email','notas','origen','consentimiento','consentimiento_en','creado_en'];
  // Con BOM para que Excel en español no rompa los acentos.
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

// El negocio se va y pide que borremos sus datos. Las reservas cuelgan de los clientes, así que
// sin borrarlas primero la clave foránea rechaza todo y la promesa no se puede cumplir.
async function borrarTodosLosClientes(negocioId) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query('DELETE FROM contenido.reserva WHERE negocio_id=$1', [negocioId]);
    const c = await cli.query('DELETE FROM contenido.cliente WHERE negocio_id=$1', [negocioId]);
    await cli.query('COMMIT');
    return { ok: true, borrados: c.rowCount, reservas: r.rowCount };
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); }
}

// --- Reservas (v2.0 / F4) ----------------------------------------------------------------
// Zona horaria explícita: el servidor corre en UTC y una reserva es un momento LOCAL. Comparar
// "faltan 2 horas" sin esto da tres horas de diferencia, que es exactamente el error que hace
// que se acepte una reserva para dentro de un rato o se rechace una válida.
const TZ = 'America/Argentina/Buenos_Aires';

// La capacidad se mide en la unidad que use el negocio: cubiertos en una parrilla, canchas en un
// complejo, cupos en un curso. La reserva se pide en esa misma unidad.
const UNIDADES = [
  { id: 'personas',  sing: 'persona',  plur: 'personas'  },
  { id: 'cubiertos', sing: 'cubierto', plur: 'cubiertos' },
  { id: 'canchas',   sing: 'cancha',   plur: 'canchas'   },
  { id: 'mesas',     sing: 'mesa',     plur: 'mesas'     },
  { id: 'lugares',   sing: 'lugar',    plur: 'lugares'   },
  { id: 'cupos',     sing: 'cupo',     plur: 'cupos'     },
];

const CFG_RESERVAS = {
  anticipacion_max_dias: 30,   // hasta cuándo se puede reservar hacia adelante
  anticipacion_min_horas: 2,   // cuánto antes, como mínimo (no es lo mismo que lo anterior)
  unidad: 'personas',
  cantidad_min: 1,
  cantidad_max: 12,
  // Se cuenta DESDE EL INICIO DEL TURNO: la reserva es por turno completo, no por una hora suelta.
  tolerancia_min: 15,
};

async function getConfigReservas(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT config FROM contenido.negocio_capacidad WHERE negocio_id=$1 AND capacidad='reservas'`,
    [negocioId]);
  return { ...CFG_RESERVAS, ...((r && r.config) || {}) };
}

// Los parámetros operativos (anticipación, personas, tolerancia) los maneja quien opera el
// negocio. La FUENTE DE VERDAD es estructural —define si ClaUsina manda sobre el dato o es un
// espejo— así que sólo la toca un admin.
async function guardarConfigReservas(negocioId, d, esAdmin) {
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(Math.round(n), max)) : def;
  };
  const actual = await getConfigReservas(negocioId);
  const cfg = {
    ...actual,
    anticipacion_max_dias:  num(d.anticipacion_max_dias,  actual.anticipacion_max_dias,  1, 365),
    anticipacion_min_horas: num(d.anticipacion_min_horas, actual.anticipacion_min_horas, 0, 720),
    cantidad_min:           num(d.cantidad_min,           actual.cantidad_min,           1, 100000),
    cantidad_max:           num(d.cantidad_max,           actual.cantidad_max,           1, 100000),
    tolerancia_min:         num(d.tolerancia_min,         actual.tolerancia_min,         0, 480),
    unidad: UNIDADES.some(u => u.id === d.unidad) ? d.unidad : (actual.unidad || 'personas'),
    auto_confirmar:         !!d.auto_confirmar,
    // Abrir las reservas al público es un acto explícito: el silencio es no.
    publico:                !!d.publico,
  };
  if (cfg.cantidad_min > cfg.cantidad_max) cfg.cantidad_min = cfg.cantidad_max;
  if (esAdmin && ['clausina', 'externo'].includes(d.fuente_verdad)) cfg.fuente_verdad = d.fuente_verdad;
  await pool.query(
    `INSERT INTO contenido.negocio_capacidad (negocio_id, capacidad, habilitada, config, actualizado_en)
     VALUES ($1,'reservas',
             COALESCE((SELECT habilitada FROM contenido.negocio_capacidad
                        WHERE negocio_id=$1 AND capacidad='reservas'), false),
             $2::jsonb, now())
     ON CONFLICT (negocio_id, capacidad) DO UPDATE SET config=$2::jsonb, actualizado_en=now()`,
    [negocioId, JSON.stringify(cfg)]);
  return { ok: true, config: cfg };
}

// ── Turnos ────────────────────────────────────────────────────────────────────
async function getTurnos(negocioId) {
  const { rows } = await pool.query(
    `SELECT id, nombre, nombre_publico, capacidad, cantidad_max, dias,
            to_char(hora_desde,'HH24:MI') AS hora_desde,
            to_char(hora_hasta,'HH24:MI') AS hora_hasta, activo, orden
       FROM contenido.turno WHERE negocio_id=$1 ORDER BY orden, hora_desde`, [negocioId]);
  return rows;
}

async function guardarTurno(negocioId, id, d) {
  const nombre = String(d.nombre || '').trim();
  const capacidad = Math.max(1, Math.min(+d.capacidad || 0, 100000));
  const dias = [...new Set((Array.isArray(d.dias) ? d.dias : []).map(Number)
    .filter(n => n >= 1 && n <= 7))].sort();
  if (!nombre) { const e = new Error('falta nombre'); e.code = 'sin_nombre'; throw e; }
  if (!dias.length) { const e = new Error('sin días'); e.code = 'sin_dias'; throw e; }
  if (!/^\d{1,2}:\d{2}$/.test(d.hora_desde || '') || !/^\d{1,2}:\d{2}$/.test(d.hora_hasta || '')) {
    const e = new Error('horario inválido'); e.code = 'horario_invalido'; throw e;
  }
  if (d.hora_desde >= d.hora_hasta) { const e = new Error('horario al revés'); e.code = 'horario_invalido'; throw e; }
  // Vacío o 0 = hereda el máximo general. Se guarda NULL y no una copia del valor: así, si el
  // general cambia, los turnos que no lo pisaron siguen al día sin tocarlos.
  const maxPropio = (d.cantidad_max === '' || d.cantidad_max == null || +d.cantidad_max <= 0)
    ? null : Math.min(Math.round(+d.cantidad_max), 100000);
  // El público es una descripción y puede repetirse; vacío = se usa la clave interna.
  const publico = String(d.nombre_publico || '').trim() || null;
  const args = [negocioId, nombre, capacidad, dias, d.hora_desde, d.hora_hasta,
                d.activo === false ? false : true, +d.orden || 0, maxPropio, publico];
  if (id) {
    const { rowCount } = await pool.query(
      `UPDATE contenido.turno SET nombre=$2, capacidad=$3, dias=$4::smallint[], hora_desde=$5::time,
              hora_hasta=$6::time, activo=$7, orden=$8, cantidad_max=$9, nombre_publico=$10
        WHERE id=$11 AND negocio_id=$1`, [...args, id]);
    return { ok: rowCount > 0 };
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.turno (negocio_id, nombre, capacidad, dias, hora_desde, hora_hasta, activo, orden, cantidad_max, nombre_publico)
     VALUES ($1,$2,$3,$4::smallint[],$5::time,$6::time,$7,$8,$9,$10) RETURNING id`, args);
  return { ok: true, id: r.id };
}

async function borrarTurno(negocioId, id) {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM contenido.turno WHERE id=$1 AND negocio_id=$2', [id, negocioId]);
    return { ok: rowCount > 0 };
  } catch (e) {
    // ON DELETE RESTRICT desde reserva: un turno con reservas no se borra, se desactiva.
    if (e.code === '23503') { const x = new Error('turno con reservas'); x.code = 'con_reservas'; throw x; }
    throw e;
  }
}

// ── Bloqueos ──────────────────────────────────────────────────────────────────
async function getBloqueos(negocioId, desde, hasta) {
  const { rows } = await pool.query(
    `SELECT b.id, b.fecha::text, b.turno_id, b.motivo, t.nombre AS turno
       FROM contenido.bloqueo b LEFT JOIN contenido.turno t ON t.id=b.turno_id
      WHERE b.negocio_id=$1 AND b.fecha BETWEEN $2::date AND $3::date
      ORDER BY b.fecha, t.orden NULLS FIRST`, [negocioId, desde, hasta]);
  return rows;
}

async function crearBloqueo(negocioId, d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha || '')) { const e = new Error('fecha'); e.code = 'fecha_invalida'; throw e; }
  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO contenido.bloqueo (negocio_id, fecha, turno_id, motivo)
       SELECT $1, $2::date, $3::uuid, $4
        WHERE $3::uuid IS NULL
           OR EXISTS (SELECT 1 FROM contenido.turno WHERE id=$3::uuid AND negocio_id=$1)
       RETURNING id`,
      [negocioId, d.fecha, d.turno_id || null, String(d.motivo || '').trim() || null]);
    if (!r) { const e = new Error('turno ajeno'); e.code = 'turno_invalido'; throw e; }
    return { ok: true, id: r.id };
  } catch (e) {
    if (e.code === '23505') { const x = new Error('ya bloqueado'); x.code = 'ya_bloqueado'; throw x; }
    throw e;
  }
}

async function borrarBloqueo(negocioId, id) {
  const { rowCount } = await pool.query(
    'DELETE FROM contenido.bloqueo WHERE id=$1 AND negocio_id=$2', [id, negocioId]);
  return { ok: rowCount > 0 };
}

// ── Disponibilidad: lo que alimenta la vista calendarizada ───────────────────
// Un turno aparece en un día si ese día de la semana está en `dias`. La ocupación cuenta sólo
// las reservas que pesan: una cancelada libera el lugar, una no_show ya pasó.
async function getDisponibilidad(negocioId, desde, hasta) {
  const { rows } = await pool.query(
    `WITH dias AS (SELECT d::date AS fecha FROM generate_series($2::date, $3::date, '1 day') d),
          t AS (SELECT * FROM contenido.turno WHERE negocio_id=$1 AND activo)
     SELECT dias.fecha::text, t.id AS turno_id, t.nombre, t.nombre_publico, t.capacidad,
            t.cantidad_max, t.orden,
            to_char(t.hora_desde,'HH24:MI') AS hora_desde,
            to_char(t.hora_hasta,'HH24:MI') AS hora_hasta,
            COALESCE(r.ocupado, 0)::int AS ocupado,
            COALESCE(r.pendiente, 0)::int AS pendiente,
            COALESCE(r.reservas, 0)::int AS reservas,
            (bd.id IS NOT NULL OR bt.id IS NOT NULL) AS bloqueado,
            COALESCE(bd.motivo, bt.motivo) AS motivo_bloqueo
       FROM dias
       JOIN t ON EXTRACT(isodow FROM dias.fecha)::smallint = ANY(t.dias)
       LEFT JOIN LATERAL (
         SELECT sum(cantidad)::int AS ocupado, count(*)::int AS reservas,
                -- Cuánto de lo ocupado todavía no confirmó nadie. El calendario lo pinta aparte:
                -- un turno lleno de solicitudes sin confirmar no es lo mismo que uno lleno.
                sum(cantidad) FILTER (WHERE rr.estado='solicitada')::int AS pendiente
           FROM contenido.reserva rr
          WHERE rr.negocio_id=$1 AND rr.turno_id=t.id AND rr.fecha=dias.fecha
            AND rr.estado IN ('solicitada','confirmada','cumplida')) r ON true
       LEFT JOIN contenido.bloqueo bd
         ON bd.negocio_id=$1 AND bd.fecha=dias.fecha AND bd.turno_id IS NULL
       LEFT JOIN contenido.bloqueo bt
         ON bt.negocio_id=$1 AND bt.fecha=dias.fecha AND bt.turno_id=t.id
      ORDER BY dias.fecha, t.orden, t.hora_desde`, [negocioId, desde, hasta]);
  return rows;
}

// ── Reservas ──────────────────────────────────────────────────────────────────
async function getReservas(negocioId, { desde, hasta, estado } = {}) {
  const params = [negocioId];
  let filtro = '';
  if (desde && hasta) { params.push(desde, hasta); filtro += ` AND r.fecha BETWEEN $2::date AND $3::date`; }
  if (estado) { params.push(estado); filtro += ` AND r.estado = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT r.id, r.fecha::text, r.cantidad, r.estado, r.canal,
            r.notas, r.agente_id, r.ref_externa, r.creado_en,
            r.turno_id, t.nombre AS turno,
            to_char(t.hora_desde,'HH24:MI') AS hora_desde, to_char(t.hora_hasta,'HH24:MI') AS hora_hasta,
            r.cliente_id, c.nombre AS cliente, c.telefono, c.email,
            -- La invitación viaja con la reserva: quien mira la lista del día tiene que ver el
            -- beneficio SIN abrir nada, porque es lo que va a tener que aplicar en el mostrador.
            iu.id AS uso_id, iu.estado AS invitacion_estado, i.codigo AS invitacion_codigo,
            bf.nombre AS invitacion_nombre, bf.tipo AS invitacion_tipo, bf.valor AS invitacion_valor
       FROM contenido.reserva r
       LEFT JOIN contenido.invitacion_uso iu ON iu.reserva_id = r.id
       LEFT JOIN contenido.invitacion i ON i.id = iu.invitacion_id
       LEFT JOIN contenido.beneficio bf ON bf.id = i.beneficio_id
       JOIN contenido.turno t ON t.id = r.turno_id
       JOIN contenido.cliente c ON c.id = r.cliente_id
      WHERE r.negocio_id=$1${filtro}
      ORDER BY r.fecha DESC, t.hora_desde DESC`, params);
  // El texto del beneficio se arma acá y no en la pantalla: la lista, el detalle y el mensaje de
  // WhatsApp tienen que decir exactamente lo mismo.
  return rows.map(r => ({
    ...r,
    invitacion: r.invitacion_codigo ? {
      uso_id: r.uso_id, estado: r.invitacion_estado, codigo: r.invitacion_codigo,
      nombre: r.invitacion_nombre,
      texto: textoBeneficio({ tipo: r.invitacion_tipo, valor: r.invitacion_valor }),
    } : null,
  }));
}

/**
 * ¿Este teléfono ya es cliente de ESTE negocio? Devuelve {id, nombre} o null.
 * Nunca busca fuera del negocio: las bases de clientes no se cruzan, ni siquiera para reconocer
 * a alguien. El mismo número en dos negocios son dos personas distintas para la plataforma.
 */
async function clientePorTelefono(negocioId, numero) {
  const norm = tel.clave(String(numero || ''));
  if (!norm) return null;
  const { rows: [c] } = await pool.query(
    'SELECT id, nombre FROM contenido.cliente WHERE negocio_id=$1 AND telefono_norm=$2',
    [negocioId, norm]);
  return c || null;
}

// Identificar al cliente: si el teléfono ya existe en ESTE negocio se reusa, si no se crea.
// Nunca se busca fuera del negocio — las bases no se cruzan.
async function _resolverCliente(cli, negocioId, d) {
  if (d.cliente_id) {
    const { rows: [c] } = await cli.query(
      'SELECT id FROM contenido.cliente WHERE id=$1 AND negocio_id=$2', [d.cliente_id, negocioId]);
    if (!c) { const e = new Error('cliente ajeno'); e.code = 'cliente_invalido'; throw e; }
    return c.id;
  }
  const nombre = String(d.cliente_nombre || '').trim() || null;
  const numero = String(d.cliente_telefono || '').trim() || null;
  const norm = numero ? (tel.clave(numero) || null) : null;
  if (!nombre && !norm) { const e = new Error('sin cliente'); e.code = 'sin_cliente'; throw e; }
  if (norm) {
    const { rows: [c] } = await cli.query(
      'SELECT id FROM contenido.cliente WHERE negocio_id=$1 AND telefono_norm=$2', [negocioId, norm]);
    if (c) {
      if (nombre) await cli.query(
        'UPDATE contenido.cliente SET nombre=COALESCE(nombre,$2) WHERE id=$1', [c.id, nombre]);
      return c.id;
    }
  }
  // El consentimiento es SEPARADO de la reserva: reservar una mesa no es aceptar que te manden
  // publicidad. Sólo entra en true si la persona marcó la casilla.
  const { rows: [n] } = await cli.query(
    `INSERT INTO contenido.cliente (negocio_id, nombre, telefono, telefono_norm, email, origen, consentimiento)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [negocioId, nombre, numero, norm, String(d.cliente_email || '').trim().toLowerCase() || null,
     ['whatsapp','landing','agente'].includes(d.canal) ? d.canal : 'carga',
     d.consentimiento === true]);
  return n.id;
}

async function crearReserva(negocioId, d) {
  const cfg = await getConfigReservas(negocioId);
  const cantidad = +d.cantidad || 0;
  if (cantidad < cfg.cantidad_min) {
    const e = new Error('cantidad fuera de rango'); e.code = 'cantidad_fuera'; e.detalle = cfg; throw e;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha || '')) { const e = new Error('fecha'); e.code = 'fecha_invalida'; throw e; }

  // Una reserva creada por un agente externo entra como SOLICITADA, nunca confirmada, salvo que
  // el negocio active auto_confirmar. Es el principio de la plataforma —nada sale sin visto
  // humano— aplicado del lado operativo. Ver core/planes/V2.md.
  const canal = ['panel','whatsapp','landing','agente'].includes(d.canal) ? d.canal : 'panel';
  // Sólo lo que entra por el panel lo cargó una persona del negocio: eso se confirma solo. Todo
  // lo demás —cliente desde una landing, WhatsApp, agente externo— queda SOLICITADA salvo que el
  // negocio active auto_confirmar. Es la regla de la plataforma del lado operativo.
  // WhatsApp puede autoconfirmar por su cuenta, aunque la web no lo haga: ahí el teléfono lo
  // verificó Meta y la conversación la abrió el cliente, así que el negocio sabe a quién le está
  // confirmando. En la página pública cualquiera escribe cualquier cosa. Son riesgos distintos y
  // por eso son dos interruptores distintos.
  const autoCanal = canal === 'whatsapp' && (await getCanalWhatsapp(negocioId)).auto_confirmar;
  const estado = (canal === 'panel' || cfg.auto_confirmar || autoCanal) ? 'confirmada' : 'solicitada';

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    // El lock serializa las altas del MISMO turno y día. Sin esto, dos pedidos simultáneos leen
    // la misma ocupación, los dos concluyen que entran, y la mesa queda duplicada. Es exactamente
    // el modo de falla que separa este grupo del de comunicación.
    await cli.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`reserva|${negocioId}|${d.turno_id}|${d.fecha}`]);

    const { rows: [t] } = await cli.query(
      `SELECT id, nombre, capacidad, cantidad_max, dias, to_char(hora_desde,'HH24:MI') AS hora_desde,
              to_char(hora_hasta,'HH24:MI') AS hora_hasta, activo
         FROM contenido.turno WHERE id=$1 AND negocio_id=$2`, [d.turno_id, negocioId]);
    if (!t || !t.activo) { const e = new Error('turno'); e.code = 'turno_invalido'; throw e; }

    // El tope por reserva sale del turno si lo redefinió; si no, del general. Se valida acá y no
    // antes porque hasta no leer el turno no se sabe cuál de los dos manda.
    const topeEfectivo = t.cantidad_max || cfg.cantidad_max;
    if (cantidad > topeEfectivo) {
      const e = new Error('cantidad fuera de rango'); e.code = 'cantidad_fuera';
      e.detalle = { ...cfg, cantidad_max: topeEfectivo, turno: t.nombre,
                    propio: t.cantidad_max != null }; throw e;
    }

    // ¿El turno corre ese día de la semana?
    const { rows: [dw] } = await cli.query(`SELECT EXTRACT(isodow FROM $1::date)::int AS d`, [d.fecha]);
    if (!t.dias.includes(dw.d)) { const e = new Error('día'); e.code = 'turno_no_aplica'; throw e; }

    // La reserva es por turno completo, así que la anticipación se mide contra el INICIO del
    // turno. Es el mismo momento desde el que corre la tolerancia.
    const { rows: [v] } = await cli.query(
      `SELECT (($1::date + $2::time) AT TIME ZONE $3) AS cuando,
              now() + ($4 || ' hours')::interval AS piso,
              now() + ($5 || ' days')::interval  AS techo`,
      [d.fecha, t.hora_desde, TZ, String(cfg.anticipacion_min_horas), String(cfg.anticipacion_max_dias)]);
    if (v.cuando < v.piso) { const e = new Error('muy sobre la hora'); e.code = 'muy_pronto'; e.detalle = cfg; throw e; }
    if (v.cuando > v.techo) { const e = new Error('demasiado lejos'); e.code = 'muy_lejos'; e.detalle = cfg; throw e; }

    // Bloqueos: día entero o ese turno.
    const { rows: [b] } = await cli.query(
      `SELECT motivo FROM contenido.bloqueo
        WHERE negocio_id=$1 AND fecha=$2::date AND (turno_id IS NULL OR turno_id=$3) LIMIT 1`,
      [negocioId, d.fecha, d.turno_id]);
    if (b) { const e = new Error('bloqueado'); e.code = 'bloqueado'; e.detalle = b.motivo; throw e; }

    // Capacidad, ya bajo lock.
    const { rows: [o] } = await cli.query(
      `SELECT COALESCE(sum(cantidad),0)::int AS ocupado FROM contenido.reserva
        WHERE negocio_id=$1 AND turno_id=$2 AND fecha=$3::date
          AND estado IN ('solicitada','confirmada','cumplida')`,
      [negocioId, d.turno_id, d.fecha]);
    const libre = t.capacidad - o.ocupado;
    if (cantidad > libre) {
      const e = new Error('sin lugar'); e.code = 'sin_lugar';
      e.detalle = { capacidad: t.capacidad, ocupado: o.ocupado, libre }; throw e;
    }

    const clienteId = await _resolverCliente(cli, negocioId, d);
    const { rows: [r] } = await cli.query(
      `INSERT INTO contenido.reserva
         (negocio_id, cliente_id, turno_id, fecha, cantidad, estado, canal, agente_id, notas, ref_externa, link_id)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [negocioId, clienteId, d.turno_id, d.fecha, cantidad, estado, canal,
       String(d.agente_id || '').trim() || null, String(d.notas || '').trim() || null,
       String(d.ref_externa || '').trim() || null, d.link_id || null]);

    // La invitación se toma acá adentro: si la reserva se cae, el cupo no se gastó, y si la
    // invitación no entra, la reserva no queda hecha con un descuento que no existe.
    let invitacion = null;
    if (d.invitacion_codigo) {
      invitacion = await _tomarInvitacion(cli, negocioId, d.invitacion_codigo, {
        reservaId: r.id, clienteId, fecha: d.fecha, turnoId: d.turno_id, cantidad,
        telefonoNorm: d.cliente_telefono ? tel.clave(String(d.cliente_telefono)) : null,
      });
    }

    await cli.query('COMMIT');
    return { ok: true, id: r.id, estado, libre: libre - cantidad, invitacion };
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); }
}

const ESTADOS_RESERVA = ['solicitada','confirmada','cancelada','cumplida','no_show'];
async function cambiarEstadoReserva(negocioId, id, estado) {
  if (!ESTADOS_RESERVA.includes(estado)) { const e = new Error('estado'); e.code = 'estado_invalido'; throw e; }
  // Pasar de cancelada a activa devolvería lugar que quizá ya se dio: se rehace la reserva.
  const { rowCount } = await pool.query(
    `UPDATE contenido.reserva SET estado=$3 WHERE id=$1 AND negocio_id=$2
       AND NOT (estado='cancelada' AND $3 IN ('solicitada','confirmada'))`,
    [id, negocioId, estado]);

  if (rowCount) {
    // Cancelar devuelve la invitación al ruedo. Sin esto se la come en silencio y la persona se
    // queda sin nada. El no-show es distinto: ahí decide el beneficio si se libera o se quema.
    if (estado === 'cancelada') await liberarPorReserva(negocioId, id).catch(() => {});
    if (estado === 'no_show') {
      const u = await invitacionDeReserva(id);
      if (u && u.estado === 'tomada') {
        await cerrarUso(negocioId, u.uso_id,
          u.no_show === 'quemar' ? 'perdida' : 'liberada', 'no se presentó').catch(() => {});
      }
    }
  }
  return { ok: rowCount > 0 };
}

// --- Invitaciones (v2.0 / F6) --------------------------------------------------------------
// Repartir invitaciones con descuento y poder rastrear cada una. Tres piezas separadas:
// beneficio (QUÉ da) → invitación (EL CÓDIGO) → uso (QUÉ RESERVA lo tomó y si vino).
//
// LO QUE ESTA CAPACIDAD NO HACE: aplicar el descuento. ClaUsina no ve la factura. Emite,
// autoriza, avisa y mide; la cuenta la hace una persona en el mostrador.

const TIPOS_BENEFICIO = [
  { id: 'porcentaje',   label: '% de descuento',      sufijo: '%',  desc: 'Sobre el total de la cuenta' },
  { id: 'gratis_hasta', label: 'Sin cargo hasta',     sufijo: '',   desc: 'Invitación para N cubiertos' },
  { id: 'monto_fijo',   label: 'Monto fijo',          sufijo: '$',  desc: 'Se descuenta del total' },
];

/** Cómo se le dice a una persona lo que le tocó. Se usa igual en el panel, la web y WhatsApp. */
function textoBeneficio(b, unidad = 'personas') {
  if (!b) return '';
  const n = Number(b.valor);
  if (b.tipo === 'porcentaje')   return `${n % 1 ? n : n | 0}% de descuento`;
  if (b.tipo === 'monto_fijo')   return `$${(n | 0).toLocaleString('es-AR')} de descuento`;
  if (b.tipo === 'gratis_hasta') return `sin cargo hasta ${n | 0} ${unidad}`;
  return b.nombre || '';
}

async function getBeneficios(negocioId) {
  const { rows } = await pool.query(
    `SELECT b.*, gf.numero AS frente_numero, gf.nombre AS frente_titulo,
            (SELECT count(*)::int FROM contenido.invitacion i WHERE i.beneficio_id=b.id) AS invitaciones,
            (SELECT count(*)::int FROM contenido.invitacion_uso u
               WHERE u.invitacion_id IN (SELECT id FROM contenido.invitacion WHERE beneficio_id=b.id)
                 AND u.estado='consumida') AS consumidas
       FROM contenido.beneficio b
       LEFT JOIN contenido.grafica gf ON gf.id = b.frente_grafica_id
      WHERE b.negocio_id=$1 ORDER BY b.activo DESC, b.creado_en DESC`,
    [negocioId]);
  return rows.map(r => ({ ...r, frente: r.frente_numero ? codigoPieza('grafica', r.frente_numero) : null }));
}

/** Cómo el negocio llama a una pieza en su panel: G-0006, IG-0244. */
const PREFIJO_PIEZA = { grafica: 'G', instagram: 'IG', aviso: 'A', web: 'W' };
const codigoPieza = (canal, numero) =>
  `${PREFIJO_PIEZA[canal] || String(canal || '?').slice(0, 1).toUpperCase()}-${String(numero).padStart(4, '0')}`;

/**
 * El pase de un beneficio con datos de muestra, para verlo antes de emitir e imprimir.
 * Devuelve la misma forma que el pase real: si la muestra se armara distinto, mostraría bien
 * algo que después sale mal, que es justo lo que se quiere evitar.
 */
async function muestraBeneficio(negocioId, beneficioId) {
  const { rows: [b] } = await pool.query(
    `SELECT b.*, gf.numero AS frente_numero,
            gv.png_url AS frente_url, gf.ancho_mm AS frente_ancho, gf.alto_mm AS frente_alto,
            n.slug, n.nombre AS negocio, n.dominio_web, n.ig_handle,
            pp.logo, pp.logo_claro, COALESCE(ni.marca, '{}'::jsonb) AS marca
       FROM contenido.beneficio b
       JOIN contenido.negocios n ON n.id = b.negocio_id
       LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id = n.id
       LEFT JOIN contenido.negocio_identidad ni ON ni.negocio_id = n.id
       LEFT JOIN contenido.grafica gf ON gf.id = b.frente_grafica_id
       LEFT JOIN LATERAL (SELECT png_url FROM contenido.grafica_version x
                           WHERE x.grafica_id = gf.id AND x.estado='lista' AND x.png_url IS NOT NULL
                           ORDER BY x.nro DESC LIMIT 1) gv ON true
      WHERE b.id = $1 AND b.negocio_id = $2`, [beneficioId, negocioId]);
  if (!b) return null;
  const { rows: [sede] } = await pool.query(
    `SELECT direccion, localidad, partido FROM contenido.negocio_sede
      WHERE negocio_id=$1 ORDER BY principal DESC, orden LIMIT 1`, [negocioId]);
  const { rows: [w] } = await pool.query(
    `SELECT config->>'numero' AS n FROM contenido.negocio_capacidad
      WHERE negocio_id=$1 AND capacidad='whatsapp' AND habilitada`, [negocioId]);
  return {
    ok: true, muestra: true,
    // Un código que no existe y que se nota que no existe: nadie lo va a confundir con uno real.
    codigo: 'MUESTRA', texto: textoBeneficio(b), etiqueta: b.etiqueta || null,
    nombre: b.nombre, descripcion: b.descripcion || null,
    vence_en: null, usos_max: 1,
    condiciones: await condicionesLegibles(negocioId, b.condiciones),
    negocio: b.negocio, negocio_slug: b.slug,
    logo: b.logo, logo_claro: b.logo_claro, tema: b.tema || 'claro',
    marca: b.marca || {}, whatsapp: w ? w.n : null,
    web: b.dominio_web, instagram: b.ig_handle, sede: sede || null,
    frente: b.frente_url || null,
    frente_codigo: b.frente_numero ? codigoPieza('grafica', b.frente_numero) : null,
    frente_mm: b.frente_ancho ? [Math.round(b.frente_ancho), Math.round(b.frente_alto)] : null,
  };
}

async function guardarBeneficio(negocioId, id, d) {
  const nombre = String(d.nombre || '').trim().slice(0, 120);
  if (!nombre) { const e = new Error('nombre'); e.code = 'falta_nombre'; throw e; }
  if (!TIPOS_BENEFICIO.some(t => t.id === d.tipo)) { const e = new Error('tipo'); e.code = 'tipo_invalido'; throw e; }
  const valor = Number(d.valor);
  if (!Number.isFinite(valor) || valor <= 0) { const e = new Error('valor'); e.code = 'valor_invalido'; throw e; }
  // Un porcentaje mayor a 100 es siempre un error de carga, y regalarlo sin querer sale caro.
  if (d.tipo === 'porcentaje' && valor > 100) { const e = new Error('%'); e.code = 'valor_invalido'; throw e; }

  const cond = {
    dias: [...new Set((Array.isArray(d.dias) ? d.dias : []).map(Number).filter(n => n >= 1 && n <= 7))].sort(),
    turnos: (Array.isArray(d.turnos) ? d.turnos : []).filter(x => /^[0-9a-f-]{36}$/i.test(String(x))),
    cantidad_min: Number(d.cantidad_min) > 0 ? Math.round(Number(d.cantidad_min)) : null,
    cantidad_max: Number(d.cantidad_max) > 0 ? Math.round(Number(d.cantidad_max)) : null,
  };
  const noShow = ['liberar', 'quemar'].includes(d.no_show) ? d.no_show : 'liberar';
  const frente = /^[0-9a-f-]{36}$/i.test(String(d.frente_grafica_id || '')) ? d.frente_grafica_id : null;
  // Se imprime en la tarjeta: el tope es el que entra sin desarmar la pieza.
  const descripcion = String(d.descripcion || '').trim().slice(0, 400) || null;
  // Sobre qué base se dibuja la invitación. No sale del modo de la marca: una marca oscura no
  // implica querer imprimir en negro, y lo impreso se piensa sobre papel blanco.
  const tema = d.tema === 'oscuro' ? 'oscuro' : 'claro';
  const campos = [negocioId, nombre, d.tipo, valor, JSON.stringify(cond), noShow,
                  String(d.notas || '').trim().slice(0, 600) || null, d.activo !== false, frente, tema,
                  descripcion];
  if (id) {
    const { rows: [r] } = await pool.query(
      `UPDATE contenido.beneficio SET nombre=$2, tipo=$3, valor=$4, condiciones=$5::jsonb,
              no_show=$6, notas=$7, activo=$8, frente_grafica_id=$9, tema=$10, descripcion=$11,
              actualizado_en=now()
        WHERE id=$12 AND negocio_id=$1 RETURNING *`, [...campos, id]);
    if (!r) { const e = new Error('no existe'); e.code = 'no_encontrado'; throw e; }
    return r;
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.beneficio (negocio_id, nombre, tipo, valor, condiciones, no_show, notas,
       activo, frente_grafica_id, tema, descripcion)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *`, campos);
  return r;
}

/**
 * Emite N códigos de un beneficio. `etiquetas` nombra a quién va cada uno (una por línea); si hay
 * menos etiquetas que códigos, los que sobran quedan sin nombre — sirven para repartir en mano.
 */
async function emitirInvitaciones(negocioId, d) {
  const { rows: [b] } = await pool.query(
    'SELECT id, activo FROM contenido.beneficio WHERE id=$1 AND negocio_id=$2', [d.beneficio_id, negocioId]);
  if (!b) { const e = new Error('beneficio'); e.code = 'beneficio_invalido'; throw e; }

  const etiquetas = String(d.etiquetas || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 500);
  const cantidad = Math.max(1, Math.min(Number(d.cantidad) || etiquetas.length || 1, 500));
  const usosMax = Math.max(1, Math.min(Number(d.usos_max) || 1, 100000));
  const vence = /^\d{4}-\d{2}-\d{2}$/.test(d.vence_en || '') ? d.vence_en : null;
  // Una invitación que nace vencida no sirve para nada, y no avisar convierte un error de tipeo
  // en seis códigos inutilizables que nadie mira hasta que alguien los quiere usar. Se rechaza
  // acá y no sólo en la pantalla: el campo puede cambiar, la regla no.
  if (vence && vence < new Date().toISOString().slice(0, 10)) {
    const e = new Error('vencimiento en el pasado'); e.code = 'vence_pasado'; throw e;
  }

  const nuevas = [];
  for (let i = 0; i < cantidad; i++) {
    // El código es único en toda la plataforma. La colisión es rarísima pero no imposible, y la
    // base es la única que puede decidirlo sin una carrera: se reintenta contra su rechazo.
    let fila = null;
    for (let intento = 0; intento < 8 && !fila; intento++) {
      try {
        const { rows: [r] } = await pool.query(
          `INSERT INTO contenido.invitacion (negocio_id, beneficio_id, codigo, etiqueta, usos_max, vence_en)
           VALUES ($1,$2,$3,$4,$5,$6::date) RETURNING *`,
          [negocioId, d.beneficio_id, inv.generar(), etiquetas[i] || null, usosMax, vence]);
        fila = r;
      } catch (e) { if (e.code !== '23505') throw e; }   // 23505 = código repetido
    }
    if (!fila) { const e = new Error('no pude generar un código libre'); e.code = 'sin_codigo'; throw e; }
    nuevas.push(fila);
  }
  return nuevas;
}

async function getInvitaciones(negocioId, { beneficio_id } = {}) {
  const params = [negocioId];
  let filtro = '';
  if (beneficio_id) { params.push(beneficio_id); filtro = ' AND i.beneficio_id=$2'; }
  const { rows } = await pool.query(
    `SELECT i.*, b.nombre AS beneficio, b.tipo, b.valor, b.no_show,
            (SELECT count(*)::int FROM contenido.invitacion_uso u
              WHERE u.invitacion_id=i.id AND u.estado='consumida') AS consumidas,
            (SELECT max(u.tomada_en) FROM contenido.invitacion_uso u WHERE u.invitacion_id=i.id) AS ultimo_uso
       FROM contenido.invitacion i JOIN contenido.beneficio b ON b.id=i.beneficio_id
      WHERE i.negocio_id=$1${filtro} ORDER BY i.creado_en DESC LIMIT 500`, params);
  return rows.map(r => ({ ...r, estado: estadoInvitacion(r) }));
}

/** El estado no se guarda: se deriva. Guardarlo obliga a acordarse de moverlo y se desincroniza. */
function estadoInvitacion(i) {
  if (i.anulada_en) return 'anulada';
  if (i.vence_en && new Date(i.vence_en) < new Date(new Date().toISOString().slice(0, 10))) return 'vencida';
  if (i.usos >= i.usos_max) return 'agotada';
  return i.usos > 0 ? 'en_uso' : 'activa';
}

async function anularInvitacion(negocioId, id) {
  const { rowCount } = await pool.query(
    'UPDATE contenido.invitacion SET anulada_en=now() WHERE id=$1 AND negocio_id=$2 AND anulada_en IS NULL',
    [id, negocioId]);
  return { ok: rowCount > 0 };
}

const MOTIVOS = {
  forma:     'Ese código no es válido. Fijate si lo copiaste completo.',
  no_existe: 'No encuentro ese código.',
  anulada:   'Esa invitación fue dada de baja.',
  vencida:   'Esa invitación ya venció.',
  agotada:   'Esa invitación ya se usó.',
  inactivo:  'Esa invitación ya no está disponible.',
  ajena:     'Esa invitación ya está en uso por otra persona.',
  repetida:  'Esa invitación ya la usaste.',
  dia:       'Esa invitación no aplica al día que elegiste.',
  turno:     'Esa invitación no aplica a ese turno.',
  cantidad:  'Esa invitación no aplica para esa cantidad.',
};

/**
 * Mira un código sin tomarlo. Es lo que se usa para mostrar QUÉ da antes de pedir nada más:
 * validar recién al final, después de que la persona cargó todo, es la peor versión posible.
 */
/**
 * ¿Esta persona ya usó esta invitación? Una invitación de campaña puede tener 100 usos y aun así
 * no puede valer 100 veces para la misma persona: el cupo es de cuánta gente entra, no de cuántas
 * veces vuelve la misma. Para las de un uso ya lo cubre `usos_max`; esto es para las multiuso.
 * Un uso liberado (la reserva se canceló) no cuenta: ahí no llegó a usarla.
 */
async function _yaUsada(q, invitacionId, clienteId) {
  if (!clienteId) return false;
  const { rows } = await q.query(
    `SELECT 1 FROM contenido.invitacion_uso
      WHERE invitacion_id=$1 AND cliente_id=$2 AND estado <> 'liberada' LIMIT 1`,
    [invitacionId, clienteId]);
  return rows.length > 0;
}

async function consultarInvitacion(codigo, negocioId = null, telefono = null) {
  const c = inv.limpiar(codigo);
  if (!inv.formaValida(c)) return { ok: false, motivo: 'forma', mensaje: MOTIVOS.forma };
  const { rows: [i] } = await pool.query(
    `SELECT i.*, b.nombre AS beneficio, b.descripcion AS beneficio_descripcion,
            b.tipo, b.valor, b.condiciones, b.activo AS beneficio_activo, b.tema,
            n.slug AS negocio_slug, n.nombre AS negocio_nombre,
            -- El frente impreso lo define el beneficio: toda la campaña sale con el mismo.
            gv.png_url AS frente_url, gf.numero AS frente_numero,
            gf.ancho_mm AS frente_ancho, gf.alto_mm AS frente_alto
       FROM contenido.invitacion i
       JOIN contenido.beneficio b ON b.id=i.beneficio_id
       JOIN contenido.negocios n ON n.id=i.negocio_id
       LEFT JOIN contenido.grafica gf ON gf.id = b.frente_grafica_id
       LEFT JOIN LATERAL (SELECT png_url FROM contenido.grafica_version x
                           WHERE x.grafica_id = gf.id AND x.estado='lista' AND x.png_url IS NOT NULL
                           ORDER BY x.nro DESC LIMIT 1) gv ON true
      WHERE i.codigo=$1`, [c]);
  if (!i) return { ok: false, motivo: 'no_existe', mensaje: MOTIVOS.no_existe };
  if (negocioId && i.negocio_id !== negocioId) return { ok: false, motivo: 'no_existe', mensaje: MOTIVOS.no_existe };

  const est = estadoInvitacion(i);
  if (est === 'anulada') return { ok: false, motivo: 'anulada', mensaje: MOTIVOS.anulada };
  if (est === 'vencida') return { ok: false, motivo: 'vencida', mensaje: MOTIVOS.vencida };
  if (est === 'agotada') return { ok: false, motivo: 'agotada', mensaje: MOTIVOS.agotada };
  if (!i.beneficio_activo) return { ok: false, motivo: 'inactivo', mensaje: MOTIVOS.inactivo };
  // Con el teléfono a mano se avisa acá, al tomar el código, y no al final de la reserva: que
  // falle recién al confirmar deja a la persona con la sensación de haber perdido el tiempo.
  if (telefono) {
    const cli = await clientePorTelefono(i.negocio_id, telefono);
    if (cli && await _yaUsada(pool, i.id, cli.id))
      return { ok: false, motivo: 'repetida', mensaje: MOTIVOS.repetida };
  }
  return { ok: true, invitacion: i, texto: textoBeneficio(i) };
}

/**
 * Las condiciones como las tiene que leer un invitado, CRUZADAS CON LA AGENDA REAL.
 *
 * Dos correcciones sobre decir simplemente lo que guarda el beneficio:
 *
 * 1. Los días se intersectan con los días en que esos turnos realmente corren. Una invitación
 *    "lunes a viernes, turno Noche" decía viernes, y el turno Noche no corre los viernes: el
 *    invitado leía un día en el que después no lo iban a dejar reservar.
 * 2. No se nombran los turnos, se dice la franja. "Noche F. Semana T2" es una clave interna del
 *    negocio; al invitado le sirve "Noche", y elegir el turno exacto es un tema de la reserva.
 */
/**
 * Piezas ya PUBLICADAS del negocio, para usar de frente de una invitación impresa. Sólo las
 * publicadas: lo que todavía está en la cola es material de trabajo y no sale de acá.
 */
async function piezasPublicadas(negocioId) {
  const { rows } = await pool.query(
    `SELECT g.id, g.numero, g.nombre, g.formato, g.ancho_mm, g.alto_mm, v.png_url
       FROM contenido.grafica g
       JOIN LATERAL (SELECT png_url FROM contenido.grafica_version x
                      WHERE x.grafica_id = g.id AND x.estado = 'lista' AND x.png_url IS NOT NULL
                      ORDER BY x.nro DESC LIMIT 1) v ON true
      WHERE g.negocio_id = $1 ORDER BY g.actualizado_en DESC LIMIT 60`, [negocioId]);
  return rows.map(r => ({
    id: r.id, codigo: codigoPieza('grafica', r.numero),
    titulo: r.nombre || 'sin nombre', url: r.png_url,
    // El formato y las medidas se muestran porque importan: una pieza pensada para un afiche
    // estirada a A6 se ve mal, y elegirla a ciegas se descubre recién con la tirada impresa.
    formato: r.formato || null,
    medidas: r.ancho_mm && r.alto_mm ? `${Math.round(r.ancho_mm)}×${Math.round(r.alto_mm)}mm` : null,
  }));
}

async function condicionesLegibles(negocioId, cond) {
  const c = cond || {};
  const { rows: turnos } = await pool.query(
    `SELECT id, dias, EXTRACT(hour FROM hora_desde)::int AS hora
       FROM contenido.turno WHERE negocio_id=$1 AND activo`, [negocioId]);

  // Los turnos que la invitación admite: los que nombra, o todos si no nombra ninguno.
  const admitidos = (c.turnos || []).length
    ? turnos.filter(t => c.turnos.includes(t.id)) : turnos;

  // La franja sale de la hora y no del nombre: los nombres los escribe cada negocio como quiere.
  const franjas = [...new Set(admitidos.map(t => (t.hora < 17 ? 'Mediodía' : 'Noche')))]
    .sort((a, b) => (a === 'Mediodía' ? -1 : 1));

  // Días en que ALGUNO de esos turnos corre de verdad, cruzado con los días de la invitación.
  const corren = new Set(admitidos.flatMap(t => t.dias || []));
  const dias = ((c.dias || []).length ? c.dias.filter(x => corren.has(x)) : [...corren]).sort();

  return { dias, franjas, turno_ids: admitidos.map(t => t.id),
           cantidad_min: c.cantidad_min || null, cantidad_max: c.cantidad_max || null,
           // Las frases se arman acá y no en cada pantalla: la tarjeta impresa, la página y el
           // bot tienen que decir lo mismo, y "sólo al noche" escrito tres veces se corrige una.
           frases: frasesCondicion(dias, franjas, c) };
}

// Dos listas y no una con .replace(/s$/): "viernes" es invariable y quitarle la s da "vierne".
// Sólo sábado y domingo cambian de número, así que la regla no existe — hay que escribirlas.
const DIA_PLURAL   = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];
const DIA_SINGULAR = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
// "al mediodía" pero "a la noche": la preposición cambia con el género y no hay forma de
// escribirla una sola vez para las dos.
const FRANJA_FRASE = { 'Mediodía': 'al mediodía', 'Noche': 'a la noche' };

function frasesCondicion(dias, franjas, c) {
  const f = [];
  // Días y turno en una sola oración: "Válida de lunes a viernes, al mediodía". Antes el turno
  // sólo se nombraba cuando había uno solo, así que una invitación de mediodía Y noche no decía
  // nada del horario y había que preguntarlo en el mostrador.
  let cuando = '';
  if (dias.length && dias.length < 7) {
    // Días corridos se dicen "de lunes a viernes"; sueltos, enumerados. Una tarjeta impresa con
    // "lunes, martes, miércoles, jueves, viernes" se lee peor y ocupa dos renglones.
    const corrido = dias.every((d, i) => i === 0 || d === dias[i - 1] + 1);
    cuando = corrido && dias.length > 2
      ? `de ${DIA_SINGULAR[dias[0]]} a ${DIA_SINGULAR[dias[dias.length - 1]]}`
      : dias.map(d => DIA_PLURAL[d]).join(', ');
  } else if (dias.length === 7) cuando = 'todos los días';
  const horario = franjas.length === 1 ? FRANJA_FRASE[franjas[0]]
    : (franjas.length > 1 ? franjas.map(x => FRANJA_FRASE[x]).join(' y ') : '');
  const partes = [cuando, horario].filter(Boolean);
  if (partes.length) f.push('Válida ' + partes.join(', '));
  if (c.cantidad_min) f.push('Desde ' + c.cantidad_min + ' personas');
  if (c.cantidad_max) f.push('Hasta ' + c.cantidad_max + ' personas');
  return f;
}

/** Las condiciones del beneficio contra la reserva concreta. Devuelve el motivo, o null si entra. */
function chocaCondicion(cond, { fecha, turnoId, cantidad, isodow }) {
  const c = cond || {};
  if ((c.dias || []).length && !c.dias.includes(isodow)) return 'dia';
  if ((c.turnos || []).length && !c.turnos.includes(turnoId)) return 'turno';
  if (c.cantidad_min && cantidad < c.cantidad_min) return 'cantidad';
  if (c.cantidad_max && cantidad > c.cantidad_max) return 'cantidad';
  return null;
}

/**
 * Toma la invitación DENTRO de la transacción de la reserva. Es lo único que garantiza que no
 * queden reservas con un descuento que nunca se descontó del cupo, ni cupos gastados por reservas
 * que la base terminó rechazando.
 *
 * El FOR UPDATE serializa a dos personas peleando el último uso de un código compartido — el
 * mismo problema que la capacidad del turno, y se resuelve igual.
 */
async function _tomarInvitacion(cli, negocioId, codigo, { reservaId, clienteId, fecha, turnoId, cantidad, telefonoNorm }) {
  const c = inv.limpiar(codigo);
  if (!inv.formaValida(c)) { const e = new Error('código'); e.code = 'inv_forma'; throw e; }

  const { rows: [i] } = await cli.query(
    `SELECT i.*, b.condiciones, b.activo AS beneficio_activo, b.nombre AS beneficio, b.tipo, b.valor
       FROM contenido.invitacion i JOIN contenido.beneficio b ON b.id=i.beneficio_id
      WHERE i.codigo=$1 AND i.negocio_id=$2 FOR UPDATE OF i`, [c, negocioId]);
  if (!i) { const e = new Error('código'); e.code = 'inv_no_existe'; throw e; }

  const est = estadoInvitacion(i);
  if (est === 'anulada') { const e = new Error('anulada'); e.code = 'inv_anulada'; throw e; }
  if (est === 'vencida') { const e = new Error('vencida'); e.code = 'inv_vencida'; throw e; }
  if (est === 'agotada') { const e = new Error('agotada'); e.code = 'inv_agotada'; throw e; }
  if (!i.beneficio_activo) { const e = new Error('inactivo'); e.code = 'inv_inactivo'; throw e; }

  // El primero que la usa se la queda. Reenviarla deja de servir después del primer canje, sin
  // pedirle a nadie que se identifique de antemano. Sólo aplica a las personales.
  if (i.usos_max === 1 && i.telefono_norm && telefonoNorm && i.telefono_norm !== telefonoNorm) {
    const e = new Error('ajena'); e.code = 'inv_ajena'; throw e;
  }

  // El chequeo que manda: acá adentro de la transacción, con la invitación bloqueada. El de
  // `consultarInvitacion` es sólo para avisar antes; dos reservas a la vez lo pasarían las dos.
  if (await _yaUsada(cli, i.id, clienteId)) { const e = new Error('repetida'); e.code = 'inv_repetida'; throw e; }

  const { rows: [dw] } = await cli.query('SELECT EXTRACT(isodow FROM $1::date)::int AS d', [fecha]);
  const choca = chocaCondicion(i.condiciones, { fecha, turnoId, cantidad, isodow: dw.d });
  if (choca) { const e = new Error(choca); e.code = 'inv_' + choca; throw e; }

  await cli.query(
    `INSERT INTO contenido.invitacion_uso (invitacion_id, negocio_id, reserva_id, cliente_id)
     VALUES ($1,$2,$3,$4)`, [i.id, negocioId, reservaId, clienteId || null]);
  await cli.query(
    `UPDATE contenido.invitacion SET usos = usos + 1,
            telefono_norm = COALESCE(telefono_norm, $2) WHERE id=$1`,
    [i.id, telefonoNorm || null]);
  return { id: i.id, codigo: c, beneficio: i.beneficio, tipo: i.tipo, valor: i.valor,
           texto: textoBeneficio(i) };
}

/**
 * Cierra un uso. `consumida` la marca una persona del salón cuando la aplicó de verdad.
 * `liberada` devuelve el cupo; `perdida` lo gasta. Cuál de las dos aplica ante un no-show lo
 * decide el beneficio, porque depende del tipo de invitación (decisión de Fer).
 */
async function cerrarUso(negocioId, usoId, estado, notas) {
  if (!['consumida', 'liberada', 'perdida'].includes(estado)) {
    const e = new Error('estado'); e.code = 'estado_invalido'; throw e;
  }
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [u] } = await cli.query(
      `SELECT * FROM contenido.invitacion_uso WHERE id=$1 AND negocio_id=$2 FOR UPDATE`,
      [usoId, negocioId]);
    if (!u) { await cli.query('ROLLBACK'); return { ok: false, error: 'no_encontrado' }; }
    if (u.estado !== 'tomada') { await cli.query('ROLLBACK'); return { ok: false, error: 'ya_cerrado' }; }

    await cli.query(
      `UPDATE contenido.invitacion_uso SET estado=$2, cerrada_en=now(),
              notas=COALESCE($3, notas) WHERE id=$1`, [usoId, estado, notas || null]);
    // Sólo liberar devuelve el cupo. Consumir y perder lo gastan, que es la diferencia entre las
    // dos políticas de no-show.
    if (estado === 'liberada') {
      await cli.query('UPDATE contenido.invitacion SET usos = GREATEST(0, usos - 1) WHERE id=$1',
        [u.invitacion_id]);
    }
    await cli.query('COMMIT');
    return { ok: true };
  } catch (e) { await cli.query('ROLLBACK'); throw e; }
  finally { cli.release(); }
}

/**
 * Al cancelar una reserva su invitación vuelve al ruedo. Sin esto, cancelar una reserva se come
 * la invitación en silencio y la persona se queda sin nada.
 */
async function liberarPorReserva(negocioId, reservaId) {
  const { rows: [u] } = await pool.query(
    `SELECT id FROM contenido.invitacion_uso
      WHERE reserva_id=$1 AND negocio_id=$2 AND estado='tomada'`, [reservaId, negocioId]);
  if (!u) return { ok: false };
  return await cerrarUso(negocioId, u.id, 'liberada', 'la reserva se canceló');
}

/** La invitación de una reserva, para mostrarla en el detalle y en la lista del día. */
// Los datos de UNA reserva, tal como los dibuja la tarjeta que se le manda al cliente. No se
// reusa getReservas porque eso trae el teléfono y el mail: acá se arma una imagen que va a
// terminar reenviada a un grupo, y nada que no esté en la tarjeta tiene por qué salir del panel.
// Pedir la tarjeta de una reserva. Que falle no puede voltear la reserva ni la confirmación por
// texto: la imagen es un extra, y una reserva tomada sin tarjeta es una reserva tomada.
async function pedirTarjeta(negocioId, reservaId, waId) {
  try {
    await pool.query(
      `INSERT INTO contenido.tarjeta_req (reserva_id, negocio_id, wa_id)
       VALUES ($1,$2,$3) ON CONFLICT (reserva_id) DO NOTHING`, [reservaId, negocioId, String(waId)]);
  } catch (e) { console.error('pedir tarjeta', e.message); }
}

async function reservaTarjeta(negocioId, reservaId) {
  const { rows: [r] } = await pool.query(
    `SELECT r.id, r.fecha::text, r.cantidad, r.estado,
            -- El nombre interno es una clave del negocio ("Noche F. Semana T2"): hacia el
            -- cliente va siempre el público, igual que en el chat y en la página de reservas.
            COALESCE(t.nombre_publico, t.nombre) AS turno, to_char(t.hora_desde,'HH24:MI') AS hora_desde,
            c.nombre AS cliente,
            nc.config AS cfg_reservas,
            pp.logo, pp.logo_claro, p.nombre AS negocio, p.dominio_web, p.ig_handle,
            COALESCE(ni.marca, '{}'::jsonb) AS marca,
            i.codigo AS invitacion_codigo, b.tipo AS invitacion_tipo, b.valor AS invitacion_valor,
            -- La tarjeta de una reserva CON invitación tiene que verse como la invitación que la
            -- persona ya tiene en la mano: mismo tema, mismos colores. Sin invitación es una
            -- pieza de marca y va sobre el fondo del negocio.
            b.tema AS invitacion_tema
       FROM contenido.reserva r
       JOIN contenido.turno t ON t.id = r.turno_id
       JOIN contenido.cliente c ON c.id = r.cliente_id
       JOIN contenido.negocios p ON p.id = r.negocio_id
       LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id = p.id
       LEFT JOIN contenido.negocio_identidad ni ON ni.negocio_id = p.id
       LEFT JOIN contenido.negocio_capacidad nc ON nc.negocio_id = p.id AND nc.capacidad = 'reservas'
       LEFT JOIN contenido.invitacion_uso iu ON iu.reserva_id = r.id
       LEFT JOIN contenido.invitacion i ON i.id = iu.invitacion_id
       LEFT JOIN contenido.beneficio b ON b.id = i.beneficio_id
      WHERE r.id = $1 AND r.negocio_id = $2`, [reservaId, negocioId]);
  if (!r) return null;
  const { rows: [sede] } = await pool.query(
    `SELECT direccion, localidad FROM contenido.negocio_sede
      WHERE negocio_id=$1 ORDER BY principal DESC, orden LIMIT 1`, [negocioId]);
  const unidad = UNIDADES.find(u => u.id === ((r.cfg_reservas || {}).unidad || CFG_RESERVAS.unidad)) || UNIDADES[0];
  return {
    ok: true, id: r.id, estado: r.estado, fecha: r.fecha, turno: r.turno, hora_desde: r.hora_desde,
    cantidad: r.cantidad, unidad: r.cantidad === 1 ? unidad.sing : unidad.plur,
    cliente: r.cliente, negocio: r.negocio,
    // Con invitación manda el beneficio; sin invitación, el mismo default que los beneficios.
    // Que dos reservas del mismo negocio salgan de distinto color según si hubo descuento se lee
    // como un error, no como una decisión.
    tema: r.invitacion_tema || 'claro',
    // Cada variante para el fondo que le toca. Elegir mal es un logo invisible, no un error.
    logo: r.logo || null, logo_claro: r.logo_claro || null,
    marca: r.marca || {}, sede: sede || null,
    web: r.dominio_web || null, instagram: r.ig_handle || null,
    invitacion: r.invitacion_codigo
      ? { codigo: r.invitacion_codigo, texto: textoBeneficio({ tipo: r.invitacion_tipo, valor: r.invitacion_valor }) }
      : null,
  };
}

async function invitacionDeReserva(reservaId) {
  const { rows: [r] } = await pool.query(
    `SELECT u.id AS uso_id, u.estado, i.codigo, b.nombre AS beneficio, b.tipo, b.valor, b.no_show
       FROM contenido.invitacion_uso u
       JOIN contenido.invitacion i ON i.id=u.invitacion_id
       JOIN contenido.beneficio b ON b.id=i.beneficio_id
      WHERE u.reserva_id=$1`, [reservaId]);
  return r ? { ...r, texto: textoBeneficio(r) } : null;
}

/**
 * Canje en el mostrador: alguien llega con el código en la mano y NO hay reserva. Es el caso del
 * público de paso —el mediodía express, donde nadie reserva un sandwich— y el que justifica los
 * códigos reutilizables repartidos en un folleto o publicados en la pantalla de la esquina.
 *
 * Va directo a `consumida`: acá no hay dos momentos que separar. La persona está parada frente a
 * quien la carga, así que tomar y consumir pasan a la vez.
 */
async function canjearEnMostrador(negocioId, codigo, d = {}) {
  const c = inv.limpiar(codigo);
  if (!inv.formaValida(c)) return { ok: false, motivo: 'forma', mensaje: MOTIVOS.forma };
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [i] } = await cli.query(
      `SELECT i.*, b.nombre AS beneficio, b.tipo, b.valor, b.activo AS beneficio_activo
         FROM contenido.invitacion i JOIN contenido.beneficio b ON b.id=i.beneficio_id
        WHERE i.codigo=$1 AND i.negocio_id=$2 FOR UPDATE OF i`, [c, negocioId]);
    if (!i) { await cli.query('ROLLBACK'); return { ok: false, motivo: 'no_existe', mensaje: MOTIVOS.no_existe }; }
    const est = estadoInvitacion(i);
    if (est === 'anulada') { await cli.query('ROLLBACK'); return { ok: false, motivo: 'anulada', mensaje: MOTIVOS.anulada }; }
    if (est === 'vencida') { await cli.query('ROLLBACK'); return { ok: false, motivo: 'vencida', mensaje: MOTIVOS.vencida }; }
    if (est === 'agotada') { await cli.query('ROLLBACK'); return { ok: false, motivo: 'agotada', mensaje: MOTIVOS.agotada }; }
    if (!i.beneficio_activo) { await cli.query('ROLLBACK'); return { ok: false, motivo: 'inactivo', mensaje: MOTIVOS.inactivo }; }

    const { rows: [u] } = await cli.query(
      `INSERT INTO contenido.invitacion_uso (invitacion_id, negocio_id, canal, estado, cerrada_en, notas)
       VALUES ($1,$2,'mostrador','consumida', now(), $3) RETURNING id`,
      [i.id, negocioId, String(d.notas || '').trim() || null]);
    await cli.query('UPDATE contenido.invitacion SET usos = usos + 1 WHERE id=$1', [i.id]);
    await cli.query('COMMIT');
    return { ok: true, uso_id: u.id, codigo: c, beneficio: i.beneficio, texto: textoBeneficio(i),
             restantes: Math.max(0, i.usos_max - (i.usos + 1)) };
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}

// --- Skills: las instrucciones de los agentes (v2.0) ---------------------------------------
// La DB es la fuente de verdad y el archivo .md del disco es una copia derivada, igual que la
// credencial de n8n. Se editan en el panel; al guardar se pide la regeneración y un worker del
// host reescribe ~/.claude/skills/<slug>/SKILL.md — el panel corre en un contenedor y no llega
// a ese disco.

async function getSkills() {
  const { rows } = await pool.query(
    `SELECT s.slug, s.nombre, s.descripcion, s.activo, s.actualizado_en,
            length(s.contenido_md) AS largo, u.nombre AS por
       FROM contenido.skill s LEFT JOIN contenido.usuario u ON u.id = s.actualizado_por
      ORDER BY s.slug`);
  return rows;
}

async function getSkill(slug) {
  const { rows: [r] } = await pool.query('SELECT * FROM contenido.skill WHERE slug=$1', [slug]);
  return r || null;
}

/**
 * Guarda un skill. Con la misma red que el brief: un recorte brusco no se acepta en silencio y
 * la versión anterior queda archivada. Son textos largos escritos a mano; perderlos duele igual.
 */
async function guardarSkill(slug, d, usuarioId, confirmado) {
  const { rows: [prev] } = await pool.query('SELECT contenido_md FROM contenido.skill WHERE slug=$1', [slug]);
  if (!prev) { const e = new Error('no existe'); e.code = 'no_encontrado'; throw e; }
  const viejo = prev.contenido_md || '';
  const nuevo = String(d.contenido_md == null ? viejo : d.contenido_md);
  const perdidos = viejo.length - nuevo.length;
  if (!confirmado && perdidos >= RECORTE_MIN_CHARS && nuevo.length < viejo.length * RECORTE_PROPORCION) {
    const e = new Error('recorte'); e.code = 'recorte_grande';
    e.detalle = { campo: 'skill', largo_actual: viejo.length, largo_nuevo: nuevo.length, perdidos };
    throw e;
  }
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    if (viejo && viejo !== nuevo) {
      await cli.query(
        'INSERT INTO contenido.skill_hist (slug, contenido, largo, usuario_id) VALUES ($1,$2,$3,$4)',
        [slug, viejo, viejo.length, usuarioId || null]);
    }
    await cli.query(
      `UPDATE contenido.skill SET nombre=COALESCE($2,nombre), descripcion=COALESCE($3,descripcion),
              contenido_md=$4, activo=COALESCE($5,activo), actualizado_en=now(), actualizado_por=$6
        WHERE slug=$1`,
      [slug, d.nombre || null, d.descripcion || null, nuevo,
       typeof d.activo === 'boolean' ? d.activo : null, usuarioId || null]);
    // El pedido va DENTRO de la transacción: si el guardado falla, no se regenera un archivo con
    // un contenido que no quedó guardado.
    await cli.query('INSERT INTO contenido.skill_sync_req (slug) VALUES ($1)', [slug]);
    await cli.query('COMMIT');
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
  return { ok: true };
}

async function getSkillHistorial(slug) {
  const { rows } = await pool.query(
    `SELECT h.id, h.largo, h.guardado_en, u.nombre AS usuario
       FROM contenido.skill_hist h LEFT JOIN contenido.usuario u ON u.id=h.usuario_id
      WHERE h.slug=$1 ORDER BY h.guardado_en DESC LIMIT 20`, [slug]);
  return rows;
}
async function getSkillVersion(id) {
  const { rows: [r] } = await pool.query(
    'SELECT slug, contenido, largo, guardado_en FROM contenido.skill_hist WHERE id=$1', [id]);
  return r || null;
}

// --- Campañas (v2.0 / F7) ------------------------------------------------------------------
// Una campaña agrupa acciones de marketing con un objetivo, una ventana y un público. Las
// acciones no son entidades nuevas: apuntan a lo que ya existe. Ver core/planes/CAMPANIAS.md.

const OBJETIVOS_CAMPANIA = [
  { id: 'clientes_nuevos', label: 'Clientes nuevos', desc: 'gente que nunca vino' },
  { id: 'reservas',        label: 'Reservas',        desc: 'volumen de reservas en la ventana' },
  { id: 'visitas',         label: 'Visitas',         desc: 'reservas que se cumplieron' },
  { id: 'alcance',         label: 'Alcance',         desc: 'que la conozcan; sin conversión directa' },
];
const TIPOS_ACCION = [
  { id: 'invitaciones', label: 'Invitaciones',   desc: 'códigos con un beneficio', campo: 'beneficio_id' },
  { id: 'instagram',    label: 'Publicación',    desc: 'una pieza del feed',       campo: 'pieza_id' },
  { id: 'pantalla',     label: 'Aviso en pantalla', desc: 'la pantalla de calle',  campo: 'pieza_id' },
  { id: 'impreso',      label: 'Impreso',        desc: 'folleto, afiche, tarjeta', campo: 'grafica_id' },
  { id: 'pauta',        label: 'Pauta',          desc: 'publicidad paga en Meta',  campo: 'pauta_id' },
  { id: 'link',         label: 'Link medible',   desc: 'un enlace propio con seguimiento', campo: 'link_id' },
  { id: 'otra',         label: 'Otra',           desc: 'algo que no entra en las anteriores', campo: null },
];

/**
 * Pide al creativo que proponga las acciones. El momento es con la campaña en BORRADOR y sin
 * acciones: después, el creativo llega tarde a opinar sobre algo ya decidido.
 * Nunca crea nada — deja sugerencias para aceptar de a una.
 */
async function pedirPropuestaCampania(negocioId, campaniaId, instruccion, opts = {}) {
  const { rows: [c] } = await pool.query(
    'SELECT id FROM contenido.campania WHERE id=$1 AND negocio_id=$2', [campaniaId, negocioId]);
  if (!c) return { ok: false, error: 'no_existe' };
  // Una iteración parte de la propuesta anterior: pedir "otra" desde cero tira las acciones que
  // sí estaban bien, y una propuesta de siete donde molestan dos no se corrige tirándola.
  // Se itera sobre el último PLAN, no sobre la fila de acciones: lo que se discute en esta etapa
  // es la estrategia. Vale también si ya estaba aprobado — cambiar de idea es legítimo; lo que
  // sale es un plan nuevo que hay que volver a aprobar.
  const previa = opts.iterar ? await _ultimoPlan(negocioId, campaniaId) : null;
  if (opts.iterar && (!previa || !['lista', 'aprobada'].includes(previa.estado)))
    return { ok: false, error: 'sin_previa' };
  const texto = String(instruccion || '').trim();
  if (opts.iterar && !texto) return { ok: false, error: 'sin_instruccion' };
  try {
    const { rows: [p] } = await pool.query(
      `INSERT INTO contenido.campania_propuesta (campania_id, instruccion, previa_id, sobre_accion, nro)
       VALUES ($1,$2,$3,$4,
         (SELECT COALESCE(max(nro),0)+1 FROM contenido.campania_propuesta WHERE campania_id=$1))
       RETURNING id, nro`,
      [campaniaId, texto || null, previa ? previa.id : null,
       Number.isInteger(opts.sobre_accion) ? opts.sobre_accion : null]);
    return { ok: true, id: p.id, nro: p.nro };
  } catch (e) {
    // El único parcial impide dos en curso: pedir de nuevo mientras una corre gasta el doble.
    if (e.code === '23505') return { ok: false, error: 'ya_en_curso' };
    throw e;
  }
}

async function _ultimoPlan(negocioId, campaniaId) {
  const { rows: [p] } = await pool.query(
    `SELECT pr.* FROM contenido.campania_propuesta pr JOIN contenido.campania c ON c.id=pr.campania_id
      WHERE pr.campania_id=$1 AND c.negocio_id=$2 AND pr.fase='plan'
      ORDER BY pr.creado_en DESC LIMIT 1`, [campaniaId, negocioId]);
  return p || null;
}

/** Las iteraciones de una campaña, para poder volver a una anterior. */
async function getPropuestasCampania(negocioId, campaniaId) {
  const { rows } = await pool.query(
    `SELECT pr.id, pr.nro, pr.estado, pr.instruccion, pr.sobre_accion, pr.creado_en,
            jsonb_array_length(pr.acciones) AS acciones
       FROM contenido.campania_propuesta pr JOIN contenido.campania c ON c.id=pr.campania_id
      WHERE pr.campania_id=$1 AND c.negocio_id=$2 ORDER BY pr.nro DESC`, [campaniaId, negocioId]);
  return rows;
}

/**
 * El estado del circuito completo: el último plan y, si ya se aprobó, la bajada a acciones que
 * salió de ÉL. La pantalla necesita las dos cosas juntas para saber en qué paso está.
 */
async function getEstadoPropuesta(negocioId, campaniaId) {
  const plan = await _ultimoPlan(negocioId, campaniaId);
  if (!plan) return { plan: null, acc: null };
  const { rows: [acc] } = await pool.query(
    `SELECT * FROM contenido.campania_propuesta
      WHERE campania_id=$1 AND fase='acciones' AND previa_id=$2 ORDER BY creado_en DESC LIMIT 1`,
    [campaniaId, plan.id]);
  return { plan, acc: acc || null };
}

/** La última propuesta de una campaña, con su estado. */
async function getPropuestaCampania(negocioId, campaniaId) {
  const { rows: [p] } = await pool.query(
    `SELECT pr.* FROM contenido.campania_propuesta pr
       JOIN contenido.campania c ON c.id = pr.campania_id
      WHERE pr.campania_id=$1 AND c.negocio_id=$2 ORDER BY pr.creado_en DESC LIMIT 1`,
    [campaniaId, negocioId]);
  return p || null;
}

/**
 * Guarda el plan editado a mano. El texto del creativo queda aparte (resumen_original): saber qué
 * escribió él y qué corrigió el negocio es la mitad del valor de dejarlo editar.
 */
async function guardarResumenPropuesta(negocioId, campaniaId, propuestaId, texto) {
  const t = String(texto || '').trim();
  if (!t) return { ok: false, error: 'vacio' };
  const { rows: [p] } = await pool.query(
    `SELECT pr.id, pr.estado, pr.fase, pr.resumen, pr.resumen_original
       FROM contenido.campania_propuesta pr JOIN contenido.campania c ON c.id=pr.campania_id
      WHERE pr.id=$1 AND pr.campania_id=$2 AND c.negocio_id=$3`, [propuestaId, campaniaId, negocioId]);
  if (!p) return { ok: false, error: 'no_existe' };
  // Editar un plan ya aprobado no cambiaría las acciones que salieron de él: sería mentir sobre
  // qué se acordó. Para eso se pide una versión nueva.
  if (p.estado !== 'lista' || p.fase !== 'plan') return { ok: false, error: 'no_editable' };
  await pool.query(
    `UPDATE contenido.campania_propuesta
        SET resumen=$2, resumen_original=COALESCE(resumen_original, resumen) WHERE id=$1`,
    [propuestaId, t]);
  return { ok: true };
}

/**
 * Aprueba el plan y recién ahí manda a bajarlo a acciones. Las acciones salen del texto APROBADO
 * —editado o no—: es lo que hace que editarlo sirva de algo.
 */
async function aprobarPropuesta(negocioId, campaniaId, propuestaId) {
  const { rows: [p] } = await pool.query(
    `SELECT pr.id, pr.estado, pr.fase, pr.resumen
       FROM contenido.campania_propuesta pr JOIN contenido.campania c ON c.id=pr.campania_id
      WHERE pr.id=$1 AND pr.campania_id=$2 AND c.negocio_id=$3`, [propuestaId, campaniaId, negocioId]);
  if (!p) return { ok: false, error: 'no_existe' };
  // Vale también sobre un plan ya aprobado: es el camino de "reintentar" cuando la bajada a
  // acciones falló, y el de las propuestas viejas que nacieron aprobadas sin fila de acciones.
  if (p.fase !== 'plan' || !['lista', 'aprobada'].includes(p.estado)) return { ok: false, error: 'no_aprobable' };
  const { rows: [ya] } = await pool.query(
    `SELECT id FROM contenido.campania_propuesta
      WHERE previa_id=$1 AND fase='acciones' AND estado IN ('pendiente','procesando','aprobada') LIMIT 1`,
    [propuestaId]);
  if (ya) return { ok: false, error: 'ya_en_curso' };
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await cl.query(
      `UPDATE contenido.campania_propuesta SET estado='aprobada',
              aprobado_en=COALESCE(aprobado_en, now()) WHERE id=$1`, [propuestaId]);
    // El plan aprobado viaja copiado en la fila de acciones: es el enunciado con el que el
    // creativo tiene que trabajar, y queda congelado aunque después se pida otra versión.
    const { rows: [a] } = await cl.query(
      `INSERT INTO contenido.campania_propuesta (campania_id, previa_id, fase, resumen, nro)
       VALUES ($1,$2,'acciones',$3,
         (SELECT COALESCE(max(nro),0)+1 FROM contenido.campania_propuesta WHERE campania_id=$1))
       RETURNING id, nro`, [campaniaId, propuestaId, p.resumen || '']);
    await cl.query('COMMIT');
    return { ok: true, id: a.id, nro: a.nro };
  } catch (e) {
    await cl.query('ROLLBACK');
    if (e.code === '23505') return { ok: false, error: 'ya_en_curso' };
    throw e;
  } finally { cl.release(); }
}

/**
 * Baja las acciones sugeridas a borradores, todas juntas. Antes se aceptaban de a una; con el plan
 * ya aprobado eso es un trámite: lo que se revisa acción por acción es el contenido, y para eso
 * hay que poder editarlas. Es idempotente: si ya se materializaron, no duplica.
 */
async function materializarPropuesta(negocioId, campaniaId, propuestaId) {
  const { rows: [p] } = await pool.query(
    `SELECT pr.id, pr.acciones, pr.fase
       FROM contenido.campania_propuesta pr JOIN contenido.campania c ON c.id=pr.campania_id
      WHERE pr.id=$1 AND pr.campania_id=$2 AND c.negocio_id=$3`, [propuestaId, campaniaId, negocioId]);
  if (!p || p.fase !== 'acciones') return { ok: false, error: 'no_existe' };
  const { rows: [y] } = await pool.query(
    'SELECT count(*)::int AS n FROM contenido.campania_accion WHERE propuesta_id=$1', [propuestaId]);
  if (y.n > 0) return { ok: true, creadas: 0 };
  let creadas = 0;
  for (let i = 0; i < (p.acciones || []).length; i++) {
    const r = await _crearAccionDesdeSugerencia(campaniaId, propuestaId, (p.acciones || [])[i]);
    if (r) creadas++;
  }
  return { ok: true, creadas };
}

async function _crearAccionDesdeSugerencia(campaniaId, propuestaId, sug) {
  if (!sug) return null;
  const tipo = TIPOS_ACCION.some(t => t.id === sug.tipo) ? sug.tipo : 'otra';
  const notas = [sug.publico ? `Público: ${sug.publico}` : '', sug.por_que || '',
                 sug.como_se_mide ? `Medición: ${sug.como_se_mide}` : '',
                 sug.cuando ? `Cuándo: ${sug.cuando}` : '',
                 sug.hay_que_crear && sug.enganche ? `Hay que crear: ${sug.enganche}` : '']
                .filter(Boolean).join('\n');
  const { rows: [a] } = await pool.query(
    `INSERT INTO contenido.campania_accion (campania_id, tipo, nombre, notas, propuesta_id, estado, orden)
     VALUES ($1,$2,$3,$4,$5,'borrador',(SELECT COALESCE(max(orden),0)+1 FROM contenido.campania_accion WHERE campania_id=$1))
     RETURNING *`,
    [campaniaId, tipo, String(sug.nombre || 'Acción').slice(0, 160), notas || null, propuestaId]);
  return a;
}

/**
 * Acepta UNA acción sugerida. Se crea sin enganche: la sugerencia dice a qué debería colgarse,
 * pero atarla automáticamente por coincidencia de nombre es la clase de adivinanza que después
 * mide mal. La persona elige el objeto al editar la acción.
 */
async function aceptarSugerencia(negocioId, campaniaId, propuestaId, indice) {
  const p = await getPropuestaCampania(negocioId, campaniaId);
  if (!p || p.id !== propuestaId) return { ok: false, error: 'no_existe' };
  const a = await _crearAccionDesdeSugerencia(campaniaId, propuestaId, (p.acciones || [])[indice]);
  if (!a) return { ok: false, error: 'no_existe' };
  return { ok: true, accion: a };
}

async function getCampanias(negocioId) {
  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT count(*)::int FROM contenido.campania_accion a WHERE a.campania_id=c.id) AS acciones,
            -- El estado de la última propuesta viaja con la lista: sin esto hay que entrar a cada
            -- campaña para saber si el creativo está trabajando o si dejó algo para revisar.
            (SELECT p.estado FROM contenido.campania_propuesta p
              WHERE p.campania_id=c.id ORDER BY p.creado_en DESC LIMIT 1) AS propuesta_estado
       FROM contenido.campania c WHERE c.negocio_id=$1 ORDER BY c.desde DESC, c.creado_en DESC`,
    [negocioId]);
  return rows;
}

async function getCampania(negocioId, id) {
  const { rows: [c] } = await pool.query(
    'SELECT * FROM contenido.campania WHERE id=$1 AND negocio_id=$2', [id, negocioId]);
  if (!c) return null;
  // Cada acción se muestra con el nombre de lo que apunta: una lista de acciones que dice
  // "invitaciones" cinco veces no sirve para nada.
  const { rows: acciones } = await pool.query(
    `SELECT a.*,
            b.nombre AS beneficio_nombre, b.tipo AS beneficio_tipo, b.valor AS beneficio_valor,
            g.nombre AS grafica_nombre, g.numero AS grafica_numero,
            p.titulo_interno AS pieza_nombre, p.numero AS pieza_numero, p.canal AS pieza_canal,
            pc.nombre AS pauta_nombre,
            l.etiqueta AS link_etiqueta, l.token AS link_token
       FROM contenido.campania_accion a
       LEFT JOIN contenido.beneficio b ON b.id = a.beneficio_id
       LEFT JOIN contenido.grafica g ON g.id = a.grafica_id
       LEFT JOIN contenido.piezas p ON p.id = a.pieza_id
       LEFT JOIN contenido.pauta_campania pc ON pc.id = a.pauta_id
       LEFT JOIN contenido.accion_link l ON l.id = a.link_id
      WHERE a.campania_id=$1 ORDER BY a.orden, a.creado_en`, [id]);
  return { ...c, acciones };
}

async function guardarCampania(negocioId, id, d) {
  const nombre = String(d.nombre || '').trim().slice(0, 160);
  if (!nombre) { const e = new Error('nombre'); e.code = 'falta_nombre'; throw e; }
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(d.desde || '') ? d.desde : null;
  if (!desde) { const e = new Error('desde'); e.code = 'falta_desde'; throw e; }
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(d.hasta || '') ? d.hasta : null;
  if (hasta && hasta < desde) { const e = new Error('ventana'); e.code = 'ventana_invalida'; throw e; }
  const objetivo_tipo = OBJETIVOS_CAMPANIA.some(o => o.id === d.objetivo_tipo) ? d.objetivo_tipo : 'clientes_nuevos';
  const meta = Number(d.meta_valor) > 0 ? Number(d.meta_valor) : null;
  const presu = Number(d.presupuesto) > 0 ? Number(d.presupuesto) : null;
  const campos = [negocioId, nombre, String(d.objetivo || '').trim() || null, objetivo_tipo, meta,
                  desde, hasta, String(d.publico || '').trim() || null, presu,
                  String(d.notas || '').trim() || null];
  if (id) {
    const { rows: [r] } = await pool.query(
      `UPDATE contenido.campania SET nombre=$2, objetivo=$3, objetivo_tipo=$4, meta_valor=$5,
              desde=$6, hasta=$7, publico=$8, presupuesto=$9, notas=$10, actualizado_en=now()
        WHERE id=$11 AND negocio_id=$1 RETURNING *`, [...campos, id]);
    if (!r) { const e = new Error('no existe'); e.code = 'no_encontrado'; throw e; }
    return { ok: true, campania: r };
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.campania (negocio_id, nombre, objetivo, objetivo_tipo, meta_valor,
                                     desde, hasta, publico, presupuesto, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, campos);
  return { ok: true, campania: r };
}

async function estadoCampania(negocioId, id, estado) {
  if (!['borrador','activa','pausada','cerrada'].includes(estado)) {
    const e = new Error('estado'); e.code = 'estado_invalido'; throw e;
  }
  const { rowCount } = await pool.query(
    'UPDATE contenido.campania SET estado=$3, actualizado_en=now() WHERE id=$1 AND negocio_id=$2',
    [id, negocioId, estado]);
  return { ok: rowCount > 0 };
}

/**
 * Agrega o edita una acción. La referencia se escribe SÓLO en la columna que corresponde al
 * tipo: mandar un beneficio en una acción de tipo 'impreso' es un error de quien llama, y
 * guardarlo igual dejaría una acción que no se puede medir por ningún lado.
 */
async function guardarAccion(negocioId, campaniaId, id, d) {
  const { rows: [c] } = await pool.query(
    'SELECT id FROM contenido.campania WHERE id=$1 AND negocio_id=$2', [campaniaId, negocioId]);
  if (!c) { const e = new Error('campaña'); e.code = 'no_encontrado'; throw e; }
  const t = TIPOS_ACCION.find(x => x.id === d.tipo);
  if (!t) { const e = new Error('tipo'); e.code = 'tipo_invalido'; throw e; }
  const nombre = String(d.nombre || '').trim().slice(0, 160);
  if (!nombre) { const e = new Error('nombre'); e.code = 'falta_nombre'; throw e; }

  const refs = { pieza_id: null, grafica_id: null, beneficio_id: null, pauta_id: null, link_id: null };
  const eng = ENGANCHES.find(x => x.id === d.enganche)
           || ENGANCHES.find(x => x.id === ENGANCHE_POR_TIPO[t.id]);
  if (eng && /^[0-9a-f-]{36}$/i.test(String(d.ref || ''))) refs[eng.campo] = d.ref;
  // Un campo vacío es "no lo sé", no cero: Number('') da 0 y el costo previsto quedaba en $0.
  const num = v => (v === '' || v === null || v === undefined ? null
                    : (Number(v) >= 0 ? Number(v) : null));
  // Lo que el formulario no manda NO se pisa: el UPDATE escribía todas las columnas, así que
  // editar el nombre de una acción borraba las notas del creativo —el porqué, el público, cómo se
  // mide— y le ponía orden 0. Un campo ausente es "no lo toqués", no "vaciámelo".
  let prev = {};
  if (id) {
    const { rows: [x] } = await pool.query(
      'SELECT * FROM contenido.campania_accion WHERE id=$1 AND campania_id=$2', [id, campaniaId]);
    if (!x) { const e = new Error('no existe'); e.code = 'no_encontrado'; throw e; }
    prev = x;
  }
  const dado = (k, v) => (d[k] === undefined ? (prev[k] === undefined ? null : prev[k]) : v);
  // Una acción nueva va al final de la lista; una que se edita conserva su lugar.
  const orden = d.orden !== undefined ? (Number(d.orden) || 0)
    : (id ? (prev.orden || 0)
          : (await pool.query('SELECT COALESCE(max(orden),0)+1 AS n FROM contenido.campania_accion WHERE campania_id=$1',
                              [campaniaId])).rows[0].n);
  const campos = [campaniaId, t.id, nombre, ['borrador','planificada','activa','terminada','descartada'].includes(d.estado) ? d.estado : 'borrador',
                  orden, refs.pieza_id, refs.grafica_id, refs.beneficio_id, refs.pauta_id, refs.link_id,
                  dado('costo_previsto', num(d.costo_previsto)), dado('costo_real', num(d.costo_real)),
                  dado('costo_nota', String(d.costo_nota || '').trim() || null),
                  dado('volumen_declarado', num(d.volumen_declarado)),
                  dado('notas', String(d.notas || '').trim() || null)];
  if (id) {
    const { rows: [r] } = await pool.query(
      `UPDATE contenido.campania_accion SET tipo=$2, nombre=$3, estado=$4, orden=$5,
              pieza_id=$6, grafica_id=$7, beneficio_id=$8, pauta_id=$9, link_id=$10,
              costo_previsto=$11, costo_real=$12, costo_nota=$13, volumen_declarado=$14,
              notas=$15, actualizado_en=now()
        WHERE id=$16 AND campania_id=$1 RETURNING *`, [...campos, id]);
    if (!r) { const e = new Error('no existe'); e.code = 'no_encontrado'; throw e; }
    return { ok: true, accion: r };
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.campania_accion (campania_id, tipo, nombre, estado, orden,
       pieza_id, grafica_id, beneficio_id, pauta_id, link_id,
       costo_previsto, costo_real, costo_nota, volumen_declarado, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, campos);
  return { ok: true, accion: r };
}

async function confirmarAccion(negocioId, campaniaId, id) {
  const { rows: [a] } = await pool.query(
    `SELECT a.* FROM contenido.campania_accion a JOIN contenido.campania c ON c.id=a.campania_id
      WHERE a.id=$1 AND a.campania_id=$2 AND c.negocio_id=$3`, [id, campaniaId, negocioId]);
  if (!a) return { ok: false, error: 'no_existe' };
  // Vale cualquier enganche, no sólo el que sugiere el tipo: un impreso colgado del beneficio que
  // reparte está mejor medido que colgado de la pieza gráfica.
  const enganchada = ENGANCHES.some(e => !!a[e.campo]);
  if (!enganchada) return { ok: false, error: 'sin_enganche' };
  await pool.query(
    "UPDATE contenido.campania_accion SET estado='planificada', actualizado_en=now() WHERE id=$1", [id]);
  return { ok: true };
}

async function borrarAccion(negocioId, campaniaId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM contenido.campania_accion a USING contenido.campania c
      WHERE a.id=$3 AND a.campania_id=$1 AND c.id=a.campania_id AND c.negocio_id=$2`,
    [campaniaId, negocioId, id]);
  return { ok: rowCount > 0 };
}

/** Lo que se puede colgar de una acción, según el tipo. Sale de lo que el negocio YA tiene. */
/**
 * A qué se puede colgar una acción. El tipo de acción sugiere uno, pero no lo impone: un impreso
 * puede engancharse al BENEFICIO que reparte —que es lo medible— y no a la pieza gráfica. Antes
 * el enganche salía del tipo y no había forma de elegir otra cosa.
 */
const ENGANCHES = [
  { id: 'beneficio', label: 'Beneficio de invitación', campo: 'beneficio_id',
    desc: 'se mide por los códigos que se canjean' },
  { id: 'grafica',   label: 'Pieza gráfica',      campo: 'grafica_id',
    desc: 'folleto, afiche o tarjeta de Gráfica' },
  { id: 'instagram', label: 'Publicación de Instagram', campo: 'pieza_id',
    desc: 'una pieza del feed' },
  { id: 'pantalla',  label: 'Aviso en pantalla',  campo: 'pieza_id',
    desc: 'un aviso de la pantalla de calle' },
  { id: 'pauta',     label: 'Campaña de Meta',    campo: 'pauta_id',
    desc: 'publicidad paga, con su propio reporte' },
  { id: 'link',      label: 'Link medible',       campo: 'link_id',
    desc: 'un enlace propio con seguimiento' },
];
/** El enganche que se propone según el tipo de acción. Es una sugerencia, no una regla. */
const ENGANCHE_POR_TIPO = { invitaciones: 'beneficio', impreso: 'grafica', instagram: 'instagram',
                            pantalla: 'pantalla', pauta: 'pauta', link: 'link', otra: 'beneficio' };

async function opcionesAccion(negocioId, clase) {
  // Se aceptan los dos vocabularios: el del enganche y, por compatibilidad, el del tipo de acción.
  const tipo = ({ beneficio: 'invitaciones', grafica: 'impreso' })[clase] || clase;
  if (tipo === 'invitaciones') {
    const { rows } = await pool.query(
      'SELECT id, nombre, tipo, valor FROM contenido.beneficio WHERE negocio_id=$1 AND activo ORDER BY creado_en DESC', [negocioId]);
    return rows.map(r => ({ id: r.id, label: `${r.nombre} — ${textoBeneficio(r)}` }));
  }
  if (tipo === 'impreso') {
    const { rows } = await pool.query(
      "SELECT id, numero, nombre FROM contenido.grafica WHERE negocio_id=$1 AND estado <> 'descartada' ORDER BY numero DESC", [negocioId]);
    return rows.map(r => ({ id: r.id, label: `${codigoPieza('grafica', r.numero)} · ${r.nombre}` }));
  }
  if (tipo === 'instagram' || tipo === 'pantalla') {
    const canal = tipo === 'instagram' ? 'instagram' : 'aviso';
    const { rows } = await pool.query(
      `SELECT id, numero, titulo_interno FROM contenido.piezas
        WHERE negocio_id=$1 AND canal=$2 AND estado <> 'descartada' ORDER BY creado_en DESC LIMIT 60`, [negocioId, canal]);
    return rows.map(r => ({ id: r.id, label: `${codigoPieza(canal, r.numero)} · ${r.titulo_interno || 'sin título'}` }));
  }
  if (tipo === 'pauta') {
    const { rows } = await pool.query(
      'SELECT id, nombre FROM contenido.pauta_campania WHERE negocio_id=$1 ORDER BY creado_en DESC', [negocioId]);
    return rows.map(r => ({ id: r.id, label: r.nombre }));
  }
  if (tipo === 'link') {
    const { rows } = await pool.query(
      'SELECT id, etiqueta, token FROM contenido.accion_link WHERE negocio_id=$1 AND activo ORDER BY creado_en DESC', [negocioId]);
    return rows.map(r => ({ id: r.id, label: `${r.etiqueta || 'link'} (/a/${r.token})` }));
  }
  return [];
}

// --- El canal de WhatsApp como producto (v2.0 / F5f) --------------------------------------
// El número deja de ser una configuración técnica: el negocio decide cómo saluda el bot y qué
// operaciones ofrece. Lo que no encaja en ninguna operación cae en el inbox, para que lo lea
// una persona — un cliente que pregunta algo distinto no puede quedar sin respuesta.

// Qué puede ofrecer el bot hoy. Se amplía a medida que haya capacidades conversacionales:
// la lista NO es "todas las capacidades del negocio", es "las que el bot sabe atender".
const CAPS_BOT = [
  { id: 'reservas', label: 'Reservar', desc: 'Tomar una reserva paso a paso' },
];

const CFG_CANAL = {
  saludo: '',            // vacío = se arma uno con el nombre del negocio
  ofrece: ['reservas'],
  inbox: true,           // guardar lo que no encaja para que lo lea una persona
  auto_confirmar: false, // confirmar en el acto lo que entra por este canal
  faq: [],               // [{p, r}] — respuestas que el negocio escribió y el bot repite TAL CUAL
};

// Todo lo que la plataforma sabe del negocio, en texto plano. Es la materia prima de los
// borradores: si un dato no está acá, la respuesta va a quedar vacía, y eso es lo correcto.
const DIAS_ISO = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
async function fichaNegocio(negocioId) {
  const [perfil, ident, turnos, cfgRes, caps] = await Promise.all([
    getPerfil(negocioId), getIdentidad(negocioId), getTurnos(negocioId),
    getConfigReservas(negocioId), getCapacidades(negocioId),
  ]);
  const i = ident.identidad || {};
  const L = [];
  const poner = (k, v) => { if (v != null && String(v).trim() !== '') L.push(`${k}: ${v}`); };

  poner('Nombre', perfil.nombre);
  poner('Rubro', i.actividad_nombre);
  poner('Slogan', perfil.slogan);
  poner('Sitio web', perfil.dominio_web);
  poner('Instagram', perfil.ig_handle);
  poner('Atributos', (i.atributos || []).join(', '));
  poner('Ticket promedio', i.ticket_min != null || i.ticket_max != null
    ? `${i.ticket_min ?? '?'} a ${i.ticket_max ?? '?'} por ${i.ticket_unidad || 'persona'}` : null);

  for (const s of ident.sedes || []) {
    poner('Dirección', [s.direccion, s.localidad, s.partido, s.provincia].filter(Boolean).join(', '));
    poner('Teléfono', s.telefono);
  }

  if (turnos.length) {
    L.push('Horarios de atención (turnos con reserva):');
    for (const t of turnos.filter(t => t.activo !== false)) {
      L.push(`  - ${t.nombre_publico || t.nombre}: ${t.hora_desde} a ${t.hora_hasta}, ` +
             `${(t.dias || []).map(d => DIAS_ISO[d]).filter(Boolean).join(', ')}`);
    }
    L.push('OJO: estos son los turnos que aceptan reserva. NO son necesariamente el horario ' +
           'completo del local; si te preguntan por el horario general, no lo deduzcas de acá.');
  }
  if ((caps || []).some(c => c.id === 'reservas' && c.habilitada)) {
    poner('Reservas', `sí, hasta ${cfgRes.cantidad_max} ${cfgRes.unidad} por reserva, ` +
      `con ${cfgRes.anticipacion_min_horas} h de anticipación mínima y hasta ` +
      `${cfgRes.anticipacion_max_dias} días antes. Tolerancia ${cfgRes.tolerancia_min} min.`);
  }
  // El brief es lo más rico que hay del negocio y lo escribió una persona: va entero al final.
  if (perfil.brief_md) L.push('\nBrief del negocio:\n' + String(perfil.brief_md).slice(0, 6000));
  return L.join('\n');
}

async function getCanalWhatsapp(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT config, actualizado_en FROM contenido.negocio_capacidad
      WHERE negocio_id=$1 AND capacidad='whatsapp'`, [negocioId]);
  const cfg = { ...CFG_CANAL, ...((r && r.config) || {}) };
  // Cuándo se guardó por última vez. La pantalla lo devuelve al guardar y así se detecta si
  // alguien más tocó la config mientras estaba abierta.
  cfg.actualizado_en = (r && r.actualizado_en) ? r.actualizado_en.toISOString() : null;
  // Sólo se ofrece lo que el bot sabe hacer Y el negocio tiene habilitado.
  const { rows: caps } = await pool.query(
    `SELECT capacidad FROM contenido.negocio_capacidad
      WHERE negocio_id=$1 AND habilitada`, [negocioId]);
  const tiene = new Set(caps.map(c => c.capacidad));
  cfg.ofrece = (cfg.ofrece || []).filter(x => CAPS_BOT.some(c => c.id === x) && tiene.has(x));
  return cfg;
}

async function guardarCanalWhatsapp(negocioId, d) {
  const actual = await getCanalWhatsapp(negocioId);

  // Guarda contra el pisón silencioso: la pantalla carga la config UNA vez y guarda todo el
  // objeto. Si en el medio la cambió otro —otra pestaña, otra persona, o la propia plataforma—
  // guardar desde una pantalla vieja borra lo que no estaba cuando se abrió. Pasó de verdad:
  // se cargó una respuesta frecuente desde afuera con el panel abierto.
  if (d.visto_en && actual.actualizado_en && d.visto_en !== actual.actualizado_en) {
    return { ok: false, error: 'desactualizado', config: actual };
  }

  // actualizado_en es dato de la fila, no de la config: si entrara al spread quedaría guardado
  // dentro del jsonb y contaminaría la comparación de la próxima vez.
  const { actualizado_en, ...base } = actual;
  const cfg = {
    ...base,
    saludo: String(d.saludo || '').trim().slice(0, 600),
    ofrece: [...new Set((Array.isArray(d.ofrece) ? d.ofrece : [])
      .filter(x => CAPS_BOT.some(c => c.id === x)))],
    inbox: d.inbox !== false,
    auto_confirmar: !!d.auto_confirmar,
    // Se guarda lo que escribió el negocio, recortado pero sin reescribir: el bot va a repetir
    // esto palabra por palabra, así que lo que se guarda es exactamente lo que va a salir.
    faq: (Array.isArray(d.faq) ? d.faq : [])
      .map(f => ({ p: String((f && f.p) || '').trim().slice(0, 200),
                   r: String((f && f.r) || '').trim().slice(0, 700) }))
      .filter(f => f.p && f.r)
      .slice(0, 40),
  };
  await pool.query(
    `INSERT INTO contenido.negocio_capacidad (negocio_id, capacidad, habilitada, config, actualizado_en)
     VALUES ($1,'whatsapp',
             COALESCE((SELECT habilitada FROM contenido.negocio_capacidad
                        WHERE negocio_id=$1 AND capacidad='whatsapp'), false),
             $2::jsonb, now())
     ON CONFLICT (negocio_id, capacidad) DO UPDATE SET config=$2::jsonb, actualizado_en=now()`,
    [negocioId, JSON.stringify(cfg)]);
  return { ok: true, config: await getCanalWhatsapp(negocioId) };
}

// --- Inbox --------------------------------------------------------------------------------
// Conversaciones del negocio, con lo pendiente arriba. La ventana de 24 h importa: pasada, no se
// puede contestar libre y hay que decirlo antes de que alguien escriba una respuesta que no sale.
async function getInbox(negocioId) {
  const { rows } = await pool.query(
    `SELECT m.wa_id,
            max(m.creado_en) AS ultimo,
            max(m.creado_en) FILTER (WHERE m.direccion='entrante') AS ultimo_entrante,
            count(*) FILTER (WHERE m.direccion='entrante' AND NOT m.atendido)::int AS pendientes,
            (array_agg(m.texto ORDER BY m.creado_en DESC) FILTER (WHERE m.texto IS NOT NULL))[1] AS ultimo_texto,
            (SELECT c.nombre FROM contenido.cliente c
              WHERE c.negocio_id=$1 AND c.telefono_norm = right(regexp_replace(m.wa_id,'\D','','g'), 10)
              LIMIT 1) AS cliente
       FROM contenido.whatsapp_mensaje m
      WHERE m.negocio_id=$1
      GROUP BY m.wa_id
      ORDER BY max(m.creado_en) DESC
      LIMIT 100`, [negocioId]);
  return rows.map(r => ({
    ...r,
    // La ventana la abre el cliente al escribir y dura 24 h. Fuera de ella sólo van plantillas.
    ventana_abierta: !!r.ultimo_entrante && (Date.now() - new Date(r.ultimo_entrante).getTime()) < 24 * 3600e3,
  }));
}

async function getConversacionInbox(negocioId, waId) {
  const { rows } = await pool.query(
    `SELECT id, direccion, tipo, texto, estado, atendido, creado_en
       FROM contenido.whatsapp_mensaje
      WHERE negocio_id=$1 AND wa_id=$2
      ORDER BY creado_en LIMIT 200`, [negocioId, waId]);
  return rows;
}

async function marcarAtendido(negocioId, waId) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.whatsapp_mensaje SET atendido=true
      WHERE negocio_id=$1 AND wa_id=$2 AND direccion='entrante' AND NOT atendido`,
    [negocioId, waId]);
  return { ok: true, marcados: rowCount };
}

// --- Conversación de reserva por WhatsApp (v2.0 / F5e) ------------------------------------
// Cada mensaje de WhatsApp llega solo, sin memoria. Armar una reserva lleva varios turnos de
// conversación, así que hay que recordar dónde quedó cada cliente.
const CONV_MINUTOS = 30;

async function getConversacion(negocioId, waId) {
  const { rows: [r] } = await pool.query(
    `SELECT paso, datos, actualizado_en FROM contenido.wa_conversacion
      WHERE negocio_id=$1 AND wa_id=$2
        AND actualizado_en > now() - ($3 || ' minutes')::interval`,
    [negocioId, waId, String(CONV_MINUTOS)]);
  return r || null;
}

async function setConversacion(negocioId, waId, paso, datos) {
  await pool.query(
    `INSERT INTO contenido.wa_conversacion (negocio_id, wa_id, paso, datos, actualizado_en)
     VALUES ($1,$2,$3,COALESCE($4::jsonb,'{}'::jsonb), now())
     ON CONFLICT (negocio_id, wa_id) DO UPDATE
       SET paso=$3, datos=COALESCE($4::jsonb,'{}'::jsonb), actualizado_en=now()`,
    [negocioId, waId, paso, datos ? JSON.stringify(datos) : null]);
}

async function borrarConversacion(negocioId, waId) {
  await pool.query('DELETE FROM contenido.wa_conversacion WHERE negocio_id=$1 AND wa_id=$2',
    [negocioId, waId]);
}

// Poda: una conversación vieja no se retoma, se empieza de nuevo. Sin esto la tabla sólo crece,
// que es la lección del sqlite de n8n.
async function podarConversaciones() {
  const { rowCount } = await pool.query(
    `DELETE FROM contenido.wa_conversacion WHERE actualizado_en < now() - interval '1 day'`);
  return rowCount;
}

// ¿Este negocio puede tomar reservas por WhatsApp? Las mismas condiciones que la página pública:
// capacidad habilitada y abierta al público. Un canal más no es una puerta trasera.
/** ¿Este negocio tiene invitaciones vivas? Si no, no tiene sentido preguntar por un código. */
async function invitacionesActivas(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT 1 FROM contenido.negocio_capacidad c
       JOIN contenido.beneficio b ON b.negocio_id=c.negocio_id AND b.activo
      WHERE c.negocio_id=$1 AND c.capacidad='invitaciones' AND c.habilitada LIMIT 1`, [negocioId]);
  return !!r;
}

async function reservasPorWhatsapp(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT habilitada, config FROM contenido.negocio_capacidad
      WHERE negocio_id=$1 AND capacidad='reservas'`, [negocioId]);
  return !!(r && r.habilitada && (r.config || {}).publico);
}

// --- WhatsApp propio del negocio (v2.0 / F5d) ---------------------------------------------
// El número con el que el negocio le habla a SUS clientes. El de ClaUsina queda para hablar con
// el operador. Ver core/planes/WHATSAPP.md.

async function getWhatsappNegocio(negocioId, conToken = false) {
  const { rows: [r] } = await pool.query(
    `SELECT wa_phone_id, wa_waba_id, (wa_token_enc IS NOT NULL) AS token_set, wa_token_enc,
            (wa_app_secret_enc IS NOT NULL) AS secret_set
       FROM contenido.negocio_perfil WHERE negocio_id=$1`, [negocioId]);
  if (!r) return null;
  const out = { wa_phone_id: r.wa_phone_id, wa_waba_id: r.wa_waba_id, token_set: r.token_set,
                secret_set: r.secret_set };
  // El token sólo sale de acá cuando lo pide el motor para usarlo; nunca hacia el navegador.
  if (conToken && r.wa_token_enc) {
    try { out.token = cryptoAds.decrypt(r.wa_token_enc); } catch (e) { out.token = null; }
  }
  return out;
}

async function guardarWhatsappNegocio(negocioId, d) {
  const nn = s => (s != null && String(s).trim() !== '') ? String(s).trim() : null;
  const tok = nn(d.wa_token), sec = nn(d.wa_app_secret);
  let enc = null, secEnc = null;
  if (tok || sec) {
    if (!cryptoAds.hasKey()) { const e = new Error('APP_ENC_KEY no configurada'); e.code = 'no_enc_key'; throw e; }
    if (tok) enc = cryptoAds.encrypt(tok);
    if (sec) secEnc = cryptoAds.encrypt(sec);
  }
  await pool.query(
    `INSERT INTO contenido.negocio_perfil (negocio_id, wa_phone_id, wa_waba_id, actualizado_en)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (negocio_id) DO UPDATE SET wa_phone_id=$2, wa_waba_id=$3, actualizado_en=now()`,
    [negocioId, nn(d.wa_phone_id), nn(d.wa_waba_id)]);
  // Vacío = no se toca: si no, editar el id borraría el token sin querer.
  if (enc) await pool.query(
    'UPDATE contenido.negocio_perfil SET wa_token_enc=$2 WHERE negocio_id=$1', [negocioId, enc]);
  if (secEnc) await pool.query(
    'UPDATE contenido.negocio_perfil SET wa_app_secret_enc=$2 WHERE negocio_id=$1', [negocioId, secEnc]);
  if (d.borrar_token === true) await pool.query(
    'UPDATE contenido.negocio_perfil SET wa_token_enc=NULL, wa_app_secret_enc=NULL WHERE negocio_id=$1', [negocioId]);
  return { ok: true, ...(await getWhatsappNegocio(negocioId)) };
}

// El secreto de la app DEL NÚMERO al que le escribieron, para validar la firma de ese webhook.
//
// Se busca por número y no se prueban todos los secretos conocidos: probar todos significa que,
// si se filtra el secreto de un negocio, con él se puede forjar un webhook que diga ser de OTRO.
// El `phoneId` viene del cuerpo sin validar, pero usarlo sólo para ELEGIR con qué llave verificar
// es seguro — quien miente sobre el número sigue sin poder firmar como su dueño.
//
// Se cachea un minuto: llega un webhook por mensaje y no vale descifrar en cada uno.
let _secretos = new Map(), _secretosAt = 0;
async function secretoDeNumero(phoneId) {
  if (!phoneId) return null;
  if (Date.now() - _secretosAt > 60000) {
    const { rows } = await pool.query(
      `SELECT wa_phone_id, wa_app_secret_enc FROM contenido.negocio_perfil
        WHERE wa_app_secret_enc IS NOT NULL AND wa_phone_id IS NOT NULL`);
    const m = new Map();
    for (const r of rows) {
      try { m.set(r.wa_phone_id, cryptoAds.decrypt(r.wa_app_secret_enc)); }
      catch (e) { /* uno roto no deja sin validar a los demás */ }
    }
    _secretos = m; _secretosAt = Date.now();
  }
  return _secretos.get(String(phoneId)) || null;
}

// Qué negocio es dueño de un número, para saber a quién le llegó el mensaje.
async function negocioPorPhoneId(phoneId) {
  const { rows: [r] } = await pool.query(
    `SELECT p.id, p.slug, p.nombre FROM contenido.negocios p
       JOIN contenido.negocio_perfil pp ON pp.negocio_id = p.id
      WHERE pp.wa_phone_id = $1`, [String(phoneId || '')]);
  return r || null;
}

// Las plantillas que la plataforma necesita para avisar. Si falta alguna, el aviso no sale.
const PLANTILLAS_RESERVA = ['reserva_nueva', 'reserva_confirmada'];

// Diagnóstico: ¿está operativo y bien configurado?
// Cada punto de acá salió de una trampa real documentada en WHATSAPP.md: el webhook figura
// validado con luz verde aunque falten las suscripciones, y ninguna avisa por la otra.
async function verificarWhatsappNegocio(negocioId) {
  const cfg = await getWhatsappNegocio(negocioId, true);
  const chequeos = [];
  const add = (id, titulo, estado, detalle) => chequeos.push({ id, titulo, estado, detalle });

  if (!cfg || !cfg.wa_phone_id || !cfg.token) {
    add('config', 'Configuración cargada', 'falta',
        'Faltan el id del número o el token. Cargalos arriba.');
    return { ok: false, chequeos };
  }

  const API = 'https://graph.facebook.com/v21.0';
  const pedir = async (ruta) => {
    try {
      const r = await fetch(`${API}/${ruta}${ruta.includes('?') ? '&' : '?'}access_token=${cfg.token}`,
        { signal: AbortSignal.timeout(12000) });
      const j = await r.json().catch(() => ({}));
      return j.error ? { error: j.error.message } : j;
    } catch (e) { return { error: e.message }; }
  };

  // 1) El token llega al número. Los campos van explícitos: el juego por defecto NO trae
  // account_mode ni name_status, y sin pedirlos los chequeos salen "sin dato".
  const num = await pedir(`${cfg.wa_phone_id}?fields=display_phone_number,verified_name,` +
    `quality_rating,account_mode,name_status,code_verification_status,platform_type,webhook_configuration`);
  if (num.error) {
    add('token', 'El token alcanza el número', 'mal', num.error);
    return { ok: false, chequeos };
  }
  add('token', 'El token alcanza el número', 'ok',
      `${num.display_phone_number} · ${num.verified_name}`);
  // El número tal como lo ve un cliente lo sabe Meta, no nosotros: se guarda al verificar para
  // poder mostrarlo (en el pase de una invitación, por ejemplo) sin volver a preguntarle.
  if (num.display_phone_number) {
    await pool.query(
      `UPDATE contenido.negocio_capacidad
          SET config = jsonb_set(COALESCE(config,'{}'::jsonb), '{numero}', to_jsonb($2::text))
        WHERE negocio_id=$1 AND capacidad='whatsapp'`,
      [negocioId, num.display_phone_number]).catch(() => {});
  }

  // 2) En producción, no en un sandbox
  add('modo', 'Número en producción', num.account_mode === 'LIVE' ? 'ok' : 'mal',
      num.account_mode === 'LIVE' ? 'LIVE' : `account_mode = ${num.account_mode || 'desconocido'}`);

  // 3) Calidad: es POR NÚMERO, y es la razón de tener uno por negocio.
  // UNKNOWN no es un problema: es lo que devuelve un número que todavía no mandó suficientes
  // mensajes como para que Meta lo califique. Marcarlo en rojo sería mentir.
  const q = num.quality_rating;
  add('calidad', 'Calificación de calidad',
      q === 'GREEN' ? 'ok' : (q === 'RED' ? 'mal' : 'aviso'),
      q === 'UNKNOWN' ? 'todavía sin calificar — el número no mandó mensajes' : (q || 'sin dato'));

  // 4) Nombre visible: es lo que ve el cliente
  const ns = num.name_status;
  add('nombre', 'Nombre visible aprobado',
      ['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(ns) ? 'ok' : 'aviso',
      `${num.verified_name || '—'} (${ns || 'sin dato'})`);

  // 5) El webhook apunta acá. Sin esto no llega ni una respuesta.
  // 5) El webhook sólo hace falta para RECIBIR. Un número que sólo manda avisos funciona sin
  // él, así que su ausencia es una limitación a decir, no una falla que rompe nada.
  const hook = (num.webhook_configuration || {}).application || '';
  add('webhook', 'Recibe respuestas',
      /panel\.clausina\.ar\/webhook\/whatsapp/.test(hook) ? 'ok' : 'aviso',
      hook || 'sin webhook — el número puede enviar avisos pero no recibir respuestas');

  if (!cfg.wa_waba_id) {
    add('waba', 'Cuenta (WABA) cargada', 'falta', 'Sin el WABA no se pueden mirar las plantillas.');
    return { ok: chequeos.every(c => c.estado === 'ok'), chequeos };
  }

  // 6) La cuenta: revisión y verificación del negocio
  const waba = await pedir(`${cfg.wa_waba_id}?fields=name,account_review_status,business_verification_status`);
  if (waba.error) add('waba', 'La cuenta responde', 'mal', waba.error);
  else {
    add('waba', 'Cuenta revisada por Meta',
        waba.account_review_status === 'APPROVED' ? 'ok' : 'aviso',
        `${waba.name || ''} · ${waba.account_review_status || 'sin dato'}`);
    const bv = waba.business_verification_status;
    add('verificacion', 'Negocio verificado', bv === 'verified' ? 'ok' : 'aviso',
        bv === 'verified' ? 'verificado'
          : (bv === 'pending' ? 'en trámite — mientras tanto, tope de 250 conversaciones iniciadas cada 24 h'
                              : 'sin verificar — tope de 250 conversaciones iniciadas cada 24 h'));
  }

  // 7) LA TRAMPA: la cuenta suscripta a nuestra app. El webhook puede figurar en verde igual.
  const subs = await pedir(`${cfg.wa_waba_id}/subscribed_apps`);
  const apps = (subs.data || []).map(x => (x.whatsapp_business_api_data || {}).link || (x.whatsapp_business_api_data || {}).name || '');
  add('suscripcion', 'La cuenta está suscripta a la app',
      subs.error ? 'mal' : (apps.length ? 'ok' : 'mal'),
      subs.error || (apps.length ? apps.join(', ') : 'ninguna app suscripta — no van a llegar los mensajes'));

  // 8) Las plantillas que hacen falta, y en qué estado están
  const tpl = await pedir(`${cfg.wa_waba_id}/message_templates?limit=100`);
  if (tpl.error) add('plantillas', 'Plantillas de aviso', 'mal', tpl.error);
  else {
    const porNombre = {};
    (tpl.data || []).forEach(t => { porNombre[t.name] = t.status; });
    const detalle = PLANTILLAS_RESERVA.map(n => `${n}: ${porNombre[n] || 'no existe'}`).join(' · ');
    const todas = PLANTILLAS_RESERVA.every(n => porNombre[n] === 'APPROVED');
    const alguna = PLANTILLAS_RESERVA.some(n => porNombre[n]);
    add('plantillas', 'Plantillas de aviso aprobadas',
        todas ? 'ok' : (alguna ? 'aviso' : 'falta'), detalle);
  }

  return { ok: chequeos.every(c => c.estado === 'ok'), chequeos };
}

// --- Avisos de reserva (v2.0 / F5c) -------------------------------------------------------
// A quién avisarle cuando entra una reserva: los usuarios activos de ESE negocio que tengan
// WhatsApp cargado. Sin destinatarios no se avisa a nadie, y eso queda registrado en el job.
async function destinatariosAviso(negocioId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.nombre, u.whatsapp
       FROM contenido.usuario u
       JOIN contenido.usuario_negocio un ON un.usuario_id = u.id
      WHERE un.negocio_id = $1 AND u.activo AND coalesce(u.whatsapp,'') <> ''`, [negocioId]);
  return rows;
}

// Los datos que necesita un aviso, ya legibles. Se arma acá y no en el server para que la SQL
// siga viviendo en un solo lugar.
async function datosParaAviso(reservaId) {
  const { rows: [r] } = await pool.query(
    `SELECT r.id, r.fecha::text, r.cantidad, r.estado, r.negocio_id,
            COALESCE(t.nombre_publico, t.nombre) AS turno,
            to_char(t.hora_desde,'HH24:MI') AS hora_desde,
            c.nombre AS cliente, c.telefono AS cliente_telefono,
            n.nombre AS negocio,
            COALESCE(nc.config->>'unidad','personas') AS unidad
       FROM contenido.reserva r
       JOIN contenido.turno t ON t.id = r.turno_id
       JOIN contenido.cliente c ON c.id = r.cliente_id
       JOIN contenido.negocios n ON n.id = r.negocio_id
       LEFT JOIN contenido.negocio_capacidad nc
         ON nc.negocio_id = r.negocio_id AND nc.capacidad = 'reservas'
      WHERE r.id = $1`, [reservaId]);
  return r || null;
}

// --- Puente del call to action (v2.0 / F5) ----------------------------------------------
// Una pieza lleva una acción; la acción vive en un enlace corto; lo que pasa con ese enlace queda
// atribuido. Es lo que permite decir "este posteo generó siete reservas".
const crypto = require('crypto');

// Token corto y sin ambigüedad visual: sin 0/O ni 1/l/I, porque estos enlaces se dictan por
// teléfono y se imprimen en QR.
const ALFABETO = '23456789abcdefghijkmnpqrstuvwxyz';
function tokenCorto(n = 8) {
  const b = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALFABETO[b[i] % ALFABETO.length];
  return out;
}

// Piezas a las que se le puede colgar una acción: las que ya salieron o están por salir.
// Liviano a propósito — getPiezas trae media, bitácora y revisiones, y acá sólo hace falta el rótulo.
async function getPiezasParaAccion(negocioId) {
  const { rows } = await pool.query(
    `SELECT pz.id, pz.numero, pz.canal, pz.titulo_interno, pz.estado
       FROM contenido.piezas pz
      WHERE pz.negocio_id=$1 AND pz.estado IN ('pendiente_aprobacion','aprobada','publicada')
      ORDER BY pz.creado_en DESC LIMIT 60`, [negocioId]);
  return rows;
}

async function crearLink(negocioId, d) {
  const cap = ['reservas'].includes(d.capacidad) ? d.capacidad : 'reservas';
  for (let intento = 0; intento < 5; intento++) {
    try {
      const { rows: [r] } = await pool.query(
        `INSERT INTO contenido.accion_link (negocio_id, pieza_id, token, capacidad, etiqueta, params)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::jsonb,'{}'::jsonb)) RETURNING id, token`,
        [negocioId, d.pieza_id || null, tokenCorto(), cap,
         String(d.etiqueta || '').trim() || null, d.params ? JSON.stringify(d.params) : null]);
      return { ok: true, id: r.id, token: r.token };
    } catch (e) {
      if (e.code === '23505') continue;   // token repetido: se reintenta con otro
      throw e;
    }
  }
  const e = new Error('no se pudo generar el token'); e.code = 'token'; throw e;
}

// Los enlaces con su embudo: cuántos entraron y cuántos completaron.
async function getLinks(negocioId) {
  const { rows } = await pool.query(
    `SELECT l.id, l.token, l.capacidad, l.etiqueta, l.activo, l.creado_en, l.pieza_id,
            p.numero AS pieza_numero,
            COALESCE(c.aperturas, 0)::int AS aperturas,
            COALESCE(c.completados, 0)::int AS completados,
            COALESCE(r.personas, 0)::int AS reservado
       FROM contenido.accion_link l
       LEFT JOIN contenido.piezas p ON p.id = l.pieza_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS aperturas, count(*) FILTER (WHERE reserva_id IS NOT NULL) AS completados
           FROM contenido.accion_click WHERE link_id = l.id) c ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(cantidad),0) AS personas FROM contenido.reserva
          WHERE link_id = l.id AND estado IN ('solicitada','confirmada','cumplida')) r ON true
      WHERE l.negocio_id = $1
      ORDER BY l.creado_en DESC`, [negocioId]);
  return rows;
}

async function setLinkActivo(negocioId, id, activo) {
  const { rowCount } = await pool.query(
    'UPDATE contenido.accion_link SET activo=$3 WHERE id=$1 AND negocio_id=$2', [id, negocioId, !!activo]);
  return { ok: rowCount > 0 };
}

// --- Superficie pública ------------------------------------------------------------------
// Todo lo de acá lo consume gente SIN sesión. Regla: expone identidad y disponibilidad, nunca
// clientes ni reservas de otros. Cada consulta filtra por negocio y por el opt-in del negocio.

// Un negocio sólo aparece públicamente si habilitó reservas Y marcó `publico` en la config.
// El silencio es no: nadie queda expuesto por olvido.
async function negocioPublico(slug) {
  const { rows: [n] } = await pool.query(
    `SELECT p.id, p.slug, p.nombre, pp.slogan, pp.logo, pp.logo_claro, p.dominio_web,
            p.ig_handle, nc.config, COALESCE(ni.marca, '{}'::jsonb) AS marca
       FROM contenido.negocios p
       LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id = p.id
       LEFT JOIN contenido.negocio_identidad ni ON ni.negocio_id = p.id
       JOIN contenido.negocio_capacidad nc ON nc.negocio_id = p.id AND nc.capacidad = 'reservas'
      WHERE p.slug = $1 AND p.activo AND nc.habilitada`, [slug]);
  if (!n || !(n.config || {}).publico) return null;
  const { rows: [sede] } = await pool.query(
    `SELECT direccion, localidad, partido FROM contenido.negocio_sede
      WHERE negocio_id=$1 ORDER BY principal DESC, orden LIMIT 1`, [n.id]);
  const cfg = { ...CFG_RESERVAS, ...(n.config || {}) };
  return {
    id: n.id, slug: n.slug, nombre: n.nombre, slogan: n.slogan,
    logo: n.logo, logo_claro: n.logo_claro, web: n.dominio_web, instagram: n.ig_handle,
    sede: sede || null,
    // El número del asistente, si el negocio lo tiene andando: sirve para ofrecer el otro
    // camino ("o escribinos") sin que nadie tenga que copiarlo a mano en ningún lado.
    whatsapp: (await (async () => {
      const { rows: [w] } = await pool.query(
        `SELECT config->>'numero' AS n FROM contenido.negocio_capacidad
          WHERE negocio_id=$1 AND capacidad='whatsapp' AND habilitada`, [n.id]);
      return w ? w.n : null;
    })()) || null,
    // Tokens visuales: lo que hace que la página no se vea de ClaUsina sino del negocio.
    // Vacío = paleta de la plataforma, que es un default digno y no un error.
    marca: n.marca || {},
    // Sólo lo que hace falta para reservar. Nada de fuente_verdad ni de auto_confirmar.
    unidad: cfg.unidad, cantidad_min: cfg.cantidad_min, cantidad_max: cfg.cantidad_max,
    anticipacion_max_dias: cfg.anticipacion_max_dias, anticipacion_min_horas: cfg.anticipacion_min_horas,
  };
}

// Qué cuelga la landing. Habilitar o no una capacidad es estructural (solo admin); QUÉ OFRECE
// la landing es una decisión operativa del negocio, así que tiene su propia puerta.
async function guardarQueExponeLanding(negocioId, d) {
  const validas = ['reservas'];
  const expone = [...new Set((Array.isArray(d.expone) ? d.expone : []).filter(x => validas.includes(x)))];
  const { rows: [w] } = await pool.query(
    `SELECT config FROM contenido.negocio_capacidad WHERE negocio_id=$1 AND capacidad='web'`, [negocioId]);
  if (!w) { const e = new Error('sin landing'); e.code = 'sin_landing'; throw e; }
  const cfg = { ...(w.config || {}), expone };
  const etq = String(d.etiqueta_reservas || '').trim().slice(0, 40);
  if (etq) cfg.etiqueta_reservas = etq; else delete cfg.etiqueta_reservas;
  await pool.query(
    `UPDATE contenido.negocio_capacidad SET config=$2::jsonb, actualizado_en=now()
      WHERE negocio_id=$1 AND capacidad='web'`, [negocioId, JSON.stringify(cfg)]);
  return { ok: true, config: cfg };
}

// Lo que necesita una landing para colgarse la capacidad: si está ofrecida y con qué rótulo.
// Es la única consulta que una cápsula externa hace contra el motor, así que es deliberadamente
// chica y no expone nada más.
async function ofertaLanding(slug) {
  const { rows: [w] } = await pool.query(
    `SELECT nc.config FROM contenido.negocio_capacidad nc
       JOIN contenido.negocios p ON p.id = nc.negocio_id
      WHERE p.slug=$1 AND p.activo AND nc.capacidad='web' AND nc.habilitada`, [slug]);
  const expone = ((w && w.config && w.config.expone) || []);
  if (!expone.includes('reservas')) return { reservas: null };
  const n = await negocioPublico(slug);          // respeta el opt-in público
  if (!n) return { reservas: null };
  return {
    reservas: {
      url: `/r/${n.slug}`,
      etiqueta: (w.config.etiqueta_reservas || 'Reservar').slice(0, 40),
    },
  };
}

async function disponibilidadPublica(negocioId, desde, hasta) {
  const cfg = await getConfigReservas(negocioId);
  const dias = await getDisponibilidad(negocioId, desde, hasta);
  // La ventana real, en hora local: no tiene sentido ofrecer un turno que el backend va a
  // rechazar por anticipación. Se calcula en la base para usar la misma zona horaria.
  const { rows: [v] } = await pool.query(
    `SELECT (now() + ($1 || ' hours')::interval) AT TIME ZONE $3 AS piso,
            (now() + ($2 || ' days')::interval)  AT TIME ZONE $3 AS techo`,
    [String(cfg.anticipacion_min_horas), String(cfg.anticipacion_max_dias), TZ]);
  const piso = new Date(v.piso), techo = new Date(v.techo);
  // Hacia afuera no se dice cuánto se vendió: sólo si queda lugar y cuánto. La ocupación de un
  // negocio es información suya, no del público.
  return dias
    .filter(d => !d.bloqueado)
    .filter(d => {
      const inicio = new Date(d.fecha + 'T' + d.hora_desde + ':00');
      return inicio >= piso && inicio <= techo;
    })
    .map(d => ({
      fecha: d.fecha, turno_id: d.turno_id,
      // El nombre interno es una clave para el negocio ("Noche F. Semana T1"): afuera va la
      // descripción. Y no se manda la capacidad, sólo el tope que aplica a esta reserva.
      nombre: d.nombre_publico || d.nombre,
      hora_desde: d.hora_desde, hora_hasta: d.hora_hasta,
      libre: Math.max(0, d.capacidad - d.ocupado),
      // El tope de UNA reserva: el del turno si lo redefinió, si no el general. Es el número que
      // hay que decirle a alguien antes de que pruebe con uno que va a rebotar.
      tope: Math.min(d.cantidad_max || cfg.cantidad_max, Math.max(0, d.capacidad - d.ocupado)),
    }))
    .filter(d => d.libre > 0);
}

async function registrarApertura(token, ipHash, referer) {
  const { rows: [l] } = await pool.query(
    `SELECT l.id, l.negocio_id, l.capacidad, l.etiqueta, l.params, n.slug
       FROM contenido.accion_link l JOIN contenido.negocios n ON n.id = l.negocio_id
      WHERE l.token = $1 AND l.activo`, [token]);
  if (!l) return null;
  const { rows: [c] } = await pool.query(
    `INSERT INTO contenido.accion_click (link_id, negocio_id, ip_hash, referer)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [l.id, l.negocio_id, ipHash || null, (referer || '').slice(0, 300) || null]);
  return { link: l, clickId: c.id };
}

// De qué enlace salió una apertura. Se valida contra el negocio para que un id de otro no sirva.
async function linkDeApertura(clickId, negocioId) {
  const { rows: [c] } = await pool.query(
    'SELECT link_id FROM contenido.accion_click WHERE id=$1 AND negocio_id=$2', [clickId, negocioId]);
  return c ? c.link_id : null;
}

// Cierra el embudo: esta apertura terminó en esta reserva.
async function marcarCompletado(clickId, reservaId) {
  if (!clickId) return;
  await pool.query(
    `UPDATE contenido.accion_click SET reserva_id=$2, completado_en=now()
      WHERE id=$1 AND reserva_id IS NULL`, [clickId, reservaId]);
}

// --- Identidad estructurada (v2.0 / F1) --------------------------------------------------
// La OTRA cara de la identidad: `negocio_perfil` guarda la narrativa (brief, estilo) que lee el
// creativo; esto guarda los HECHOS que puede consultar una máquina. Ver core/planes/V2.md.
// `revisado_en` en NULL significa "propuesta sin confirmar por una persona".

// Catálogos (actividades y atributos): son estáticos, se cachean como la lista de negocios.
let _catIdent = null, _catIdentAt = 0;
function invalidarCatIdentidad() { _catIdentAt = 0; }
async function getCatalogosIdentidad() {
  if (!_catIdent || Date.now() - _catIdentAt > 300000) {
    const { rows: actividades } = await pool.query(
      `SELECT a.id, a.codigo, a.nombre, a.padre_id, p.codigo AS grupo_codigo, p.nombre AS grupo
         FROM contenido.actividad a JOIN contenido.actividad p ON p.id = a.padre_id
        WHERE a.activa AND p.activa
        ORDER BY p.orden, a.orden`);
    const { rows: raices } = await pool.query(
      `SELECT id, codigo, nombre FROM contenido.actividad WHERE padre_id IS NULL AND activa ORDER BY orden`);
    // `actividades` en cada atributo: vacío = universal (se ofrece a todos los rubros).
    const { rows: atributos } = await pool.query(
      `SELECT t.codigo, t.nombre, t.grupo,
              COALESCE(array_agg(m.actividad_id) FILTER (WHERE m.actividad_id IS NOT NULL), '{}') AS actividades
         FROM contenido.atributo t
         LEFT JOIN contenido.atributo_actividad m ON m.atributo_codigo = t.codigo
        GROUP BY t.codigo, t.nombre, t.grupo, t.orden
        ORDER BY t.grupo, t.orden`);
    _catIdent = { actividades, raices, atributos }; _catIdentAt = Date.now();
  }
  return _catIdent;
}

// Un atributo se ofrece si es universal, o si está mapeado a la actividad elegida o a su raíz.
function atributoAplica(attr, actividadId, padreId) {
  if (!attr.actividades || !attr.actividades.length) return true;
  return attr.actividades.includes(actividadId) || attr.actividades.includes(padreId);
}

// Mapeo atributo → rubros, para la pantalla de configuración (solo admin).
async function setMapeoAtributo(codigo, actividadIds) {
  const ids = [...new Set((Array.isArray(actividadIds) ? actividadIds : []).map(Number).filter(Boolean))];
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [t] } = await cli.query('SELECT codigo FROM contenido.atributo WHERE codigo=$1', [codigo]);
    if (!t) { const e = new Error('atributo inexistente'); e.code = 'no_existe'; throw e; }
    await cli.query('DELETE FROM contenido.atributo_actividad WHERE atributo_codigo=$1', [codigo]);
    if (ids.length) {
      // Sólo raíces: es la granularidad de la pantalla. La tabla admite hojas si hiciera falta.
      await cli.query(
        `INSERT INTO contenido.atributo_actividad (atributo_codigo, actividad_id)
         SELECT $1, id FROM contenido.actividad WHERE id = ANY($2::int[]) AND padre_id IS NULL`,
        [codigo, ids]);
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally { cli.release(); }
  invalidarCatIdentidad();
  return { ok: true, ...(await getCatalogosIdentidad()) };
}

async function getIdentidad(negocioId) {
  const { rows: [i] } = await pool.query(
    `SELECT ni.*, a.codigo AS actividad_codigo, a.nombre AS actividad_nombre
       FROM contenido.negocio_identidad ni
       LEFT JOIN contenido.actividad a ON a.id = ni.actividad_id
      WHERE ni.negocio_id=$1`, [negocioId]);
  const { rows: sedes } = await pool.query(
    `SELECT id, nombre, direccion, localidad, partido, provincia, pais, lat, lon, telefono, principal
       FROM contenido.negocio_sede WHERE negocio_id=$1 ORDER BY principal DESC, orden, creado_en`,
    [negocioId]);
  return { identidad: i || null, sedes };
}

async function guardarIdentidad(negocioId, d, usuarioId) {
  const nn = s => (s != null && String(s).trim() !== '') ? String(s).trim() : null;
  const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const zonaModo = ['radio', 'localidades', 'nacional'].includes(d.zona_modo) ? d.zona_modo : 'radio';
  const unidad = ['persona', 'orden', 'mes', 'hora', 'clase'].includes(d.ticket_unidad) ? d.ticket_unidad : null;

  // El ticket al revés es error de carga, no dato: se corrige acá y no lo rebota la restricción.
  let tMin = num(d.ticket_min), tMax = num(d.ticket_max);
  if (tMin != null && tMax != null && tMin > tMax) [tMin, tMax] = [tMax, tMin];

  // Los atributos se validan contra el catálogo Y contra el rubro elegido: lo que no aplica no
  // entra (si no, el filtro miente). Cambiar de rubro descarta lo que el rubro nuevo no admite.
  const { atributos: catAttrs, actividades } = await getCatalogosIdentidad();
  const actId = num(d.actividad_id);
  const act = actividades.find(a => a.id === actId);
  const padreId = act ? act.padre_id : null;
  const validos = new Set(catAttrs.filter(a => atributoAplica(a, actId, padreId)).map(a => a.codigo));
  const atributos = [...new Set((Array.isArray(d.atributos) ? d.atributos : []).filter(a => validos.has(a)))];

  const localidades = (Array.isArray(d.zona_localidades) ? d.zona_localidades : [])
    .map(s => String(s).trim()).filter(Boolean).slice(0, 60);

  const sedes = (Array.isArray(d.sedes) ? d.sedes : [])
    .map(s => ({
      id: nn(s.id),
      nombre: nn(s.nombre), direccion: nn(s.direccion), localidad: nn(s.localidad),
      partido: nn(s.partido), provincia: nn(s.provincia), pais: nn(s.pais) || 'AR',
      lat: num(s.lat), lon: num(s.lon), telefono: nn(s.telefono), principal: !!s.principal,
    }))
    .filter(s => s.direccion || s.localidad || s.nombre);   // una sede vacía no es una sede
  // Una sola principal: gana la primera marcada, y si ninguna lo está, la primera de la lista.
  let vistaPrincipal = false;
  for (const s of sedes) {
    if (s.principal && !vistaPrincipal) vistaPrincipal = true;
    else s.principal = false;
  }
  if (sedes.length && !vistaPrincipal) sedes[0].principal = true;

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query(`
      INSERT INTO contenido.negocio_identidad
        (negocio_id, actividad_id, zona_modo, zona_km, zona_localidades,
         ticket_min, ticket_max, moneda, ticket_unidad, publico, atributos, horarios, actualizado_en)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'ARS'),$9,
              COALESCE($10::jsonb,'{}'::jsonb),$11,COALESCE($12::jsonb,'{}'::jsonb), now())
      ON CONFLICT (negocio_id) DO UPDATE SET
        actividad_id=$2, zona_modo=$3, zona_km=$4, zona_localidades=$5,
        ticket_min=$6, ticket_max=$7, moneda=COALESCE($8,'ARS'), ticket_unidad=$9,
        publico=COALESCE($10::jsonb,'{}'::jsonb), atributos=$11,
        horarios=COALESCE($12::jsonb,'{}'::jsonb), actualizado_en=now()`,
      [negocioId, num(d.actividad_id), zonaModo, zonaModo === 'radio' ? num(d.zona_km) : null,
       localidades, tMin, tMax, nn(d.moneda), unidad,
       d.publico ? JSON.stringify(d.publico) : null, atributos,
       d.horarios ? JSON.stringify(d.horarios) : null]);

    // Confirmar la ficha es un acto explícito del usuario, no un efecto de guardar.
    if (d.revisado === true) {
      await cli.query(`UPDATE contenido.negocio_identidad SET revisado_en=now(), revisado_por=$2
                        WHERE negocio_id=$1`, [negocioId, usuarioId || null]);
    } else if (d.revisado === false) {
      await cli.query(`UPDATE contenido.negocio_identidad SET revisado_en=NULL, revisado_por=NULL
                        WHERE negocio_id=$1`, [negocioId]);
    }

    // Sedes: se conservan los ids. En F4 una reserva va a apuntar a una sede; si el id cambiara
    // en cada guardado, la reserva quedaría colgada en silencio.
    const conservar = sedes.map(s => s.id).filter(Boolean);
    await cli.query(
      `DELETE FROM contenido.negocio_sede WHERE negocio_id=$1 AND NOT (id = ANY($2::uuid[]))`,
      [negocioId, conservar]);
    // Bajar todas antes de subir la nueva: el índice único de sede principal se verifica fila por
    // fila, así que un estado intermedio con dos principales aborta la transacción.
    await cli.query('UPDATE contenido.negocio_sede SET principal=false WHERE negocio_id=$1', [negocioId]);
    for (let i = 0; i < sedes.length; i++) {
      const s = sedes[i];
      const cols = [negocioId, s.nombre, s.direccion, s.localidad, s.partido, s.provincia,
                    s.pais, s.lat, s.lon, s.telefono, s.principal, i];
      if (s.id) {
        await cli.query(
          `UPDATE contenido.negocio_sede SET nombre=$2, direccion=$3, localidad=$4, partido=$5,
             provincia=$6, pais=$7, lat=$8, lon=$9, telefono=$10, principal=$11, orden=$12
            WHERE id=$13 AND negocio_id=$1`, [...cols, s.id]);
      } else {
        await cli.query(
          `INSERT INTO contenido.negocio_sede
             (negocio_id, nombre, direccion, localidad, partido, provincia, pais, lat, lon, telefono, principal, orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, cols);
      }
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally {
    cli.release();
  }
  return { ok: true, ...(await getIdentidad(negocioId)) };
}

// Piezas con su revisión vigente + media principal (para el board por estado). Scopeado por marca.
async function getPiezas(canal, negocioId) {
  const params = [negocioId];
  let where = 'WHERE pz.negocio_id = $1';
  if (canal) { params.push(canal); where += ` AND pz.canal = $${params.length}`; }
  const { rows } = await pool.query(`
    SELECT pz.id, pz.numero, pz.canal, pz.titulo_interno, pz.estado, pz.creado_en, pz.actualizado_en,
           r.nro, r.formato, r.motivo_rechazo, r.derivado_en,
           COALESCE(r.colaboradores, (SELECT ig_colaboradores FROM contenido.negocios WHERE id=pz.negocio_id)) AS colaboradores,
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
  // negocio_id se deriva de la pieza dueña del post (no hace falta pasarlo): cada métrica queda en su marca.
  await pool.query(
    `INSERT INTO contenido.ig_metricas (ig_post_id, views, reach, likes, comments, saved, shares, total_interactions, negocio_id, actualizado_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
       (SELECT pz.negocio_id FROM contenido.revisiones r JOIN contenido.piezas pz ON pz.id=r.pieza_id WHERE r.ig_post_id=$1 LIMIT 1), now())
     ON CONFLICT (ig_post_id) DO UPDATE SET
       views=$2, reach=$3, likes=$4, comments=$5, saved=$6, shares=$7, total_interactions=$8, actualizado_en=now()`,
    [id, v.views || 0, v.reach || 0, v.likes || 0, v.comments || 0, v.saved || 0, v.shares || 0, v.total_interactions || 0]);
}

// Cola de requerimientos: brief + la pieza que generó (correlación) y su estado derivado.
// Se mantiene visible hasta que la pieza llegue a un estado terminal (publicada/descartada).
async function getRequerimientos(negocioId) {
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
    WHERE b.negocio_id = $1
      AND b.pieza_id IS NULL
      AND b.estado IN ('propuesta','pendiente','procesando','error','revisar','revisando')
    ORDER BY (b.estado='propuesta') DESC, b.creado_en DESC
    LIMIT 100;`, [negocioId]);
  // Pedidos de propuestas en curso (placeholder en la cola mientras el creativo elabora).
  const { rows: sol } = await pool.query(`
    SELECT id, estado AS brief_estado, canal AS canal_destino, enfasis, creado_en, true AS es_solicitud
    FROM contenido.solicitudes_propuesta WHERE negocio_id = $1 AND estado IN ('pendiente','procesando')
    ORDER BY creado_en DESC`, [negocioId]);
  return [...sol, ...rows];
}

// Inserta una mención entrante en la cola (dedupe por ref_externa = ig media id). Devuelve true si era nueva.
const TG_CHAT = process.env.PANEL_TG_CHAT || '811183062';
async function insertMencion(refId, username, permalink, negocioId) {
  const titulo = `Mención de @${username}`;
  const texto = `@${username} etiquetó a la marca en Instagram.\n\nSi generás, armá una pieza de marca para agradecer o aprovechar la mención (tono de marca, sin emojis).\nPost original: ${permalink}`;
  const { rows } = await pool.query(
    `INSERT INTO contenido.tg_briefs (chat_id, origen, estado, titulo, texto, enlace, ref_externa, negocio_id)
     SELECT $1, 'mencion', 'propuesta', $2, $3, $4, $5, $6
     WHERE NOT EXISTS (SELECT 1 FROM contenido.tg_briefs WHERE ref_externa = $5)
     RETURNING id`, [TG_CHAT, titulo, texto, permalink || null, refId, negocioId]);
  return rows.length > 0;
}

// Pedido de propuestas al creativo (lo levanta el cron propuestas_local.sh). cantidad: 1..8.
async function pedirPropuestas(enfasis, canal, cantidad, negocioId, material) {
  const n = Math.min(8, Math.max(1, parseInt(cantidad, 10) || 5));
  const { rows: [s] } = await pool.query(
    `INSERT INTO contenido.solicitudes_propuesta (enfasis, canal, cantidad, negocio_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [enfasis || null, canal === 'aviso' ? 'aviso' : 'instagram', n, negocioId]);
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
async function getStatus(_negocioId) {
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
async function getBiblioteca(negocioId) {
  const piezas = (await pool.query(`
    SELECT m.url, m.tipo, m.poster_url, m.orden,
           pz.id AS pieza_id, pz.canal::text AS canal, pz.titulo_interno AS titulo,
           r.estado::text AS estado, COALESCE(r.publicado_en, pz.actualizado_en) AS fecha
      FROM contenido.media m
      JOIN contenido.piezas pz ON pz.id = m.pieza_id
      JOIN contenido.revisiones r ON r.id = pz.revision_vigente
     WHERE pz.negocio_id = $1 AND r.estado <> 'descartada'
     ORDER BY COALESCE(r.publicado_en, pz.actualizado_en) DESC, m.orden`, [negocioId])).rows;
  const material = (await pool.query(`
    SELECT bm.media_path, bm.media_type, bm.filename, bm.creado_en,
           CASE WHEN bm.media_path LIKE 'material/pieza/%' THEN 'de un rechazo' ELSE 'de una propuesta' END AS contexto
      FROM contenido.brief_material bm
      JOIN contenido.tg_briefs b ON b.id = bm.brief_id
     WHERE b.negocio_id = $1 AND bm.media_path IS NOT NULL
     ORDER BY bm.creado_en DESC`, [negocioId])).rows;
  const perfil = (await pool.query(`SELECT logo FROM contenido.negocio_perfil WHERE negocio_id = $1`, [negocioId])).rows[0] || {};
  const items = (await pool.query(`
    SELECT id, codigo, media_path, tipo, nombre, carpeta, origen, resumen, creado_en
      FROM contenido.biblioteca_item WHERE negocio_id = $1 ORDER BY creado_en DESC`, [negocioId])).rows;
  const carpetas = (await pool.query(`
    SELECT nombre FROM contenido.biblioteca_carpeta WHERE negocio_id = $1 ORDER BY orden, nombre`, [negocioId])).rows.map(r => r.nombre);
  const trabajando = (await pool.query(`
    SELECT id, instruccion, estado, resumen, creado_en
      FROM contenido.solicitudes_biblioteca
     WHERE negocio_id = $1 AND estado IN ('pendiente','procesando','error')
     ORDER BY creado_en DESC LIMIT 40`, [negocioId])).rows;
  return { piezas, material, logo: perfil.logo || null, items, carpetas, trabajando };
}

// Garantiza las carpetas de taller por defecto para un proyecto.
async function ensureCarpetasBiblioteca(negocioId) {
  await pool.query(
    `INSERT INTO contenido.biblioteca_carpeta (negocio_id, nombre, orden)
     VALUES ($1,'En proceso',10),($1,'Terminado',20)
     ON CONFLICT (negocio_id, nombre) DO NOTHING`, [negocioId]);
}
async function crearCarpetaBiblioteca(negocioId, nombre) {
  await pool.query(
    `INSERT INTO contenido.biblioteca_carpeta (negocio_id, nombre) VALUES ($1,$2)
     ON CONFLICT (negocio_id, nombre) DO NOTHING`, [negocioId, String(nombre).slice(0, 60)]);
  return true;
}
// Borra una carpeta solo si está vacía y no es una de las por defecto.
async function delCarpetaBiblioteca(negocioId, nombre) {
  if (nombre === 'En proceso' || nombre === 'Terminado') return false;
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contenido.biblioteca_item WHERE negocio_id=$1 AND carpeta=$2`, [negocioId, nombre]);
  if (rows[0].n > 0) return false;
  await pool.query(`DELETE FROM contenido.biblioteca_carpeta WHERE negocio_id=$1 AND nombre=$2`, [negocioId, nombre]);
  return true;
}
async function crearItemBiblioteca(negocioId, mediaPath, tipo, nombre, carpeta, origen) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.biblioteca_item (negocio_id, media_path, tipo, nombre, carpeta, origen)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [negocioId, mediaPath, tipo === 'video' ? 'video' : 'image', (nombre || '').slice(0, 120) || null, carpeta || 'En proceso', origen || 'subido']);
  return rows[0].id;
}
async function moverItemBiblioteca(negocioId, id, carpeta) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.biblioteca_item SET carpeta=$3 WHERE id=$1 AND negocio_id=$2`, [id, negocioId, String(carpeta).slice(0, 60)]);
  return rowCount > 0;
}
async function delItemBiblioteca(negocioId, id) {
  const { rows } = await pool.query(
    `DELETE FROM contenido.biblioteca_item WHERE id=$1 AND negocio_id=$2 RETURNING media_path`, [id, negocioId]);
  return rows[0] || null;
}

// Nueva solicitud al bibliotecario (crear/editar un asset). La toma el worker.
async function crearSolicitudBiblioteca(negocioId, instruccion, origenUrl, origenTipo) {
  const { rows } = await pool.query(
    `INSERT INTO contenido.solicitudes_biblioteca (negocio_id, instruccion, origen_url, origen_tipo)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [negocioId, String(instruccion).slice(0, 2000), origenUrl || null, origenTipo || null]);
  return rows[0].id;
}

// Borra una solicitud/asset del bibliotecario; devuelve resultado_path para limpiar el archivo.
async function delSolicitudBiblioteca(negocioId, id) {
  const { rows } = await pool.query(
    `DELETE FROM contenido.solicitudes_biblioteca WHERE id=$1 AND negocio_id=$2 RETURNING resultado_path`, [id, negocioId]);
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
    SELECT p.id, p.slug, p.nombre, p.activo, p.gestion, p.ig_handle, p.dominio_web, pp.logo,
      coalesce(nullif(pp.slogan,''), left(coalesce(pp.brief_md,''), 160)) AS descripcion,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.negocio_id=p.id AND pz.canal='instagram' AND pz.estado='pendiente_aprobacion') AS ig_pend,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.negocio_id=p.id AND pz.canal='instagram' AND pz.estado='publicada') AS ig_pub,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.negocio_id=p.id AND pz.canal='aviso' AND pz.estado='pendiente_aprobacion') AS av_pend,
      (SELECT count(*)::int FROM contenido.piezas pz WHERE pz.negocio_id=p.id AND pz.canal='aviso' AND pz.estado='publicada') AS av_pub,
      ((SELECT count(*) FROM contenido.tg_briefs b
          LEFT JOIN contenido.piezas pz ON pz.id=b.pieza_id LEFT JOIN contenido.revisiones r ON r.id=pz.revision_vigente
          WHERE b.negocio_id=p.id AND ((b.pieza_id IS NULL AND b.estado IN ('propuesta','pendiente','procesando','error'))
                 OR (b.pieza_id IS NOT NULL AND r.estado IN ('pendiente_aprobacion','rechazada','aprobada','borrador'))))
       + (SELECT count(*) FROM contenido.solicitudes_propuesta s WHERE s.negocio_id=p.id AND s.estado IN ('pendiente','procesando')))::int AS req_cola
    FROM contenido.negocios p
    LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id=p.id
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
      JOIN contenido.negocios p ON p.id = pz.negocio_id
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
      JOIN contenido.negocios pr ON pr.id=pz.negocio_id
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
// Playlist de UN programa concreto, esté activo o no: es lo que consume el preview, para ver
// cómo queda la pantalla ANTES de activarla. Misma forma que la del activo -> el player no cambia.
async function getProgramaPlaylist(programaId) {
  const { rows: [p] } = await pool.query(
    'SELECT id, nombre, actualizado_en FROM contenido.programas WHERE id=$1', [programaId]);
  if (!p) return { version: 'none', nombre: null, items: [] };
  const { rows: items } = await pool.query(`
    SELECT (SELECT m.url FROM contenido.media m WHERE m.pieza_id=pz.id AND m.orden=1) AS url,
           (SELECT m.poster_url FROM contenido.media m WHERE m.pieza_id=pz.id AND m.orden=1) AS poster,
           r.duracion_s AS dur
    FROM contenido.programa_items i JOIN contenido.piezas pz ON pz.id=i.pieza_id JOIN contenido.revisiones r ON r.id=pz.revision_vigente
    WHERE i.programa_id=$1 ORDER BY i.orden`, [p.id]);
  return { version: p.id + ':' + new Date(p.actualizado_en).getTime(), nombre: p.nombre,
           preview: true, items: items.filter(x => x.url) };
}

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
      JOIN contenido.negocios pr ON pr.id=pz.negocio_id
    WHERE i.programa_id=$1 ORDER BY i.orden`, [p.id]);
  return { id: p.id, nombre: p.nombre, items };
}

// --- Landings: requerimientos de cambio de landing (borrador -> preview -> aprobación -> producción) ---
async function getLandingCambios(negocioId) {
  const { rows } = await pool.query(
    `SELECT id, requerimiento, estado, preview_url, commit_sha, resumen, motivo_rechazo, creado_en, actualizado_en
       FROM contenido.landing_cambios WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 30`, [negocioId]);
  return rows;
}
async function crearLandingCambio(negocioId, requerimiento) {
  const r = (requerimiento || '').trim();
  if (!r) return null;
  const { rows: [row] } = await pool.query(
    `INSERT INTO contenido.landing_cambios (negocio_id, requerimiento) VALUES ($1,$2) RETURNING id`, [negocioId, r]);
  return row.id;
}
// Aprobar: solo si es un borrador de ESTE proyecto -> 'aprobada' (el motor hace el merge a producción).
async function aprobarLanding(negocioId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.landing_cambios SET estado='aprobada', actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='borrador'`, [id, negocioId]);
  return rowCount > 0;
}
// Rechazar: agrega el motivo al requerimiento y vuelve a 'pendiente' -> el motor regenera el borrador.
async function rechazarLanding(negocioId, id, motivo) {
  const m = (motivo || '').trim();
  const { rowCount } = await pool.query(
    `UPDATE contenido.landing_cambios
        SET requerimiento = requerimiento || E'\n\nCorrección pedida: ' || $3,
            motivo_rechazo = $3, estado='pendiente', branch=NULL, preview_url=NULL, actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='borrador'`, [id, negocioId, m || 'ajustes']);
  return rowCount > 0;
}

// --- Auditoría de presencia digital (snapshot más reciente por proyecto/canal) ---
/**
 * Pide una auditoría. La corre un job del host: es el único que puede salir a la web y hablar con
 * la API de Meta. El panel sólo deja el pedido.
 */
async function pedirAuditoria(negocioId, usuarioId) {
  try {
    const { rows: [r] } = await pool.query(
      'INSERT INTO contenido.auditoria_req (negocio_id, pedido_por) VALUES ($1,$2) RETURNING id',
      [negocioId, usuarioId || null]);
    return { ok: true, id: r.id };
  } catch (e) {
    // El único parcial impide dos en curso: pedir de nuevo mientras corre gasta el doble.
    if (e.code === '23505') return { ok: false, error: 'ya_en_curso' };
    throw e;
  }
}

/** El estado del último pedido, para saber si hay que esperar o si algo falló. */
async function estadoAuditoria(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT id, estado, error, resumen, creado_en, iniciado_en, procesado_en
       FROM contenido.auditoria_req WHERE negocio_id=$1 ORDER BY creado_en DESC LIMIT 1`, [negocioId]);
  return r || null;
}

async function getAuditoria(negocioId, canal) {
  const { rows: [r] } = await pool.query(
    `SELECT canal, periodo, kpis, recomendaciones, creada_en FROM contenido.auditorias
      WHERE negocio_id=$1 AND canal=$2 ORDER BY creada_en DESC LIMIT 1`, [negocioId, canal || 'instagram']);
  return r || null;
}

// --- Pauta (Meta Marketing API, read-only): último snapshot guardado por cf-pauta-sync ---
async function getPauta(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT capturado_en, data FROM contenido.ads_snapshot WHERE negocio_id=$1`, [negocioId]);
  if (!r) return { configurada: false };
  return { configurada: true, capturado_en: r.capturado_en, ...r.data };
}

// Serie diaria para el gráfico de evolución.
async function getPautaEvolucion(negocioId) {
  const { rows } = await pool.query(
    `SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, gasto::float AS gasto,
            impresiones::int AS impresiones, alcance::int AS alcance, clics::int AS clics
       FROM contenido.ads_daily WHERE negocio_id=$1 ORDER BY fecha`, [negocioId]);
  return rows;
}

// Botón "Actualizar ahora": deja un pedido que el dispatcher consume y corre el sync.
async function pedirRefrescoPauta() {
  await pool.query(`INSERT INTO contenido.pauta_sync_req DEFAULT VALUES`);
  return true;
}

// --- Campañas de pauta: el creativo propone; Fer aprueba; se crean PAUSADAS en Meta ---
async function crearSolicitudCampania(negocioId, instruccion) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO contenido.solicitudes_campania (negocio_id, instruccion) VALUES ($1, $2) RETURNING id`,
    [negocioId, (instruccion || '').slice(0, 2000) || null]);
  return r.id;
}

async function getPautaCampanias(negocioId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.estado, c.nombre, c.objetivo, c.pieza_id, c.razon, c.audiencia, c.presupuesto,
            c.fecha_inicio, c.fecha_fin, c.url_destino, c.cta, c.resumen,
            c.meta_campaign_id, c.creado_en, c.aprobado_en,
            pz.numero AS pieza_numero, r.ig_permalink AS pieza_permalink, r.caption AS pieza_caption,
            m.url AS pieza_url, m.poster_url AS pieza_poster, m.tipo AS pieza_tipo
       FROM contenido.pauta_campania c
       LEFT JOIN contenido.piezas pz ON pz.id = c.pieza_id
       LEFT JOIN contenido.revisiones r ON r.pieza_id = c.pieza_id AND r.estado='publicada'
       LEFT JOIN contenido.media m ON m.pieza_id = c.pieza_id AND m.orden = 1
      WHERE c.negocio_id = $1 AND c.estado <> 'descartada'
      ORDER BY c.creado_en DESC`, [negocioId]);
  const { rows: [t] } = await pool.query(
    `SELECT count(*)::int AS n FROM contenido.solicitudes_campania
      WHERE negocio_id=$1 AND estado IN ('pendiente','procesando')`, [negocioId]);
  return { campanias: rows, trabajando: t ? t.n : 0 };
}

async function aprobarCampania(negocioId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.pauta_campania SET estado='aprobada', aprobado_en=now(), actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='propuesta'`, [id, negocioId]);
  return rowCount > 0;
}

async function rechazarCampania(negocioId, id, motivo) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.pauta_campania SET estado='rechazada', resumen=$3, actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado IN ('propuesta','aprobada')`,
    [id, negocioId, (motivo || 'rechazada').slice(0, 2000)]);
  return rowCount > 0;
}

async function descartarCampania(negocioId, id) {
  // Si ya existe en Meta, dejamos el pedido 'descartar' (el worker la borra allá y marca descartada).
  // Si no, se descarta directo.
  const { rowCount } = await pool.query(
    `UPDATE contenido.pauta_campania
        SET estado = CASE WHEN meta_campaign_id IS NOT NULL THEN 'descartar' ELSE 'descartada' END,
            actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado NOT IN ('descartada','descartar')`, [id, negocioId]);
  return rowCount > 0;
}

// Activar/pausar: el panel deja un pedido ('activar'/'pausar'); el worker lo aplica en Meta.
async function activarCampania(negocioId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.pauta_campania SET estado='activar', actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='pausada' AND meta_campaign_id IS NOT NULL`, [id, negocioId]);
  return rowCount > 0;
}
async function pausarCampania(negocioId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.pauta_campania SET estado='pausar', actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='activa'`, [id, negocioId]);
  return rowCount > 0;
}
// Posts ya publicados en IG que pueden usarse como creativo de una campaña.
async function getCreativosDisponibles(negocioId) {
  const { rows } = await pool.query(
    `SELECT pz.id AS pieza_id, pz.numero, r.caption, r.ig_permalink AS permalink,
            m.url, m.poster_url, m.tipo
       FROM contenido.piezas pz
       JOIN contenido.revisiones r ON r.pieza_id = pz.id AND r.estado='publicada'
       JOIN contenido.media m ON m.pieza_id = pz.id AND m.orden = 1
      WHERE pz.negocio_id = $1 AND pz.canal='instagram'
      ORDER BY pz.numero DESC LIMIT 40`, [negocioId]);
  return rows;
}

// Cambiar el creativo (pieza) de una propuesta — sólo antes de crearse en Meta.
async function setCreativoCampania(negocioId, id, piezaId) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.pauta_campania SET pieza_id=$3, actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='propuesta'
        AND EXISTS (SELECT 1 FROM contenido.piezas WHERE id=$3 AND negocio_id=$2)`,
    [id, negocioId, piezaId]);
  return rowCount > 0;
}

async function reintentarCampania(negocioId, id) {
  const { rowCount } = await pool.query(
    `UPDATE contenido.pauta_campania SET estado='aprobada', resumen=NULL, actualizado_en=now()
      WHERE id=$1 AND negocio_id=$2 AND estado='error' AND meta_campaign_id IS NULL`, [id, negocioId]);
  return rowCount > 0;
}

async function health() {
  await pool.query('SELECT 1');
  return true;
}

module.exports = {
  ENGANCHES, ENGANCHE_POR_TIPO,
  getUsuarioPorEmail, getUsuario, getUsuarios, tocarAcceso, crearUsuario, actualizarUsuario, setNegociosDeUsuario,
  completarPerfil, marcarInvitado, getUsuarioPorWhatsapp, whatsappEnUso, logWhatsapp, whatsappYaVisto, transcripcionDe, fichaNegocio, clientePorTelefono,
  TIPOS_BENEFICIO, textoBeneficio, getBeneficios, guardarBeneficio,
  muestraBeneficio, canjearEnMostrador,

  getSkills, getSkill, guardarSkill, getSkillHistorial, getSkillVersion,
  confirmarAccion,
  getPropuestasCampania,
  pedirPropuestaCampania, getPropuestaCampania, aceptarSugerencia,
  guardarResumenPropuesta, aprobarPropuesta, materializarPropuesta, getEstadoPropuesta,
  OBJETIVOS_CAMPANIA, TIPOS_ACCION, getCampanias, getCampania, guardarCampania,
  estadoCampania, guardarAccion, borrarAccion, opcionesAccion,
  emitirInvitaciones, getInvitaciones, anularInvitacion, consultarInvitacion,
  cerrarUso, liberarPorReserva, invitacionDeReserva, condicionesLegibles, piezasPublicadas, codigoPieza,
  reservaTarjeta, pedirTarjeta,
  invitacionesActivas, guardarToken, getUsuarioPorToken, consumirToken,
  getNegocios, getProyectoId, getPerfil, getIgToken, guardarPerfil, getTextoHistorial, getTextoVersion, setLogo, getResumenAgencia,
  getIdentidad, guardarIdentidad, getCatalogosIdentidad, setMapeoAtributo,
  getClientes, crearCliente, actualizarCliente, borrarCliente, exportarClientes, borrarTodosLosClientes,
  getConfigReservas, guardarConfigReservas, UNIDADES, getTurnos, guardarTurno, borrarTurno,
  getBloqueos, crearBloqueo, borrarBloqueo,
  getDisponibilidad, getReservas, crearReserva, cambiarEstadoReserva,
  crearLink, getLinks, setLinkActivo, getPiezasParaAccion,
  destinatariosAviso, datosParaAviso,
  getWhatsappNegocio, guardarWhatsappNegocio, verificarWhatsappNegocio, PLANTILLAS_RESERVA,
  secretoDeNumero, negocioPorPhoneId,
  getConversacion, setConversacion, borrarConversacion, podarConversaciones, reservasPorWhatsapp,
  CAPS_BOT, getCanalWhatsapp, guardarCanalWhatsapp, getInbox, getConversacionInbox, marcarAtendido,
  negocioPublico, disponibilidadPublica, registrarApertura, marcarCompletado, linkDeApertura,
  ofertaLanding, guardarQueExponeLanding,
  getCapacidades, getCapacidadesTodas, setCapacidad, crearNegocio, GRUPOS_CAP,
  crearDescubrimiento, getDescubrimiento,
  getLente, getLenteToken, guardarLente, getVerificacion, getSaludExterna,
  getContactos, guardarContactos, crearAvisoManual, getProgramaPlaylist, urlsDeMediaDelNegocio,
  pedirGeneracion, getGeneracion,
  FORMATOS, getGraficas, contarGraficasDescartadas, getGrafica, crearGrafica, iterarGrafica, duplicarGrafica, estadoGrafica,
  getPiezas, getPiezaCanal, avisoEstado, setColaboradores, getRequerimientos, getBriefMedia, getStatus, getMaquinas, getTokenPendiente, getBitacora, getBiblioteca, crearSolicitudBiblioteca, delSolicitudBiblioteca,
  ensureCarpetasBiblioteca, crearCarpetaBiblioteca, delCarpetaBiblioteca, crearItemBiblioteca, moverItemBiblioteca, delItemBiblioteca,
  pedirPropuestas, addMaterial, getMateriales, getMaterialFile, delMaterial,
  addMaterialPorPieza, getMaterialesPorPieza, delMaterialPorPieza, generarReq, revisarReq, activarReq, descartarReq, insertMencion,
  getPostIdsPublicados, upsertMetricas,
  getPantallaActiva, getPantallaPorSlug, getPantallas, crearPantalla, actualizarPantalla, eliminarPantalla, getProgramaActivo,
  getAvisosAprobados, getProgramas, getPrograma, crearPrograma, guardarPrograma, activarPrograma, eliminarPrograma, getActivoPlaylist,
  getLandingCambios, crearLandingCambio, aprobarLanding, rechazarLanding,
  getAuditoria, pedirAuditoria, estadoAuditoria, getPauta, getPautaEvolucion, pedirRefrescoPauta,
  crearSolicitudCampania, getPautaCampanias, aprobarCampania, rechazarCampania, descartarCampania,
  activarCampania, pausarCampania, reintentarCampania, getCreativosDisponibles, setCreativoCampania,
  health };
