#!/usr/bin/env node
// Fotografía la pieza apaisada con la que se ve una invitación al compartirla.
// Uso: og_render.js <beneficio_id> <salida.jpg>
//
// Corre en el HOST porque el panel no tiene navegador. Espera a document.body.dataset.listo: sin
// eso sale una foto de la pieza a medio dibujar —sin la tipografía de la marca o sin el arte—,
// que es justo lo que se ve grande en la burbuja de WhatsApp.
const { chromium } = require('/root/clausina/core/node_modules/playwright');

const [id, salida] = process.argv.slice(2);
const BASE = process.env.PANEL_URL || 'https://panel.clausina.ar';
const fin = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!id || !salida) fin({ ok: false, error: 'uso: og_render.js <beneficio_id> <salida.jpg>' });

(async () => {
  let b;
  try {
    b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/publico/og/${encodeURIComponent(id)}`, { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForFunction('document.body.dataset.listo === "1"', null, { timeout: 20000 })
      .catch(() => {});
    // JPG y no PNG: es una foto con fondo fotográfico, y el peso importa —WhatsApp descarta las
    // previas pesadas—.
    await p.locator('#og').screenshot({ path: salida, type: 'jpeg', quality: 86 });
    await b.close();
    fin({ ok: true });
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    fin({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
