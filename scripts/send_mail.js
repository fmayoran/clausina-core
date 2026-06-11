const nodemailer = require('nodemailer');
const config = require('/root/claudefolder/marcas/cortafuego/contexto/mail_config.json');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: config.email,
    pass: config.password
  }
});

async function sendMail(to, subject, body) {
  const mailOptions = {
    from: `${config.nombre} <${config.email}>`,
    to: to,
    subject: subject,
    text: body
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Mail enviado:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error al enviar mail:', error);
    return false;
  }
}

const [,, to, subject, body] = process.argv;
sendMail(
  to || config.email,
  subject || 'Test Cortafuego VPS',
  body || 'Si recibís este mail, la configuración funciona correctamente.'
);
