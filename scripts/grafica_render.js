#!/usr/bin/env node
// Render de una pieza gráfica: HTML a medida exacta -> PDF listo para imprenta (con sangre) + PNG
// de preview. Mismo motor que el manual de marca, pero a cualquier tamaño (flyer A5 … cartel 3m).
//
// El HTML define el tamaño con @page {size: <W>mm <H>mm; margin:0} y una .lienzo de esas medidas.
// La sangre ya viene incluida en W/H (el job las suma), así que acá no se agrega nada: se respeta
// lo que el HTML declara (preferCSSPageSize).
//
// Uso: grafica_render.js <in.html> <out.pdf> <out.png> <anchoMM> <altoMM>
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const path = require('path');

const [inHtml, outPdf, outPng, anchoMM, altoMM] = process.argv.slice(2);
const salida = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!inHtml) salida({ ok: false, error: 'falta el html' });

const MM_PX = 96 / 25.4;                       // 1mm en px CSS
const W = Math.round(Number(anchoMM) * MM_PX);
const H = Math.round(Number(altoMM) * MM_PX);
// El preview no necesita el tamaño físico: lo acotamos para que un cartel de 3m no genere un PNG
// gigante, pero manteniendo la proporción exacta.
const MAX_PREVIEW = 1600;
const escala = Math.min(1, MAX_PREVIEW / Math.max(W, H));

(async () => {
  let b;
  try {
    b = await chromium.launch();
    const ctx = await b.newContext({
      viewport: { width: Math.max(1, Math.round(W * escala)), height: Math.max(1, Math.round(H * escala)) },
      deviceScaleFactor: Math.max(1, Math.min(2, 1 / escala)),   // nitidez sin archivos absurdos
    });
    const p = await ctx.newPage();
    await p.goto('file://' + path.resolve(inHtml), { waitUntil: 'networkidle', timeout: 60000 });

    // PDF a tamaño físico real (lo manda el @page del HTML) y con fondos.
    await p.emulateMedia({ media: 'print' });
    await p.pdf({ path: outPdf, printBackground: true, preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' } });

    // PNG de preview: en pantalla, escalado a la proporción exacta.
    await p.emulateMedia({ media: 'screen' });
    await p.addStyleTag({ content:
      `html,body{margin:0!important;padding:0!important;background:#fff!important;}
       .lienzo{transform:scale(${escala});transform-origin:top left;}` });
    await p.waitForTimeout(300);
    await p.screenshot({ path: outPng,
      clip: { x: 0, y: 0, width: Math.max(1, Math.round(W * escala)), height: Math.max(1, Math.round(H * escala)) } });

    await b.close();
    salida({ ok: true, px: `${W}x${H}`, preview: `${Math.round(W * escala)}x${Math.round(H * escala)}` });
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    salida({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
