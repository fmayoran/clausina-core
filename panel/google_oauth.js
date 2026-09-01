/* OAuth de Google para la plataforma (Google Ads y lo que venga: Analytics, Search Console…).
 *
 * Por qué existe: el flujo de OAuth necesita un navegador y el VPS no tiene ninguno. En vez de
 * hacer el baile a mano en la máquina de alguien y pegar el refresh token por chat —que es como
 * se filtran los secretos—, el PANEL recibe el retorno: Google manda a la persona de vuelta a
 * panel.clausina.ar, el servidor canjea el código y guarda el refresh token cifrado. El secreto
 * nunca pasa por el navegador ni por una conversación.
 *
 * Qué se guarda: el refresh token va a `contenido.pauta_cuenta` cifrado con APP_ENC_KEY, en la
 * fila del negocio y la plataforma. El access token NO se guarda: dura una hora y se pide cada vez.
 */
const crypto = require('crypto');
const cripto = require('./crypto_ads');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Un scope por producto. Ads es el que se usa hoy; agregar otro es sumar acá y volver a autorizar.
const SCOPES = { google_ads: 'https://www.googleapis.com/auth/adwords' };

function cfg() {
  return {
    id: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    // Tiene que coincidir EXACTAMENTE con la URI registrada en Google Cloud, incluido el https.
    redirect: process.env.GOOGLE_OAUTH_REDIRECT || 'https://panel.clausina.ar/oauth/google/callback',
  };
}
const configurado = () => !!(cfg().id && cfg().secret);

/* El `state` va FIRMADO y con vencimiento. Sin esto, cualquiera puede mandarle a la víctima un
 * link de callback y colgar SU cuenta de Google en el negocio de otro. Lleva quién lo pidió, para
 * que el retorno no pueda escribir sobre un negocio distinto del que se autorizó. */
function firmarEstado(datos) {
  const cuerpo = Buffer.from(JSON.stringify({ ...datos, exp: Date.now() + 15 * 60e3 })).toString('base64url');
  const firma = crypto.createHmac('sha256', process.env.APP_ENC_KEY || 'sin-clave')
    .update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}

function leerEstado(state) {
  const [cuerpo, firma] = String(state || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperado = crypto.createHmac('sha256', process.env.APP_ENC_KEY || 'sin-clave')
    .update(cuerpo).digest('base64url');
  // timingSafeEqual pide el mismo largo; distinto largo ya es firma inválida.
  const a = Buffer.from(firma), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch (e) { return null; }
}

function urlAutorizacion({ negocioId, plataforma = 'google_ads', usuarioId }) {
  const c = cfg();
  const p = new URLSearchParams({
    client_id: c.id, redirect_uri: c.redirect, response_type: 'code',
    scope: SCOPES[plataforma] || SCOPES.google_ads,
    // offline + consent son los que hacen que Google devuelva REFRESH token. Sin `prompt=consent`
    // sólo lo manda la primera vez: si alguien reautoriza, vuelve sin refresh y la conexión queda
    // muerta en una hora sin que nadie entienda por qué.
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    state: firmarEstado({ negocioId, plataforma, usuarioId }),
  });
  return `${AUTH_URL}?${p}`;
}

async function canjear(code) {
  const c = cfg();
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret,
                                redirect_uri: c.redirect, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.refresh_token) {
    // Sin refresh token la conexión no sirve: el access token vence en una hora y no hay con qué
    // renovarlo. Se falla acá y no cuando deje de andar mañana.
    throw new Error(d.error_description || d.error || 'Google no devolvió refresh token');
  }
  return d;
}

/* Access token fresco a partir del refresh guardado. Se pide en cada uso: dura una hora, y
 * guardarlo sería tener un secreto más que vence sin avisar. */
async function accessToken(refreshCifrado) {
  const c = cfg();
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: cripto.decrypt(refreshCifrado),
                                client_id: c.id, client_secret: c.secret, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || 'no se pudo renovar el acceso');
  return d.access_token;
}

module.exports = { configurado, urlAutorizacion, leerEstado, canjear, accessToken, SCOPES };
