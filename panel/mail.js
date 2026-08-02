'use strict';
/**
 * Envío de mail del panel. Hoy sale por la casilla configurada en MAIL_USER (Gmail con
 * contraseña de aplicación); cuando esté la de Workspace, se cambian las variables y sale desde
 * clausina.ar firmado con DKIM, sin tocar este archivo.
 *
 * Best-effort a propósito: que falle un mail NO puede hacer fracasar el alta de un usuario.
 * El usuario ya quedó creado y con acceso; la invitación se puede reenviar.
 */
const nodemailer = require('nodemailer');

const USER = process.env.MAIL_USER || '';
const PASS = process.env.MAIL_PASS || '';
const FROM = process.env.MAIL_FROM || 'ClaUsina';
const PANEL_URL = process.env.PANEL_URL || 'https://panel.clausina.ar';

const activo = () => !!(USER && PASS);

let _tx = null;
function transporte() {
  if (!_tx) _tx = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });
  return _tx;
}

async function enviar(to, subject, text) {
  if (!activo()) return { ok: false, motivo: 'sin_credenciales' };
  try {
    await transporte().sendMail({ from: `${FROM} <${USER}>`, to, subject, text });
    return { ok: true };
  } catch (e) {
    console.error('mail', e.message);
    return { ok: false, motivo: e.message };
  }
}

/**
 * Invitación. NO lleva link con token y es deliberado: el acceso ya está dado por el email en
 * la base, y Google prueba que la cuenta es de esa persona. Un token sería un secreto de más
 * que puede vencer, filtrarse o confundir.
 */
function invitacion({ nombre, negocios }) {
  const lista = (negocios || []).length
    ? `\nVas a poder trabajar sobre: ${negocios.join(', ')}.\n`
    : '\n';
  return {
    subject: 'Tu acceso al panel de ClaUsina',
    text:
`Hola ${nombre}:

Ya tenés acceso al panel de ClaUsina.
${lista}
Para entrar:

1. Abrí ${PANEL_URL}
2. Tocá "Entrar con Google" y usá esta misma dirección de correo.
3. La primera vez te vamos a pedir un par de datos de contacto.

No necesitás crear ninguna contraseña.

Si no esperabas este correo, ignoralo.

— ClaUsina`,
  };
}

module.exports = { activo, enviar, invitacion };
