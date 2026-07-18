#!/usr/bin/env node
// Renderiza el manual de marca (HTML autocontenido) a PDF A4 con Chromium.
// Uso: node manual_pdf.js <entrada.html> <salida.pdf>
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const path = require('path');

const [inHtml, outPdf] = process.argv.slice(2);
(async () => {
  let b;
  try {
    b = await chromium.launch();
    const p = await b.newPage();
    // file:// para que resuelva rutas relativas; networkidle deja cargar Google Fonts y el logo.
    await p.goto('file://' + path.resolve(inHtml), { waitUntil: 'networkidle', timeout: 45000 });
    await p.emulateMedia({ media: 'print' });
    // preferCSSPageSize: el @page {size:A4;margin:0} del HTML manda -> full-bleed, sin marco blanco.
    await p.pdf({ path: outPdf, printBackground: true, preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    await b.close();
    console.log(JSON.stringify({ ok: true }));
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
    process.exit(1);
  }
})();
