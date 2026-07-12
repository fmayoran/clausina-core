#!/usr/bin/env node
// Render de una página con Chromium: para sitios que arman el contenido con JS (el fetch
// estático se trae un cascarón vacío) y para VER la marca (screenshot -> identidad visual real,
// que del CSS no se puede deducir).
//
// Lo usa web_dossier.py. Playwright es devDependency de core: vive en el host, no en la imagen
// del panel.
//
// Uso: node web_render.js <url> <salida.html> <salida.png>
// Imprime una línea JSON: {"ok":bool,"status":int,"chars":int,"error":"…"}
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const fs = require('fs');

const [url, outHtml, outPng] = process.argv.slice(2);
const salida = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
if (!url) salida({ ok: false, error: 'falta url' });

(async () => {
  let b;
  try {
    b = await chromium.launch();
    const ctx = await b.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'es-AR',
      // Chromium real: acá no estamos evadiendo a nadie, estamos renderizando el sitio que
      // el usuario nos pidió leer, tal como lo vería él en su navegador.
    });
    const p = await ctx.newPage();
    const r = await p.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
    await p.waitForTimeout(1500);

    const html = await p.content();
    if (outHtml) fs.writeFileSync(outHtml, html);
    if (outPng) await p.screenshot({ path: outPng, fullPage: false });  // el fold: donde vive la identidad

    const chars = await p.evaluate(() => (document.body ? document.body.innerText : '').length);
    await b.close();
    salida({ ok: true, status: r ? r.status() : 0, chars });
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    salida({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
