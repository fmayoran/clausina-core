/**
 * Siembra el primer usuario administrador.
 *
 * Reusa la PANEL_PASSWORD actual para que la transición no corte el acceso: Fer entra con el
 * mismo password de siempre, ahora acompañado de su email. Idempotente: si el usuario ya existe
 * no lo pisa.
 *
 * Uso:  node seed_usuario_admin.js <email> "<nombre>"
 * La contraseña sale de PANEL_PASSWORD (nunca se pasa por argumento: quedaría en el historial).
 */
const path = require('path');
const auth = require(path.join(__dirname, '..', '..', 'panel', 'auth.js'));
const db = require(path.join(__dirname, '..', '..', 'panel', 'db.js'));

async function main() {
  const email = (process.argv[2] || '').trim();
  const nombre = (process.argv[3] || '').trim();
  const pw = process.env.PANEL_PASSWORD || '';

  if (!email || !nombre) { console.error('uso: node seed_usuario_admin.js <email> "<nombre>"'); process.exit(2); }
  if (pw.length < 8) { console.error('ERROR: PANEL_PASSWORD vacía o demasiado corta.'); process.exit(2); }

  const ya = await db.getUsuarioPorEmail(email);
  if (ya) { console.log(`  ya existe: ${ya.nombre} <${ya.email}> (${ya.rol_plataforma})`); return; }

  const id = await db.crearUsuario({
    email, nombre,
    password_hash: auth.hashPassword(pw),
    rol_plataforma: 'admin',
  });
  console.log(`  creado admin: ${nombre} <${email}> · id ${id}`);
  console.log('  entra con ese email y la contraseña que ya usabas.');
}

main().then(() => process.exit(0)).catch(e => { console.error('  ERROR:', e.message); process.exit(1); });
