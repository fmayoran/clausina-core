#!/usr/bin/env node
// Fotografiar la tarjeta de una reserva: /tarjeta/<id> del panel -> PNG cuadrado.
//
// Corre en el HOST porque el navegador está acá (la imagen del panel es Alpine y no lo trae).
// Entra con una sesión emitida por el propio panel, igual que tools/captura: no hay ninguna
// credencial guardada en disco y la página que se fotografía es exactamente la que ve una
// persona logueada.
//
// Uso: tarjeta_render.js <reserva_id> <negocio_slug> <salida.png>
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const { execFileSync } = require('child_process');

const [reservaId, slug, salidaPng] = process.argv.slice(2);
const fin = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!reservaId || !slug || !salidaPng) fin({ ok: false, error: 'uso: tarjeta_render.js <reserva_id> <slug> <salida.png>' });

const BASE = process.env.PANEL_URL || 'https://panel.clausina.ar';
const LADO = 1080;   // cuadrada: es la proporción que WhatsApp muestra entera en la burbuja

function enPanel(codigo, ...args) {
  const cid = execFileSync('docker', ['ps', '-q', '-f', 'name=clausina_panel'], { encoding: 'utf8' })
    .trim().split('\n')[0];
  if (!cid) throw new Error('el panel no está corriendo');
  return execFileSync('docker', ['exec', cid, 'node', '-e', codigo, ...args], { encoding: 'utf8' }).trim();
}

(async () => {
  let nav;
  try {
    // La sesión se emite a nombre del dueño del negocio: la tarjeta muestra datos del negocio y
    // el endpoint filtra por negocio_id, así que la sesión tiene que tener uno.
    const uid = enPanel(
      `const db=require('/app/db');db.getUsuarioPorEmail(process.argv[1]).then(u=>{
         if(!u)process.exit(1); process.stdout.write(u.id);});`,
      process.env.TARJETA_USUARIO || 'fernando@clausina.ar');
    const token = enPanel(`process.stdout.write(require('/app/auth').issue(process.argv[1]));`, uid);

    nav = await chromium.launch();
    const ctx = await nav.newContext({
      viewport: { width: LADO, height: LADO },
      deviceScaleFactor: 1,
    });
    const host = new URL(BASE).hostname;
    await ctx.addCookies([
      { name: 'cf_panel', value: token, domain: host, path: '/' },
      { name: 'cf_marca', value: slug, domain: host, path: '/' },
    ]);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/tarjeta/${encodeURIComponent(reservaId)}`, { waitUntil: 'networkidle', timeout: 45000 });
    // La página avisa cuándo terminó de dibujarse. Sin esta bandera habría que adivinar con un
    // sleep, y una tarjeta a medio dibujar se manda igual sin que nadie se entere.
    await p.waitForSelector('body[data-listo="1"]', { timeout: 20000 });
    await p.locator('#tarjeta').screenshot({ path: salidaPng });
    await nav.close();
    fin({ ok: true, png: salidaPng });
  } catch (e) {
    try { if (nav) await nav.close(); } catch (_) {}
    fin({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
