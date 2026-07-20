#!/usr/bin/env node
// Render de una pieza gráfica: HTML a medida exacta -> PDF listo para imprenta (con sangre) +
// un PNG de preview por cara. Una pieza puede tener 1 o 2 caras (frente / frente y dorso):
// en el HTML cada cara es un bloque .lienzo; el PDF sale con una página por cara.
//
// Uso: grafica_render.js <in.html> <out.pdf> <out.png> <anchoMM> <altoMM>
//   El PNG del dorso (si hay 2 caras) se escribe como <out sin ext>-dorso.<ext>.
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const path = require('path');

const [inHtml, outPdf, outPng, anchoMM, altoMM] = process.argv.slice(2);
const salida = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!inHtml) salida({ ok: false, error: 'falta el html' });

const MM_PX = 96 / 25.4;                       // 1mm en px CSS
const W = Math.round(Number(anchoMM) * MM_PX);
const H = Math.round(Number(altoMM) * MM_PX);
const MAX_PREVIEW = 1600;                      // acota el PNG de un cartel grande, sin perder proporción
const escala = Math.min(1, MAX_PREVIEW / Math.max(W, H));
const dorsoPath = outPng.replace(/(\.[^.]+)$/, '-dorso$1');

(async () => {
  let b;
  try {
    b = await chromium.launch();
    const ctx = await b.newContext({ deviceScaleFactor: Math.max(1, Math.min(2, 1 / escala)) });
    const p = await ctx.newPage();
    await p.goto('file://' + path.resolve(inHtml), { waitUntil: 'networkidle', timeout: 60000 });

    // PDF a tamaño físico real (lo manda el @page del HTML) y con fondos. Una página por cara.
    await p.emulateMedia({ media: 'print' });
    await p.pdf({ path: outPdf, printBackground: true, preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' } });

    // Preview: en pantalla, con zoom para acotar el tamaño; un screenshot por cara (.lienzo).
    await p.emulateMedia({ media: 'screen' });
    await p.addStyleTag({ content:
      `html,body{margin:0!important;padding:0!important;background:#fff!important;zoom:${escala};}` });
    await p.waitForTimeout(300);
    const caras = await p.locator('.lienzo').count();
    const salidas = [outPng, dorsoPath];
    let hechas = 0;
    for (let i = 0; i < Math.min(caras, 2); i++) {
      await p.locator('.lienzo').nth(i).screenshot({ path: salidas[i] });
      hechas++;
    }
    if (!hechas) {   // fallback: no encontró .lienzo, capturo el viewport
      await p.setViewportSize({ width: Math.round(W * escala), height: Math.round(H * escala) });
      await p.screenshot({ path: outPng });
      hechas = 1;
    }
    await b.close();
    salida({ ok: true, caras: hechas, px: `${W}x${H}` });
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    salida({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
