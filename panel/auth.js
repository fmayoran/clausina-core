'use strict';
/**
 * Autenticación y permisos del panel.
 *
 * Sin dependencias nuevas: scrypt y HMAC vienen en Node, igual que crypto_ads.js.
 *
 * Antes de esto había UNA contraseña compartida y una cookie que sólo llevaba `{exp}`.
 * Ahora la cookie lleva `{uid, exp}`, así que cada request sabe quién es el que pide — que es
 * la condición para que el negocio activo se pueda validar contra los permisos del usuario.
 */
const crypto = require('crypto');

const SECRET = process.env.PANEL_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'cf_panel';
const TTL_S = 14 * 24 * 3600;

// --- Contraseñas: scrypt con salt por usuario -------------------------------------
// Formato: scrypt$<salt_hex>$<hash_hex>. Se guarda entero para poder cambiar parámetros
// después sin invalidar los hashes viejos.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !plain) return false;
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const h = crypto.scryptSync(String(plain), Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    // timingSafeEqual explota si difieren los largos: comparamos antes.
    return h.length === expected.length && crypto.timingSafeEqual(h, expected);
  } catch {
    return false;
  }
}

// --- Sesión: cookie firmada con HMAC ----------------------------------------------
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');

function issue(uid) {
  const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + TTL_S * 1000 })).toString('base64url');
  return `${p}.${sign(p)}`;
}

/** Devuelve el payload {uid, exp} si la cookie es válida y no venció; si no, null. */
function readToken(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [p, s] = tok.split('.');
  if (sign(p) !== s) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch {
    return null;
  }
}

function readCookie(req) {
  const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  return c ? decodeURIComponent(c.slice(COOKIE.length + 1)) : '';
}

function cookieHeader(value, path, maxAge) {
  return `${COOKIE}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// --- Token de un solo uso para definir contraseña ---------------------------------
// Cierra el círculo: sin esto, la contraseña sólo se podía definir DESDE ADENTRO del panel, así
// que quien no quisiera usar Google no tenía cómo entrar la primera vez.
// Guardamos el hash, nunca el token: si alguien lee la base, no le sirve de nada.
const tokenNuevo = () => crypto.randomBytes(32).toString('hex');
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// --- Google (OpenID Connect) ------------------------------------------------------
// El SSO AUTENTICA, no autoriza: Google nos dice que el mail es de esa persona, pero el acceso
// sigue saliendo de contenido.usuario. Si el mail no está en la tabla, no entra. Eso es lo que
// reemplaza al alta libre: nadie se da acceso a sí mismo.
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleActivo = () => !!(GOOGLE_ID && GOOGLE_SECRET);

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_COOKIE = 'cf_oauth';

/** Estado anti-CSRF: un nonce firmado con el mismo secreto, válido 10 minutos. */
function estadoNuevo() {
  const p = Buffer.from(JSON.stringify({ n: crypto.randomBytes(12).toString('hex'), exp: Date.now() + 600000 })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function estadoValido(v) {
  if (!v || !v.includes('.')) return false;
  const [p, s] = v.split('.');
  if (sign(p) !== s) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

function urlDeGoogle(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: GOOGLE_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',       // permisos no sensibles: no disparan revisión de Google
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
  return `${AUTH_URL}?${q}`;
}

/**
 * Canjea el code por el id_token y devuelve {email, nombre} o null.
 *
 * No verificamos la firma del JWT a propósito: el token viene del endpoint de Google por TLS,
 * en una respuesta a un POST nuestro autenticado con el client_secret. Google documenta que en
 * ese caso alcanza con validar los claims. Así evitamos sumar una librería de JWT.
 */
async function canjearCodigo(code, redirectUri) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.id_token) return null;

  const partes = String(d.id_token).split('.');
  if (partes.length !== 3) return null;
  let c;
  try { c = JSON.parse(Buffer.from(partes[1], 'base64url').toString()); } catch { return null; }

  if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss)) return null;
  if (c.aud !== GOOGLE_ID) return null;
  if (!c.exp || c.exp * 1000 < Date.now()) return null;
  // Sin mail verificado no hay prueba de que la cuenta sea suya.
  if (!c.email || c.email_verified !== true) return null;

  return { email: String(c.email), nombre: String(c.name || c.email) };
}

// --- Permisos ---------------------------------------------------------------------
// El admin pasa por encima de todo: es la plataforma. El resto sólo ve lo que tiene asignado.
const esAdmin = u => !!u && u.rol_plataforma === 'admin';

/** Rol del usuario en un negocio: 'admin' | 'aprobador' | 'editor' | null. */
function rolEn(usuario, negocioId) {
  if (!usuario) return null;
  if (esAdmin(usuario)) return 'admin';
  const n = (usuario.negocios || []).find(x => x.negocio_id === negocioId);
  return n ? n.rol : null;
}

const puedeVer = (usuario, negocioId) => rolEn(usuario, negocioId) !== null;
/** Aprobar, rechazar, publicar: la compuerta humana de la plataforma. */
const puedeAprobar = (usuario, negocioId) => ['admin', 'aprobador'].includes(rolEn(usuario, negocioId));

module.exports = {
  COOKIE, TTL_S, STATE_COOKIE,
  hashPassword, verifyPassword, tokenNuevo, tokenHash,
  issue, readToken, readCookie, cookieHeader,
  googleActivo, estadoNuevo, estadoValido, urlDeGoogle, canjearCodigo,
  esAdmin, rolEn, puedeVer, puedeAprobar,
};
