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
// Remitente visible. Se autentica con MAIL_USER, pero el mail sale desde esta dirección: así las
// invitaciones vienen de una casilla de la agencia y no de la personal de quien administra.
// Requiere que el alias esté dado de alta como "Enviar como" en Gmail. Si no está, dejar vacío.
const REMITENTE = process.env.MAIL_REMITENTE || USER;
const PANEL_URL = process.env.PANEL_URL || 'https://panel.clausina.ar';

const activo = () => !!(USER && PASS);

let _tx = null;
function transporte() {
  if (!_tx) _tx = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });
  return _tx;
}

async function enviar(to, subject, text, html) {
  if (!activo()) return { ok: false, motivo: 'sin_credenciales' };
  try {
    // Mandamos texto Y html: el cliente de correo elige. El texto no es un descarte — es lo que
    // ven los lectores de pantalla y lo que queda si el html no carga.
    await transporte().sendMail({ from: `${FROM} <${REMITENTE}>`, to, subject, text, html });
    return { ok: true };
  } catch (e) {
    console.error('mail', e.message);
    return { ok: false, motivo: e.message };
  }
}

/**
 * Invitación. Lleva un enlace de un solo uso para definir contraseña: con Google alcanzaría
 * (el mail ya prueba la identidad), pero sin el enlace quien NO quiera usar Google queda sin
 * forma de entrar la primera vez — la contraseña sólo se podía definir desde adentro.
 */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function invitacion({ nombre, negocios, urlClave }) {
  const lista = (negocios || []).length ? negocios.join(', ') : '';

  const text =
`Hola ${nombre}:

Ya tenés acceso al panel de ClaUsina.
${lista ? `\nVas a poder trabajar sobre: ${lista}.\n` : ''}
Para entrar, abrí ${PANEL_URL}

Podés ingresar de dos maneras:
  · Con tu cuenta de Google, usando esta misma dirección.
  · Con una contraseña que definas vos${urlClave ? `: ${urlClave}` : ''}

La primera vez te vamos a pedir un par de datos de contacto.

Si no esperabas este correo, ignoralo.

— ClaUsina`;

  // HTML de correo: tablas y estilos en línea. Nada de flex, grid ni hojas externas — la mitad
  // de los clientes de mail los ignora. Fondo claro a propósito: el modo oscuro de Gmail y
  // Outlook invierte colores de forma impredecible y un diseño oscuro termina ilegible.
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Tu acceso al panel de ClaUsina</title></head>
<body style="margin:0;padding:0;background:#F0EDE7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EDE7;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E2DED6;">

    <tr><td style="background:#0C0C0A;padding:26px 30px;">
      <span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#F5F2EC;letter-spacing:-0.4px;">Cla<span style="color:#CCF24D;">U</span>sina<span style="color:#CCF24D;">.</span></span>
    </td></tr>

    <tr><td style="padding:34px 30px 8px;">
      <h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:#0C0C0A;font-weight:700;">Hola ${esc(nombre)}, ya tenés acceso</h1>
      <p style="margin:0 0 18px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3A3A38;">
        Te dimos de alta en el panel de ClaUsina, desde donde vas a revisar y aprobar el contenido antes de que salga publicado.
      </p>
      ${lista ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr>
        <td style="border-left:3px solid #CCF24D;padding:2px 0 2px 14px;">
          <div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#8A8F98;margin-bottom:3px;">Trabajás sobre</div>
          <div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;color:#0C0C0A;font-weight:600;">${esc(lista)}</div>
        </td></tr></table>` : ''}
    </td></tr>

    <tr><td align="center" style="padding:6px 30px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:#CCF24D;border-radius:8px;">
          <a href="${PANEL_URL}" style="display:inline-block;padding:13px 30px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0C0C0A;text-decoration:none;">Entrar al panel</a>
        </td></tr></table>
    </td></tr>

    <tr><td style="padding:0 30px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F5F1;border-radius:10px;">
        <tr><td style="padding:18px 20px;">
          <div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#8A8F98;margin-bottom:10px;">Cómo entrar</div>
          <p style="margin:0 0 8px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#3A3A38;">
            <b style="color:#0C0C0A;">Con Google</b> — tocá “Entrar con Google” y usá esta misma dirección de correo. No hace falta crear ninguna contraseña.
          </p>
          <p style="margin:0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#3A3A38;">
            <b style="color:#0C0C0A;">Con contraseña</b> — si preferís no usar Google, ${urlClave ? `<a href="${urlClave}" style="color:#4d6800;font-weight:600;">definí tu contraseña acá</a>. El enlace vale 7 días.` : 'definila desde Mi cuenta una vez adentro.'}
          </p>
        </td></tr>
      </table>
      <p style="margin:18px 0 0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;color:#8A8F98;">
        La primera vez te vamos a pedir un par de datos de contacto. Si no esperabas este correo, ignoralo.
      </p>
    </td></tr>

    <tr><td style="background:#F7F5F1;border-top:1px solid #E2DED6;padding:16px 30px;">
      <span style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#8A8F98;">ClaUsina · <a href="https://clausina.ar" style="color:#8A8F98;">clausina.ar</a></span>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;

  return { subject: 'Tu acceso al panel de ClaUsina', text, html };
}

function recuperacion({ nombre, url }) {
  const text =
`Hola ${nombre}:

Pediste recuperar el acceso al panel de ClaUsina.

Definí una contraseña nueva acá:
${url}

El enlace vale 1 hora y se puede usar una sola vez.

Si no fuiste vos, ignorá este correo: tu contraseña actual sigue funcionando.

— ClaUsina`;

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Recuperar el acceso</title></head>
<body style="margin:0;padding:0;background:#F0EDE7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EDE7;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E2DED6;">
    <tr><td style="background:#0C0C0A;padding:26px 30px;">
      <span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#F5F2EC;letter-spacing:-0.4px;">Cla<span style="color:#CCF24D;">U</span>sina<span style="color:#CCF24D;">.</span></span>
    </td></tr>
    <tr><td style="padding:34px 30px 10px;">
      <h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:#0C0C0A;font-weight:700;">Recuperar tu acceso</h1>
      <p style="margin:0 0 6px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3A3A38;">
        Hola ${esc(nombre)}, definí una contraseña nueva con el botón de abajo.
      </p>
    </td></tr>
    <tr><td align="center" style="padding:14px 30px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:#CCF24D;border-radius:8px;">
          <a href="${url}" style="display:inline-block;padding:13px 30px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0C0C0A;text-decoration:none;">Definir contraseña</a>
        </td></tr></table>
    </td></tr>
    <tr><td style="padding:0 30px 30px;">
      <p style="margin:0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;color:#8A8F98;">
        El enlace vale 1 hora y se usa una sola vez. Si no fuiste vos, ignorá este correo: tu contraseña actual sigue funcionando.
      </p>
    </td></tr>
    <tr><td style="background:#F7F5F1;border-top:1px solid #E2DED6;padding:16px 30px;">
      <span style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#8A8F98;">ClaUsina · <a href="https://clausina.ar" style="color:#8A8F98;">clausina.ar</a></span>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject: 'Recuperar el acceso al panel de ClaUsina', text, html };
}

module.exports = { activo, enviar, invitacion, recuperacion };
