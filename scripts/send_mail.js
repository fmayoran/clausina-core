// Envío de mail — capacidad de AGENCIA (ClaUsina), disponible para todos los proyectos.
// Remitente unificado: la identidad es ClaUsina; la marca va como etiqueta en el asunto.
// Credenciales en core/plataforma.env (AGENCIA_MAIL_*), gitignored. No hay mail por marca:
// las notificaciones son internas (a Fer). Para cambiar el remitente, editar plataforma.env.
//
// Uso: node send_mail.js <to> <subject> <body> [marca]
//   (si <to> es vacío, usa AGENCIA_MAIL_TO)

const nodemailer = require('nodemailer');
const fs = require('fs');

// Carga plataforma.env sin pisar variables ya presentes en el entorno.
function loadEnv(p) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* si no está, se usan las env vars del proceso */ }
}
loadEnv('/root/claudefolder/core/plataforma.env');

const USER = process.env.AGENCIA_MAIL_USER;
const PASS = process.env.AGENCIA_MAIL_PASS;
const FROM_NAME = process.env.AGENCIA_MAIL_FROM_NAME || 'ClaUsina';
const TO_DEF = process.env.AGENCIA_MAIL_TO || USER;

if (!USER || !PASS) { console.error('Falta AGENCIA_MAIL_USER/PASS en plataforma.env'); process.exit(1); }

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });

async function sendMail(to, subject, body, marca) {
  const subj = marca ? `ClaUsina · ${marca} — ${subject}` : `ClaUsina — ${subject}`;
  const info = await transporter.sendMail({ from: `${FROM_NAME} <${USER}>`, to, subject: subj, text: body });
  console.log('Mail enviado:', info.messageId);
  return true;
}

const [, , to, subject, body, marca] = process.argv;
sendMail(to || TO_DEF, subject || 'Prueba', body || 'Prueba de mail de agencia (ClaUsina).', marca)
  .catch(e => { console.error('Error al enviar mail:', e.message); process.exit(1); });
