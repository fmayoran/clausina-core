#!/usr/bin/env node
// Render de una pieza gráfica: HTML a medida exacta -> PDF listo para imprenta (con sangre) +
// un PNG de preview por cara. Una pieza puede tener 1 o 2 caras (frente / frente y dorso):
// en el HTML cada cara es un bloque .lienzo; el PDF sale con una página por cara.
//
// Uso: grafica_render.js <in.html> <out.pdf> <out.png> <anchoMM> <altoMM>
//   El PNG del dorso (si hay 2 caras) se escribe como <out sin ext>-dorso.<ext>.
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const path = require('path');
const { execFileSync } = require('child_process');

const [inHtml, outPdf, outPng, anchoMM, altoMM] = process.argv.slice(2);
const salida = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!inHtml) salida({ ok: false, error: 'falta el html' });

const MM_PX = 96 / 25.4;                       // 1mm en px CSS
const W = Math.round(Number(anchoMM) * MM_PX);
const H = Math.round(Number(altoMM) * MM_PX);
// El PNG no es sólo un preview: es lo que se imprime cuando la pieza va al frente de una
// invitación. A escala 1 sale a 96 dpi —una A6 en 397x560 px— y en papel se ve blando. Se apunta
// a 300 dpi reales, con un tope de lado para que un afiche A3 no termine en un archivo enorme:
// ahí baja a ~150 dpi, que a distancia de cartel alcanza.
const DPI_IMPRENTA = 300;
const MAX_LADO = 3600;
const escala = Math.max(1, Math.min(DPI_IMPRENTA / 96, MAX_LADO / Math.max(W, H)));
/** Lleva el PNG a la medida nominal si la captura se pasó por el redondeo. Sólo corrige
 *  diferencias de 1-2 px: si el desvío es mayor, algo más está mal y taparlo con un resize
 *  escondería el problema, así que se deja como salió. */
function ajustar(file, w, h) {
  if (!(w > 0 && h > 0)) return;
  try {
    const [aw, ah] = execFileSync('identify', ['-format', '%w %h', file], { encoding: 'utf8' })
      .trim().split(/\s+/).map(Number);
    if (aw === w && ah === h) return;
    if (Math.abs(aw - w) > 2 || Math.abs(ah - h) > 2) return;
    execFileSync('convert', [file, '-resize', `${w}x${h}!`, file], { stdio: 'ignore' });
  } catch (_) { /* sin ImageMagick el PNG sirve igual: no se cae el render por un píxel */ }
}

const dorsoPath = outPng.replace(/(\.[^.]+)$/, '-dorso$1');
const prevPath = outPng.replace(/(\.[^.]+)$/, '-prev.jpg');

(async () => {
  let b;
  try {
    b = await chromium.launch();
    const ctx = await b.newContext({ deviceScaleFactor: escala });
    const p = await ctx.newPage();
    await p.goto('file://' + path.resolve(inHtml), { waitUntil: 'networkidle', timeout: 60000 });

    // PDF a tamaño físico real (lo manda el @page del HTML) y con fondos. Una página por cara.
    await p.emulateMedia({ media: 'print' });
    await p.pdf({ path: outPdf, printBackground: true, preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' } });

    // El PNG por cara. Sin zoom: el tamaño lo da el deviceScaleFactor, y hacer las dos cosas
    // encogía la pieza justo cuando se la quería más grande.
    await p.emulateMedia({ media: 'screen' });
    await p.addStyleTag({ content:
      'html,body{margin:0!important;padding:0!important;background:#fff!important;}' });
    await p.waitForTimeout(300);
    const caras = await p.locator('.lienzo').count();
    const salidas = [outPng, dorsoPath];
    let hechas = 0;
    // Medida NOMINAL exacta, sin el redondeo de la captura. Cuando el lienzo mide una fracción de
    // píxel CSS (una pieza de Instagram: 91,44mm = 345,6 px), Playwright redondea la caja hacia
    // arriba y el PNG sale en 1081 en vez de 1080. Un píxel no rompe nada, pero deja la pieza fuera
    // de la medida que declara el formato y obliga a Instagram a recomprimirla.
    const nomW = Math.round(Number(anchoMM) * MM_PX * escala);
    const nomH = Math.round(Number(altoMM) * MM_PX * escala);
    for (let i = 0; i < Math.min(caras, 2); i++) {
      await p.locator('.lienzo').nth(i).screenshot({ path: salidas[i] });
      ajustar(salidas[i], nomW, nomH);
      hechas++;
    }
    if (!hechas) {   // fallback: no encontró .lienzo, capturo el viewport
      await p.setViewportSize({ width: W, height: H });
      await p.screenshot({ path: outPng });
      hechas = 1;
    }
    await b.close();

    // El PNG grande es para imprimir. La grilla del panel muestra nueve piezas: bajar 6 MB por
    // cada una para dibujar una miniatura es la clase de cosa que hace pensar que el panel está
    // roto. Sale una copia liviana del frente, y si falla no se cae el render.
    try {
      execFileSync('convert', [outPng, '-resize', '900x900>', '-strip', '-quality', '82', prevPath],
                   { stdio: 'ignore' });
    } catch (_) {}

    salida({ ok: true, caras: hechas, prev: require('fs').existsSync(prevPath), px: `${Math.round(Number(anchoMM) * MM_PX * escala)}x${Math.round(Number(altoMM) * MM_PX * escala)}`,
             dpi: Math.round(96 * escala) });
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    salida({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
