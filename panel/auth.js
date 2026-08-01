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
  COOKIE, TTL_S,
  hashPassword, verifyPassword,
  issue, readToken, readCookie, cookieHeader,
  esAdmin, rolEn, puedeVer, puedeAprobar,
};
