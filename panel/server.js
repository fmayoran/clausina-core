// Panel de publicaciones de Cortafuego — backend Node/Express (read-only).
// Sirve la UI estática (public/) + una API JSON. La SQL vive en db.js.
// Se sirve detrás del proxy de la landing en cortafuego.ar/panel/ (Nginx → este servicio).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const archiver = require('archiver');
const db = require('./db');
const vnnox = require('./vnnox');

const app = express();
const PORT = Number(process.env.PORT || 3001);
// Base de los webhooks de n8n que disparan publicar/rechazar (mismos que usan mail y Telegram).
const N8N = (process.env.N8N_WEBHOOK_BASE || 'https://crm-n8n.dhmtev.easypanel.host/webhook').replace(/\/$/, '');
const BOT = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.PANEL_TG_CHAT || '811183062';
const IG_TOKEN = process.env.IG_TOKEN || '';
const IG_USER_ID = process.env.IG_USER_ID || '27632458043024661';
const IG_API = 'https://graph.instagram.com/v19.0';

// Captura menciones entrantes (media donde nos etiquetan, edge /tags) y las deja en la cola
// como propuesta (origen='mencion') para que Fer decida: generar publicación o descartar. Avisa por Telegram.
async function refreshMenciones() {
  try {
    // El token/cuenta de IG es de Cortafuego: las menciones entrantes se atribuyen a esa marca.
    // Token: del perfil (DB, cifrado) con fallback al env. (Cuando cada marca tenga el suyo, esto se vuelve por-marca.)
    const pid = await db.getProyectoId('cortafuego');
    const tok = (await db.getIgToken('cortafuego')) || IG_TOKEN;
    if (!tok) return;
    const d = await fetch(`${IG_API}/${IG_USER_ID}/tags?fields=id,username,permalink,timestamp&limit=25&access_token=${tok}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    if (!d || !d.data) return;
    for (const m of d.data) {
      const nueva = await db.insertMencion(m.id, m.username || 'alguien', m.permalink || '', pid);
      if (nueva && BOT) {
        const txt = `Te etiquetaron en Instagram: @${m.username}. Quedó en la cola del panel para que decidas (generar publicación o descartar).\n${m.permalink || ''}`;
        await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: txt, disable_web_page_preview: false }) }).catch(() => {});
      }
    }
  } catch (e) { console.error('menciones', e.message); }
}

// Refresca las métricas de IG de las piezas publicadas y las cachea en la base.
// Insights de NUESTRA propia cuenta (el token de publicación tiene permiso). Stories viejas expiran → se saltean.
async function refreshMetricas() {
  const tok = (await db.getIgToken('cortafuego')) || IG_TOKEN;
  if (!tok) return;
  const metric = 'views,reach,likes,comments,saved,shares,total_interactions';
  let ok = 0;
  for (const id of await db.getPostIdsPublicados()) {
    try {
      const d = await fetch(`${IG_API}/${id}/insights?metric=${metric}&access_token=${tok}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
      if (!d || !d.data) continue;               // p.ej. story expirada o métrica no soportada
      const v = {}; d.data.forEach(x => { v[x.name] = x.values && x.values[0] ? x.values[0].value : 0; });
      await db.upsertMetricas(id, v); ok++;
    } catch (_) { /* seguir con el resto */ }
  }
  console.log(`métricas refrescadas: ${ok}`);
}

// --- Sesión: contraseña compartida + cookie firmada (HMAC), sin dependencias extra ---
const PASSWORD = process.env.PANEL_PASSWORD || '';
const SECRET = process.env.PANEL_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'cf_panel';
const COOKIE_PATH = process.env.PANEL_COOKIE_PATH || '/panel';
const TTL_S = 14 * 24 * 3600;
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
const issue = () => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_S * 1000 })).toString('base64url'); return `${p}.${sign(p)}`; };
function valid(tok) {
  if (!tok || !tok.includes('.')) return false;
  const [p, s] = tok.split('.');
  if (sign(p) !== s) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function readCookie(req) {
  const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  return c ? decodeURIComponent(c.slice(COOKIE.length + 1)) : '';
}

app.disable('x-powered-by');
app.use(express.json({ limit: '120mb' }));  // material/logo van como dataURL base64; un video sube ~33% -> holgura para archivos de ~85MB

// Públicos (sin sesión): health, pantalla de login y sus fuentes, login/logout.
app.get('/api/health', async (req, res) => { try { await db.health(); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); } });
app.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts'), { maxAge: '30d' }));
// Almacén de medios de la agencia (volumen persistente /app/media): imágenes para panel, IG, landings, creativo. Público.
app.use('/media', express.static('/app/media', { maxAge: '30d' }));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// Públicos para la PANTALLA: el reproductor (kiosco) y la playlist activa que poolea.
app.get('/play', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'pantalla-play.html')); });
// Player público: la pantalla viene por query param (?pantalla=<slug>); default = la pantalla activa.
app.get('/api/pantalla/activo', async (req, res) => {
  try {
    const pa = req.query.pantalla ? await db.getPantallaPorSlug(String(req.query.pantalla)) : await db.getPantallaActiva();
    res.set('Cache-Control', 'no-store');
    res.json(pa ? await db.getActivoPlaylist(pa.id) : { version: 'none', nombre: null, items: [] });
  } catch (e) { console.error('activo', e.message); res.status(500).json({ error: 'db', items: [] }); }
});
app.post('/api/login', (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  if (!PASSWORD || pw !== PASSWORD) return res.status(401).json({ ok: false });
  res.set('Set-Cookie', `${COOKIE}=${issue()}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_S}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// Compuerta: todo lo demás (datos, acciones, board) requiere sesión válida.
app.use((req, res, next) => {
  if (valid(readCookie(req))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth' });
  return res.redirect('login');
});

// --- Marca activa (multi-tenant): cookie cf_marca -> proyecto_id en req. Default cortafuego. ---
const MARCA_COOKIE = 'cf_marca';
function readMarca(req) {
  const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(MARCA_COOKIE + '='));
  return c ? decodeURIComponent(c.slice(MARCA_COOKIE.length + 1)) : '';
}
app.use(async (req, res, next) => {
  try {
    let slug = readMarca(req) || 'cortafuego';
    let pid = await db.getProyectoId(slug);
    if (!pid) { slug = 'cortafuego'; pid = await db.getProyectoId('cortafuego'); }
    req.marca = slug; req.proyectoId = pid;
    next();
  } catch (e) { console.error('marca', e.message); res.status(500).json({ error: 'marca' }); }
});

// Lista de marcas (para el selector) + cuál está activa en esta sesión.
app.get('/api/marcas', async (req, res) => {
  try {
    const marcas = (await db.getMarcas()).map(m => ({ slug: m.slug, nombre: m.nombre, activo: m.activo, logo: m.logo }));
    res.json({ marcas, activa: req.marca });
  } catch (e) { console.error('marcas', e.message); res.status(500).json({ error: 'db' }); }
});

// Dashboard de la Agencia: todos los proyectos con descripción + indicadores (no scopeado a una marca).
app.get('/api/agencia', async (req, res) => {
  try { res.json(await db.getResumenAgencia()); }
  catch (e) { console.error('agencia', e.message); res.status(500).json({ error: 'db' }); }
});

// Cambia la marca activa de la sesión (valida contra las marcas conocidas).
app.post('/api/marca', async (req, res) => {
  const slug = String((req.body && req.body.slug) || '');
  const ok = (await db.getMarcas()).some(m => m.slug === slug);
  if (!ok) return res.status(400).json({ ok: false, error: 'marca_invalida' });
  res.set('Set-Cookie', `${MARCA_COOKIE}=${encodeURIComponent(slug)}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_S}`);
  res.json({ ok: true });
});

// Llama al webhook de n8n y devuelve el status HTTP. Timeout amplio: el publish sube media y poolea.
// Reintenta ante fallo de RED/DNS (el hostname de n8n resuelve intermitentemente desde el
// contenedor -> EAI_AGAIN / "fetch failed"). No reintenta si n8n responde un status HTTP
// (eso no lanza): un rechazo real se respeta. Sólo los errores de conexión se reintentan.
async function callWebhook(url, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
      return r.status;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

app.get('/api/piezas', async (req, res) => {
  try {
    const canal = ['instagram', 'aviso'].includes(req.query.canal) ? req.query.canal : undefined;
    res.json(await db.getPiezas(canal, req.proyectoId));
  } catch (e) { console.error('piezas', e.message); res.status(500).json({ error: 'db' }); }
});

app.get('/api/requerimientos', async (req, res) => {
  try { res.json(await db.getRequerimientos(req.proyectoId)); }
  catch (e) { console.error('requerimientos', e.message); res.status(500).json({ error: 'db' }); }
});

app.get('/api/status', async (req, res) => {
  try { res.json(await db.getStatus(req.proyectoId)); }
  catch (e) { console.error('status', e.message); res.status(500).json({ error: 'db' }); }
});

// Sala de máquinas: pulso del motor (pipeline agregado + latido de procesos). No scopeado a una marca.
app.get('/api/maquinas', async (req, res) => {
  try { res.json(await db.getMaquinas()); }
  catch (e) { console.error('maquinas', e.message); res.status(500).json({ error: 'db' }); }
});

// Perfil del proyecto (registro de marca, por marca activa). Lo consume el creativo.
// Capacidades de la marca activa: qué funcionalidades usa (habilitada) y si están configuradas.
app.get('/api/capacidades', async (req, res) => {
  try { res.json(await db.getCapacidades(req.proyectoId)); }
  catch (e) { console.error('capacidades', e.message); res.status(500).json({ error: 'db' }); }
});
// Grilla de agencia: todas las marcas y qué tiene configurada cada una (cross-marca).
app.get('/api/capacidades/todas', async (req, res) => {
  try { res.json(await db.getCapacidadesTodas()); }
  catch (e) { console.error('capacidades-todas', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/capacidades/:cap', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await db.setCapacidad(req.proyectoId, req.params.cap, { habilitada: !!b.habilitada, config: b.config });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { console.error('capacidad-set', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

app.get('/api/perfil', async (req, res) => {
  try { res.json(await db.getPerfil(req.proyectoId)); }
  catch (e) { console.error('perfil', e.message); res.status(500).json({ error: 'db' }); }
});
app.put('/api/perfil', async (req, res) => {
  try { res.json({ ok: await db.guardarPerfil(req.proyectoId, req.body || {}) }); }
  catch (e) { console.error('guardar perfil', e.message); res.status(500).json({ ok: false, error: e.code || 'db' }); }
});

// Subir/actualizar el logo de la marca activa: imagen (dataUrl base64) -> media store -> setea el campo logo.
const LOGO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' };
app.post('/api/perfil/logo', async (req, res) => {
  try {
    const dataUrl = String((req.body && req.body.dataUrl) || '');
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m || !LOGO_EXT[m[1]]) return res.status(400).json({ ok: false, error: 'imagen_invalida' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'muy_grande' });
    const dir = path.join('/app/media', 'marca', req.marca);
    await fs.promises.mkdir(dir, { recursive: true });
    const fname = `logo-${Date.now()}.${LOGO_EXT[m[1]]}`;
    await fs.promises.writeFile(path.join(dir, fname), buf);
    const url = `https://${req.get('host')}/media/marca/${req.marca}/${fname}`;
    await db.setLogo(req.proyectoId, url);
    res.json({ ok: true, url });
  } catch (e) { console.error('logo upload', e.message); res.status(500).json({ ok: false, error: 'upload' }); }
});

// --- Landing del proyecto (cambios con borrador -> preview -> aprobación -> producción) ---
app.get('/api/landing', async (req, res) => {
  try { res.json(await db.getLandingCambios(req.proyectoId)); }
  catch (e) { console.error('landing list', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/landing', async (req, res) => {
  try { const id = await db.crearLandingCambio(req.proyectoId, (req.body || {}).requerimiento);
    res.json(id ? { ok: true, id } : { ok: false, error: 'requerimiento vacío' }); }
  catch (e) { console.error('landing crear', e.message); res.status(500).json({ ok: false }); }
});
app.post('/api/landing/:id/aprobar', async (req, res) => {
  try { res.json({ ok: await db.aprobarLanding(req.proyectoId, req.params.id) }); }
  catch (e) { console.error('landing aprobar', e.message); res.status(500).json({ ok: false }); }
});
app.post('/api/landing/:id/rechazar', async (req, res) => {
  try { res.json({ ok: await db.rechazarLanding(req.proyectoId, req.params.id, (req.body || {}).motivo) }); }
  catch (e) { console.error('landing rechazar', e.message); res.status(500).json({ ok: false }); }
});

// --- Auditoría de presencia digital del proyecto ---
app.get('/api/auditoria', async (req, res) => {
  try { res.json(await db.getAuditoria(req.proyectoId, req.query.canal)); }
  catch (e) { console.error('auditoria', e.message); res.status(500).json({ error: 'db' }); }
});

// Pauta (Meta Marketing API, read-only): último snapshot sincronizado por cf-pauta-sync.
app.get('/api/pauta', async (req, res) => {
  try { res.json(await db.getPauta(req.proyectoId)); }
  catch (e) { console.error('pauta', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/pauta/evolucion', async (req, res) => {
  try { res.json(await db.getPautaEvolucion(req.proyectoId)); }
  catch (e) { console.error('pauta-evol', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/pauta/refrescar', async (req, res) => {
  try { res.json({ ok: await db.pedirRefrescoPauta() }); }
  catch (e) { console.error('pauta-refrescar', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Campañas de pauta: propuestas del creativo + su ciclo de aprobación.
app.get('/api/campanias', async (req, res) => {
  try { res.json(await db.getCampanias(req.proyectoId)); }
  catch (e) { console.error('campanias', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/solicitar', async (req, res) => {
  try { res.json({ ok: true, id: await db.crearSolicitudCampania(req.proyectoId, (req.body || {}).instruccion) }); }
  catch (e) { console.error('campania-solicitar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/aprobar', async (req, res) => {
  try { res.json({ ok: await db.aprobarCampania(req.proyectoId, req.params.id) }); }
  catch (e) { console.error('campania-aprobar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/rechazar', async (req, res) => {
  try { res.json({ ok: await db.rechazarCampania(req.proyectoId, req.params.id, (req.body || {}).motivo) }); }
  catch (e) { console.error('campania-rechazar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/descartar', async (req, res) => {
  try { res.json({ ok: await db.descartarCampania(req.proyectoId, req.params.id) }); }
  catch (e) { console.error('campania-descartar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/activar', async (req, res) => {
  try { res.json({ ok: await db.activarCampania(req.proyectoId, req.params.id) }); }
  catch (e) { console.error('campania-activar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/pausar', async (req, res) => {
  try { res.json({ ok: await db.pausarCampania(req.proyectoId, req.params.id) }); }
  catch (e) { console.error('campania-pausar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/reintentar', async (req, res) => {
  try { res.json({ ok: await db.reintentarCampania(req.proyectoId, req.params.id) }); }
  catch (e) { console.error('campania-reintentar', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/campanias/creativos', async (req, res) => {
  try { res.json(await db.getCreativosDisponibles(req.proyectoId)); }
  catch (e) { console.error('campania-creativos', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/creativo', async (req, res) => {
  try { res.json({ ok: await db.setCreativoCampania(req.proyectoId, req.params.id, (req.body || {}).pieza_id) }); }
  catch (e) { console.error('campania-creativo', e.message); res.status(500).json({ error: 'db' }); }
});

// Stremea una foto de Telegram (resuelve file_id -> file_path -> bytes, con el token server-side).
async function proxyTelegramPhoto(res, fileId) {
  if (!fileId) return res.status(404).end();
  if (!BOT) return res.status(503).end();
  const gf = await fetch(`https://api.telegram.org/bot${BOT}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
  const fp = gf && gf.result && gf.result.file_path;
  if (!fp) return res.status(404).end();
  const img = await fetch(`https://api.telegram.org/file/bot${BOT}/${fp}`, { signal: AbortSignal.timeout(8000) });
  if (!img.ok) return res.status(502).end();
  const ct = img.headers.get('content-type');
  res.set('Content-Type', (ct && ct.startsWith('image/')) ? ct : 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(await img.arrayBuffer()));
}

// Proxy de la miniatura de un requerimiento (foto que mandó Fer por Telegram, media_file_id legacy).
app.get('/api/brief/:id/media', async (req, res) => {
  try {
    const m = await db.getBriefMedia(req.params.id);
    if (!m || m.media_type !== 'photo') return res.status(404).end();
    await proxyTelegramPhoto(res, m.media_file_id);
  } catch (e) { console.error('brief media', e.message); res.status(500).end(); }
});

// Proxy de la miniatura de un material puntual de la galería (preview en el modal).
app.get('/api/material/:mid/media', async (req, res) => {
  try {
    const m = await db.getMaterialFile(req.params.mid);
    if (!m) return res.status(404).end();
    if (m.media_path) return res.redirect('/media/' + m.media_path.split('/').map(encodeURIComponent).join('/'));  // media store en disco
    if (m.media_type !== 'photo') return res.status(404).end();
    await proxyTelegramPhoto(res, m.media_file_id);   // legacy: material viejo en Telegram
  } catch (e) { console.error('material media', e.message); res.status(500).end(); }
});

// --- Acciones sobre pendientes (protegidas por la sesión del panel) ---
// El navegador manda solo el id de la pieza; el server resuelve el token y llama a n8n.
// Acciones canal-aware: Instagram → webhooks n8n (Graph API); Aviso → estado directo en la base.
app.post('/api/piezas/:id/aprobar', async (req, res) => {
  try {
    const p = await db.getPiezaCanal(req.params.id);
    if (!p || p.estado !== 'pendiente_aprobacion') return res.status(409).json({ ok: false, error: 'no_pendiente' });
    if (p.canal === 'aviso') return res.json({ ok: await db.avisoEstado(req.params.id, 'publicada') });
    if (req.body && Array.isArray(req.body.colaboradores)) await db.setColaboradores(req.params.id, req.body.colaboradores);
    const status = await callWebhook(`${N8N}/cf-pub-publish?token=${encodeURIComponent(p.token)}`);
    res.json({ ok: status >= 200 && status < 300, status });
  } catch (e) { console.error('aprobar', e.message); res.status(500).json({ ok: false, error: 'webhook' }); }
});

app.post('/api/piezas/:id/rechazar', async (req, res) => {
  try {
    const motivo = String((req.body && req.body.motivo) || '').trim().slice(0, 500);
    if (!motivo) return res.status(400).json({ ok: false, error: 'motivo_requerido' });
    const p = await db.getPiezaCanal(req.params.id);
    if (!p || p.estado !== 'pendiente_aprobacion') return res.status(409).json({ ok: false, error: 'no_pendiente' });
    if (p.canal === 'aviso') return res.json({ ok: await db.avisoEstado(req.params.id, 'rechazada', motivo) });
    const url = `${N8N}/cf-pub-decide?token=${encodeURIComponent(p.token)}&accion=rechazar&motivo=${encodeURIComponent(motivo)}`;
    const status = await callWebhook(url);
    res.json({ ok: status >= 200 && status < 300, status });
  } catch (e) { console.error('rechazar', e.message); res.status(500).json({ ok: false, error: 'webhook' }); }
});

app.post('/api/piezas/:id/descartar', async (req, res) => {
  try {
    const p = await db.getPiezaCanal(req.params.id);
    if (!p || p.estado !== 'pendiente_aprobacion') return res.status(409).json({ ok: false, error: 'no_pendiente' });
    if (p.canal === 'aviso') return res.json({ ok: await db.avisoEstado(req.params.id, 'descartada') });
    const status = await callWebhook(`${N8N}/cf-pub-decide?token=${encodeURIComponent(p.token)}&accion=descartar`);
    res.json({ ok: status >= 200 && status < 300, status });
  } catch (e) { console.error('descartar', e.message); res.status(500).json({ ok: false, error: 'webhook' }); }
});

// --- Propuestas del creativo + gestión de la cola de requerimientos ---
app.post('/api/proponer', async (req, res) => {
  try {
    const enfasis = String((req.body && req.body.enfasis) || '').trim().slice(0, 1000);
    const canal = req.body && req.body.canal === 'aviso' ? 'aviso' : 'instagram';
    const cantidad = Math.min(8, Math.max(1, parseInt(req.body && req.body.cantidad, 10) || 5));
    const material = Array.isArray(req.body && req.body.material) ? req.body.material : [];
    await db.pedirPropuestas(enfasis, canal, cantidad, req.proyectoId, material);
    res.json({ ok: true });
  } catch (e) { console.error('proponer', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Staging de material para un pedido de propuestas (aún sin solicitud): guarda a disco y
// devuelve el media_path; /api/proponer lo vincula. Imagen por base64; video por streaming+ffmpeg.
app.post('/api/proponer/material', async (req, res) => {
  try {
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('material/prop', req.marca));
    res.json({ ok: true, media_path: mediaPath, media_type: mediaType, filename });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});
// Adjuntar material ELIGIÉNDOLO de la biblioteca: copia el archivo al staging del pedido.
app.post('/api/proponer/material-biblioteca', async (req, res) => {
  try {
    const srcRel = String((req.body && req.body.media_path) || '').replace(/^\/+/, '').replace(/^media\//, '');
    if (!srcRel || srcRel.includes('..')) return res.status(400).json({ ok: false, error: 'ruta' });
    const src = path.join('/app/media', srcRel);
    const ext = ((srcRel.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('material/prop', req.marca, crypto.randomUUID() + '.' + ext);
    const dst = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    const mediaType = (req.body && req.body.tipo === 'video') ? 'video' : 'photo';
    res.json({ ok: true, media_path: rel, media_type: mediaType, filename: (req.body && req.body.filename) || null });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'copy' }); }
});
app.post('/api/proponer/material-video', async (req, res) => {
  const tmp = path.join('/tmp', 'up_' + crypto.randomUUID() + '.src');
  try {
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'video.mp4')).slice(0, 120);
    const MAX = 600 * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > MAX) { const e = new Error('El video supera los 600MB'); e.http = 413; throw e; }
    await recibirStream(req, tmp, MAX);
    const rel = path.posix.join('material/prop', req.marca, crypto.randomUUID() + '.mp4');
    const abs = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await comprimirVideo(tmp, abs);
    res.json({ ok: true, media_path: rel, media_type: 'video', filename: filename.replace(/\.[^.]+$/, '') });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
  finally { fs.promises.unlink(tmp).catch(() => {}); }
});

app.post('/api/requerimientos/:id/activar', async (req, res) => {
  try { res.json({ ok: await db.activarReq(req.params.id) }); }
  catch (e) { console.error('activar', e.message); res.status(500).json({ ok: false }); }
});

app.post('/api/requerimientos/:id/descartar', async (req, res) => {
  try { res.json({ ok: await db.descartarReq(req.params.id) }); }
  catch (e) { console.error('descartar req', e.message); res.status(500).json({ ok: false }); }
});

// "Generar publicación": guarda los comentarios y manda el requerimiento al circuito -> 'pendiente'.
app.post('/api/requerimientos/:id/generar', async (req, res) => {
  try {
    const comentarios = String((req.body && req.body.comentarios) || '').trim();
    res.json({ ok: await db.generarReq(req.params.id, comentarios) });
  } catch (e) { console.error('generar req', e.message); res.status(500).json({ ok: false }); }
});

// "Pedir nueva versión": guarda comentarios y manda la propuesta a que el creativo reescriba el concepto -> 'revisar'.
app.post('/api/requerimientos/:id/revisar', async (req, res) => {
  try {
    const comentarios = String((req.body && req.body.comentarios) || '').trim();
    if (!comentarios) return res.status(400).json({ ok: false, error: 'comentarios_requerido' });
    res.json({ ok: await db.revisarReq(req.params.id, comentarios) });
  } catch (e) { console.error('revisar req', e.message); res.status(500).json({ ok: false }); }
});

// Biblioteca de medios de la marca activa: piezas + material aportado + assets de marca (logos).
app.get('/api/biblioteca', async (req, res) => {
  try {
    await db.ensureCarpetasBiblioteca(req.proyectoId);
    const data = await db.getBiblioteca(req.proyectoId);
    // Logo actual del perfil (puede ser URL del media store o de la landing; distinto del archivo en disco).
    const logoUrl = (data.logo && /^(https?:\/\/|\/media\/)/.test(data.logo)) ? data.logo : null;
    const logoBase = logoUrl ? decodeURIComponent(logoUrl.split('?')[0].split('/').pop() || '') : null;
    let marca = [];
    try {
      const dir = path.join('/app/media', 'marca', req.marca);
      const files = await fs.promises.readdir(dir);
      const items = await Promise.all(files.filter(f => !f.startsWith('.')).map(async f => {
        const st = await fs.promises.stat(path.join(dir, f)).catch(() => null);
        const tipo = /\.(mp4|webm|mov)$/i.test(f) ? 'video' : 'image';
        return { url: '/media/marca/' + encodeURIComponent(req.marca) + '/' + encodeURIComponent(f), filename: f, tipo, fecha: st ? st.mtime : null };
      }));
      marca = items.filter(it => it.filename !== logoBase).sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
    } catch (_) { /* sin carpeta de marca todavía */ }
    // El logo del perfil va primero (sea del store o de la landing).
    if (logoUrl) marca.unshift({ url: logoUrl, filename: logoBase || 'logo de marca', tipo: /\.(mp4|webm|mov)$/i.test(logoUrl) ? 'video' : 'image', fecha: null });
    // Espacio por carpeta (stat de los archivos en disco; Piezas es externa -> sin tamaño).
    const fbytes = async rel => { try { const st = await fs.promises.stat(path.join('/app/media', String(rel).replace(/^\/?(media\/)?/, ''))); return st.size; } catch { return 0; } };
    const sumB = async arr => (await Promise.all(arr.map(fbytes))).reduce((a, b) => a + b, 0);
    const [bEnProcI, bTerm, bMat, bMarca] = await Promise.all([
      sumB(data.items.filter(i => i.carpeta === 'En proceso').map(i => i.media_path)),
      sumB(data.items.filter(i => i.carpeta === 'Terminado').map(i => i.media_path)),
      sumB(data.material.map(m => m.media_path)),
      sumB(marca.filter(m => /^\/media\//.test(m.url)).map(m => m.url)),
    ]);
    const folderSizes = { 'En proceso': bEnProcI + bMat, 'Terminado': bTerm, 'Marca': bMarca };
    res.json({ piezas: data.piezas, material: data.material, marca, items: data.items || [], carpetas: data.carpetas || [], trabajando: data.trabajando || [], folderSizes });
  } catch (e) { console.error('biblioteca', e.message); res.status(500).json({ error: 'db' }); }
});

// Subir un archivo nuevo al taller (a una carpeta).
app.post('/api/biblioteca/subir', async (req, res) => {
  try {
    const carpeta = String((req.body && req.body.carpeta) || 'En proceso').slice(0, 60);
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('biblioteca', req.marca));
    const id = await db.crearItemBiblioteca(req.proyectoId, mediaPath, mediaType, filename, carpeta);
    res.json({ ok: true, id });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});

// Subida de VIDEO por streaming crudo + compresión ffmpeg (para archivos grandes que no
// caben en el límite de base64). El cuerpo es el video tal cual; metadatos en headers.
app.post('/api/biblioteca/subir-video', async (req, res) => {
  const tmp = path.join('/tmp', 'up_' + crypto.randomUUID() + '.src');
  try {
    const carpeta = String(req.headers['x-carpeta'] || 'En proceso').slice(0, 60);
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'video.mp4')).slice(0, 120);
    const MAX = 600 * 1024 * 1024;  // 600MB de entrada (se comprime a mucho menos)
    if (Number(req.headers['content-length'] || 0) > MAX) { const e = new Error('El video supera los 600MB'); e.http = 413; throw e; }
    await recibirStream(req, tmp, MAX);
    const rel = path.posix.join('biblioteca', req.marca, crypto.randomUUID() + '.mp4');
    const abs = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await comprimirVideo(tmp, abs);
    const nombre = filename.replace(/\.[^.]+$/, '');
    const id = await db.crearItemBiblioteca(req.proyectoId, rel, 'video', nombre, carpeta);
    res.json({ ok: true, id });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
  finally { fs.promises.unlink(tmp).catch(() => {}); }
});
// Preservar un asset (p.ej. material aportado, que se depura) copiándolo a la base "Terminado".
app.post('/api/biblioteca/preservar', async (req, res) => {
  try {
    const srcRel = String((req.body && req.body.media_path) || '').replace(/^\/+/, '').replace(/^media\//, '');
    if (!srcRel || srcRel.includes('..')) return res.status(400).json({ ok: false });
    const src = path.join('/app/media', srcRel);
    const ext = ((srcRel.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('biblioteca', req.marca, crypto.randomUUID() + '.' + ext);
    const dst = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    const tipo = (req.body && req.body.tipo === 'video') ? 'video' : 'image';
    const id = await db.crearItemBiblioteca(req.proyectoId, rel, tipo, (req.body && req.body.nombre) || null, 'Terminado', 'aportado');
    res.json({ ok: true, id });
  } catch (e) { console.error('preservar', e.message); res.status(500).json({ ok: false }); }
});
// Crear / borrar carpeta del taller.
app.post('/api/biblioteca/carpeta', async (req, res) => {
  try {
    const nombre = String((req.body && req.body.nombre) || '').trim();
    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });
    res.json({ ok: await db.crearCarpetaBiblioteca(req.proyectoId, nombre) });
  } catch (e) { console.error('biblio carpeta', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/biblioteca/carpeta/:nombre', async (req, res) => {
  try { res.json({ ok: await db.delCarpetaBiblioteca(req.proyectoId, decodeURIComponent(req.params.nombre)) }); }
  catch (e) { console.error('biblio del carpeta', e.message); res.status(500).json({ ok: false }); }
});
// Mover / borrar un ítem del taller.
app.post('/api/biblioteca/item/:id/mover', async (req, res) => {
  try {
    const carpeta = String((req.body && req.body.carpeta) || '').trim();
    if (!carpeta) return res.status(400).json({ ok: false, error: 'carpeta_requerida' });
    res.json({ ok: await db.moverItemBiblioteca(req.proyectoId, req.params.id, carpeta) });
  } catch (e) { console.error('biblio mover', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/biblioteca/item/:id', async (req, res) => {
  try {
    const row = await db.delItemBiblioteca(req.proyectoId, req.params.id);
    if (row && row.media_path) borrarMediaFile(row.media_path);
    res.json({ ok: !!row });
  } catch (e) { console.error('biblio del item', e.message); res.status(500).json({ ok: false }); }
});

// Pedido al bibliotecario: crear/editar un asset (instruccion + fuente opcional). Lo procesa el worker.
app.post('/api/biblioteca/solicitar', async (req, res) => {
  try {
    const instruccion = String((req.body && req.body.instruccion) || '').trim();
    if (!instruccion) return res.status(400).json({ ok: false, error: 'instruccion_requerida' });
    const origenUrl = (req.body && req.body.origen_url) ? String(req.body.origen_url).slice(0, 1000) : null;
    const origenTipo = (req.body && req.body.origen_tipo === 'video') ? 'video' : (origenUrl ? 'image' : null);
    const id = await db.crearSolicitudBiblioteca(req.proyectoId, instruccion, origenUrl, origenTipo);
    res.json({ ok: true, id });
  } catch (e) { console.error('biblio solicitar', e.message); res.status(500).json({ ok: false }); }
});

// Borrar un asset/solicitud del bibliotecario (y su archivo).
app.delete('/api/biblioteca/generado/:id', async (req, res) => {
  try {
    const row = await db.delSolicitudBiblioteca(req.proyectoId, req.params.id);
    if (row && row.resultado_path) borrarMediaFile(row.resultado_path);
    res.json({ ok: !!row });
  } catch (e) { console.error('biblio del', e.message); res.status(500).json({ ok: false }); }
});

// Bitácora de generación de una pieza (cómo la armó el creativo: lógica + herramientas).
app.get('/api/piezas/:id/bitacora', async (req, res) => {
  try { const b = await db.getBitacora(req.params.id); b ? res.json(b) : res.status(404).json({ error: 'no_existe' }); }
  catch (e) { console.error('bitacora', e.message); res.status(500).json({ error: 'db' }); }
});

// Galería de materiales aportados a un requerimiento (para el modal de interacción).
app.get('/api/requerimientos/:id/materiales', async (req, res) => {
  try { res.json(await db.getMateriales(req.params.id)); }
  catch (e) { console.error('materiales', e.message); res.status(500).json({ error: 'db' }); }
});

// Quitar un material de la galería (antes de generar).
// Borra del media store un archivo relativo (guard contra path traversal; media_path viene de nuestra DB).
function borrarMediaFile(rel) {
  if (!rel || rel.includes('..') || rel.startsWith('/')) return;
  fs.promises.unlink(path.join('/app/media', rel)).catch(() => {});
}
app.delete('/api/requerimientos/:id/material/:mid', async (req, res) => {
  try { const row = await db.delMaterial(req.params.id, req.params.mid); if (row) borrarMediaFile(row.media_path); res.json({ ok: !!row }); }
  catch (e) { console.error('del material', e.message); res.status(500).json({ ok: false }); }
});

// Guarda un archivo (dataURL base64) en el media store en disco (/app/media/<subdir>/<uuid>.<ext>)
// y devuelve {mediaPath, mediaType, filename}. Reemplaza a Telegram: el Bot API descarga hasta 20MB,
// insuficiente para videos. El volumen es el mismo que lee el creativo (host) — sin límite de tamaño.
// Comprime un video a calidad apta para Instagram (H.264, máx 1080px de ancho, faststart).
// Reduce mucho el peso de videos de celular (4K) sin pérdida visible en feed/reels.
function comprimirVideo(src, dst) {
  return new Promise((resolve, reject) => {
    const args = ['-i', src, '-vf', "scale='min(1080,iw)':-2", '-c:v', 'libx264', '-crf', '26',
      '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', dst];
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    ff.on('error', e => reject(new Error('ffmpeg no disponible: ' + e.message)));
    ff.on('close', code => code === 0 ? resolve() : reject(new Error('No se pudo comprimir el video')));
  });
}

// Recibe el video crudo por streaming (sin base64) a un archivo temporal. Devuelve la ruta temp.
function recibirStream(req, tmp, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const ws = fs.createWriteStream(tmp);
    const fail = (e) => { try { ws.destroy(); } catch {} fs.promises.unlink(tmp).catch(() => {}); reject(e); };
    req.on('data', c => { size += c.length; if (size > max) { try { req.destroy(); } catch {} fail(Object.assign(new Error('El video es demasiado grande'), { http: 413 })); } });
    ws.on('error', fail); req.on('error', fail);
    ws.on('finish', () => resolve(size));
    req.pipe(ws);
  });
}

async function guardarMaterialDisco(body, subdir) {
  const dataUrl = String((body && body.dataUrl) || '');
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) { const e = new Error('archivo_invalido'); e.http = 400; throw e; }
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const mediaType = mime.startsWith('video/') ? 'video' : 'photo';
  const filename = String((body && body.filename) || (mediaType === 'video' ? 'material.mp4' : 'material.jpg'));
  const ext = ((filename.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || (mediaType === 'video' ? 'mp4' : 'jpg')).toLowerCase();
  const rel = path.posix.join(subdir, `${crypto.randomUUID()}.${ext}`);
  const abs = path.join('/app/media', rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, buf);
  return { mediaPath: rel, mediaType, filename };
}

// Sube un archivo (base64) al bot como documento (preserva calidad) y devuelve {fileId, mediaType, filename}.
// Lanza un Error con .http para que el handler responda el status correcto.
async function subirMaterialTg(body, caption) {
  if (!BOT) { const e = new Error('sin_bot'); e.http = 503; throw e; }
  const dataUrl = String((body && body.dataUrl) || '');
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) { const e = new Error('archivo_invalido'); e.http = 400; throw e; }
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const mediaType = mime.startsWith('video/') ? 'video' : 'photo';
  const filename = String((body && body.filename) || (mediaType === 'video' ? 'material.mp4' : 'material.jpg'));
  const fd = new FormData();
  fd.append('chat_id', CHAT);
  fd.append('caption', caption);
  fd.append('document', new Blob([buf], { type: mime }), filename);
  const tg = await fetch(`https://api.telegram.org/bot${BOT}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) }).then(r => r.json());
  const fileId = tg && tg.result && tg.result.document && tg.result.document.file_id;
  if (!fileId) { const e = new Error('telegram'); e.http = 502; throw e; }
  return { fileId, mediaType, filename };
}

// Aportar material desde el panel: el archivo se suma a la galería del requerimiento. NO dispara la
// generación (eso lo hace el botón "Generar publicación").
app.post('/api/requerimientos/:id/material', async (req, res) => {
  try {
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('material/req', req.params.id));
    const mat = await db.addMaterial(req.params.id, mediaPath, mediaType, filename);
    if (!mat) return res.status(409).json({ ok: false, error: 'estado' });
    res.json({ ok: true, material: mat });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});

// Agregar material a una propuesta ELIGIÉNDOLO de la biblioteca: se copia el archivo a la propuesta.
app.post('/api/requerimientos/:id/material-biblioteca', async (req, res) => {
  try {
    const srcRel = String((req.body && req.body.media_path) || '').replace(/^\/+/, '').replace(/^media\//, '');
    if (!srcRel || srcRel.includes('..')) return res.status(400).json({ ok: false, error: 'ruta' });
    const src = path.join('/app/media', srcRel);
    const ext = ((srcRel.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('material/req', req.params.id, crypto.randomUUID() + '.' + ext);
    const dst = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    const tipo = (req.body && req.body.tipo === 'video') ? 'video' : 'image';
    const mat = await db.addMaterial(req.params.id, rel, tipo, (req.body && req.body.filename) || null);
    if (!mat) { await fs.promises.unlink(dst).catch(() => {}); return res.status(409).json({ ok: false, error: 'estado' }); }
    res.json({ ok: true, material: mat });
  } catch (e) { console.error('material-biblioteca', e.message); res.status(500).json({ ok: false }); }
});

// --- Material aportado al RECHAZAR una pieza (se adjunta al brief que la generó, para la corrección) ---
app.get('/api/piezas/:id/materiales', async (req, res) => {
  try { res.json(await db.getMaterialesPorPieza(req.params.id)); }
  catch (e) { console.error('materiales pieza', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/piezas/:id/material', async (req, res) => {
  try {
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('material/pieza', req.params.id));
    const mat = await db.addMaterialPorPieza(req.params.id, mediaPath, mediaType, filename);
    if (!mat) return res.status(409).json({ ok: false, error: 'no_pendiente' });
    res.json({ ok: true, material: mat });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});
app.delete('/api/piezas/:id/material/:mid', async (req, res) => {
  try { const row = await db.delMaterialPorPieza(req.params.id, req.params.mid); if (row) borrarMediaFile(row.media_path); res.json({ ok: !!row }); }
  catch (e) { console.error('del material pieza', e.message); res.status(500).json({ ok: false }); }
});

// --- Programación de pantalla (privado) — a nivel PANTALLA, cross-proyecto (no usa la marca activa) ---
// Resuelve la pantalla destino: ?pantalla=<slug> o la pantalla activa por defecto.
async function resolvePantalla(req) {
  return req.query.pantalla ? db.getPantallaPorSlug(String(req.query.pantalla)) : db.getPantallaActiva();
}
app.get('/api/avisos-aprobados', async (req, res) => {
  try { res.json(await db.getAvisosAprobados()); }   // de TODOS los proyectos (mix)
  catch (e) { console.error('avisos-aprob', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/programas', async (req, res) => {
  try { const pa = await resolvePantalla(req); res.json(pa ? await db.getProgramas(pa.id) : []); }
  catch (e) { console.error('programas', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/programas/:id', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(404).json({ error: 'sin_pantalla' });
    const p = await db.getPrograma(req.params.id, pa.id); p ? res.json(p) : res.status(404).json({ error: 'no_existe' });
  } catch (e) { console.error('programa', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/programas', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(409).json({ ok: false, error: 'sin_pantalla' });
    res.json({ ok: true, id: await db.crearPrograma(String((req.body && req.body.nombre) || 'Programa').slice(0, 120), pa.id) });
  } catch (e) { console.error('crear prog', e.message); res.status(500).json({ ok: false }); }
});
app.put('/api/programas/:id', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(409).json({ ok: false, error: 'sin_pantalla' });
    const nombre = req.body && req.body.nombre != null ? String(req.body.nombre).slice(0, 120) : null;
    const piezas = Array.isArray(req.body && req.body.piezas) ? req.body.piezas : [];
    res.json({ ok: await db.guardarPrograma(req.params.id, nombre, piezas, pa.id) });
  } catch (e) { console.error('guardar prog', e.message); res.status(500).json({ ok: false }); }
});
app.post('/api/programas/:id/activar', async (req, res) => {
  try { const pa = await resolvePantalla(req); res.json({ ok: pa ? await db.activarPrograma(req.params.id, pa.id) : false }); }
  catch (e) { console.error('activar prog', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/programas/:id', async (req, res) => {
  try { const pa = await resolvePantalla(req); res.json({ ok: pa ? await db.eliminarPrograma(req.params.id, pa.id) : false }); }
  catch (e) { console.error('del prog', e.message); res.status(500).json({ ok: false }); }
});

// Descarga del programa como .zip autocontenido: los mp4 en orden + manifest.json (para reproducir offline en la pantalla).
app.get('/api/programas/:id/download', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(404).json({ error: 'sin_pantalla' });
    const prog = await db.getPrograma(req.params.id, pa.id);
    if (!prog) return res.status(404).json({ error: 'no_existe' });
    const items = (prog.items || []).filter(it => it.media && it.media.url);
    if (!items.length) return res.status(409).json({ error: 'programa_vacio' });
    const slug = (prog.nombre || 'programa').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'programa';
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="programa-${slug}.zip"`);
    const archive = archiver('zip', { store: true });   // store: el mp4 ya está comprimido, no recomprimir
    archive.on('error', e => { console.error('zip', e.message); if (!res.headersSent) res.status(500).end(); });
    archive.pipe(res);
    const manifest = { programa: prog.nombre, generado: new Date().toISOString(), reproduccion: 'loop, en orden', items: [] };
    let idx = 0;
    for (const it of items) {
      idx++;
      const label = (it.marca_slug || 'aviso') + '-' + String(it.numero).padStart(4, '0');
      const fname = `${String(idx).padStart(2, '0')}_${label}.mp4`;
      try {
        const r = await fetch(it.media.url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) { console.error('zip fetch', it.media.url, r.status); continue; }
        archive.append(Buffer.from(await r.arrayBuffer()), { name: fname });
        manifest.items.push({ orden: idx, archivo: fname, marca: it.marca_slug, numero: it.numero, titulo: it.titulo_interno, duracion_s: it.duracion_s || 10 });
      } catch (e) { console.error('zip item', it.numero, e.message); }
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    await archive.finalize();
  } catch (e) { console.error('download prog', e.message); if (!res.headersSent) res.status(500).json({ error: 'zip' }); }
});

// --- VNNOX: entrega del programa a la pantalla DOOH (nube de Novastar) ---
// Estado/diagnóstico: si está configurado + lista de players y su estado online.
app.get('/api/pantalla/vnnox', async (req, res) => {
  try {
    if (!vnnox.configured()) return res.json({ configurado: false });
    const r = await vnnox.listPlayers();
    const players = (r.json && r.json.rows) ? r.json.rows.map(p => ({
      playerId: p.playerId, name: p.name, sn: p.sn, online: p.onlineStatus === 1, width: p.width, height: p.height,
    })) : [];
    res.json({ configurado: true, status: r.status, players, targets: vnnox.PLAYER_IDS });
  } catch (e) { console.error('vnnox status', e.message); res.status(500).json({ configurado: true, error: 'vnnox' }); }
});

// Publica un programa a la pantalla: calcula md5+size de cada video y llama a /v2/player/program/normal.
app.post('/api/programas/:id/enviar-pantalla', async (req, res) => {
  try {
    if (!vnnox.configured()) return res.status(503).json({ ok: false, error: 'vnnox_no_configurado' });
    const pa = await resolvePantalla(req); if (!pa) return res.status(404).json({ ok: false, error: 'sin_pantalla' });
    const prog = await db.getPrograma(req.params.id, pa.id);
    if (!prog) return res.status(404).json({ ok: false, error: 'no_existe' });
    const items = (prog.items || []).filter(it => it.media && it.media.url);
    if (!items.length) return res.status(409).json({ ok: false, error: 'programa_vacio' });
    const vids = [];
    for (const it of items) {
      const r = await fetch(it.media.url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'media_inaccesible', url: it.media.url, status: r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      vids.push({
        url: it.media.url,
        md5: crypto.createHash('md5').update(buf).digest('hex'),
        size: buf.length,
        durMs: (it.duracion_s || 10) * 1000,
        label: (it.marca_slug || 'aviso') + '-' + String(it.numero).padStart(4, '0'),
      });
    }
    const fecha = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const playerIds = (pa.vnnox_player_ids && pa.vnnox_player_ids.length) ? pa.vnnox_player_ids : null;
    const out = await vnnox.publishProgram(vids, playerIds, `${prog.nombre} · ${fecha}`);
    const ok = out.status >= 200 && out.status < 300;
    res.json({ ok, status: out.status, resp: out.json });
  } catch (e) { console.error('enviar-pantalla', e.message); res.status(500).json({ ok: false, error: 'vnnox' }); }
});

// --- Pantallas (gestión multi-pantalla, nivel plataforma) ---
const slugify = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pantalla';
const toIds = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const pantallaBody = b => ({
  nombre: String((b && b.nombre) || '').slice(0, 120) || 'Pantalla',
  ubicacion: b && b.ubicacion != null ? String(b.ubicacion).slice(0, 200) : null,
  ancho: b && b.ancho ? (parseInt(b.ancho, 10) || null) : null,
  alto: b && b.alto ? (parseInt(b.alto, 10) || null) : null,
  vnnox_player_ids: toIds(b && b.vnnox_player_ids),
  activo: !(b && b.activo === false),
});

app.get('/api/pantallas', async (req, res) => {
  try {
    const rows = await db.getPantallas();
    let onMap = null;                                   // estado online por player (best-effort vía VNNOX)
    if (vnnox.configured()) {
      try { const r = await vnnox.listPlayers(); onMap = {}; ((r.json && r.json.rows) || []).forEach(p => { onMap[p.playerId] = p.onlineStatus === 1; }); }
      catch (_) { onMap = null; }
    }
    const out = [];
    for (const p of rows) out.push({
      ...p,
      online: onMap ? (p.vnnox_player_ids || []).some(id => onMap[id]) : null,
      programa: await db.getProgramaActivo(p.id),   // programa activo + sus avisos (para el tablero)
    });
    res.json(out);
  } catch (e) { console.error('pantallas', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/pantallas', async (req, res) => {
  try {
    const d = pantallaBody(req.body);
    d.slug = slugify((req.body && req.body.slug) || d.nombre);
    const id = await db.crearPantalla(d);
    res.json({ ok: true, id, slug: d.slug });
  } catch (e) {
    if (String(e.message).includes('duplicate')) return res.status(409).json({ ok: false, error: 'slug_duplicado' });
    console.error('crear pantalla', e.message); res.status(500).json({ ok: false });
  }
});
app.put('/api/pantallas/:id', async (req, res) => {
  try { res.json({ ok: await db.actualizarPantalla(req.params.id, pantallaBody(req.body)) }); }
  catch (e) { console.error('upd pantalla', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/pantallas/:id', async (req, res) => {
  try { const r = await db.eliminarPantalla(req.params.id); r.ok ? res.json({ ok: true }) : res.status(409).json(r); }
  catch (e) { console.error('del pantalla', e.message); res.status(500).json({ ok: false }); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, p) => { if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); }
}));

app.listen(PORT, () => console.log(`cortafuego-panel escuchando en :${PORT}`));

// Métricas y menciones: refresco al arrancar y cada 30 min.
setTimeout(refreshMetricas, 10000);
setInterval(refreshMetricas, 30 * 60 * 1000);
setTimeout(refreshMenciones, 16000);
setInterval(refreshMenciones, 30 * 60 * 1000);
