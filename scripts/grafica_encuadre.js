#!/usr/bin/env node
// Reencuadra la foto de una cara SIN pasar por el director de arte.
// Uso: grafica_encuadre.js <entrada.html> <salida.html> <json_ajuste>
//   json: {"cara":"frente|dorso","size":"cover|ancho|alto|contain","pos_x":50,"pos_y":50,"zoom":100}
//
// Por qué existe: "que la imagen ocupe todo el ancho" es background-size. Pedírselo a un modelo
// que reescribe el HTML entero cuesta minutos y a veces no acierta. Acá se identifica el elemento
// con el navegador —los diseños no usan siempre el mismo nombre de clase: .frente-foto, .bg— y se
// agrega una regla al final, que gana por orden sin tocar una línea del diseño original.
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const fs = require('fs');

const [entrada, salida, crudo] = process.argv.slice(2);
const fin = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!entrada || !salida || !crudo) fin({ ok: false, error: 'uso: grafica_encuadre.js <in> <out> <json>' });

let aj;
try { aj = JSON.parse(crudo); } catch (e) { fin({ ok: false, error: 'ajuste ilegible' }); }

// Cómo se traduce cada encuadre. 'ancho' es el que faltaba: la foto llega a los dos bordes y lo
// que sobra de alto se recorta.
const SIZE = { cover: 'cover', ancho: '100% auto', alto: 'auto 100%', contain: 'contain' };
const OBJ = { cover: 'cover', ancho: 'cover', alto: 'cover', contain: 'contain' };

(async () => {
  let b;
  try {
    const html = fs.readFileSync(entrada, 'utf8');
    b = await chromium.launch();
    const p = await (await b.newContext()).newPage();
    await p.setContent(html, { waitUntil: 'domcontentloaded' });

    const cara = aj.cara === 'dorso' ? 1 : 0;
    const info = await p.evaluate((i) => {
      const caras = document.querySelectorAll('.lienzo');
      const l = caras[i] || caras[0];
      if (!l) return { error: 'el diseño no tiene .lienzo' };
      // La capa de la foto: el primer elemento con background-image, o el <img> más grande. Se
      // busca por lo que HACE y no por cómo se llama, que cambia entre diseños.
      let el = null, tipo = 'fondo';
      for (const x of [l, ...l.querySelectorAll('*')]) {
        const bg = getComputedStyle(x).backgroundImage;
        if (bg && bg !== 'none' && bg.includes('url(')) { el = x; break; }
      }
      if (!el) {
        let mejor = null, area = 0;
        for (const x of l.querySelectorAll('img')) {
          const r = x.getBoundingClientRect();
          if (r.width * r.height > area) { area = r.width * r.height; mejor = x; }
        }
        if (mejor) { el = mejor; tipo = 'img'; }
      }
      if (!el) return { error: 'esa cara no tiene foto para reencuadrar' };
      // Un selector estable: la clase si la tiene, y si no una marca propia.
      let sel;
      if (el.classList.length) sel = '.' + [...el.classList].join('.');
      else { el.setAttribute('data-encuadre', '1'); sel = '[data-encuadre="1"]'; }
      return { sel, tipo, marcado: !el.classList.length };
    }, cara);

    if (info.error) { await b.close(); fin({ ok: false, error: info.error }); }

    const nx = Math.max(0, Math.min(100, Number(aj.pos_x ?? 50)));
    const ny = Math.max(0, Math.min(100, Number(aj.pos_y ?? 50)));
    const zoom = Math.max(40, Math.min(300, Number(aj.zoom ?? 100)));
    const base = SIZE[aj.size] || 'cover';
    // El zoom multiplica el encuadre elegido. Con 'contain' no aplica: escalarlo deja de ser
    // 'entera' y el control diría una cosa y haría otra.
    let size = base;
    if (zoom !== 100 && base !== 'contain') {
      size = base === '100% auto' ? `${zoom}% auto`
           : base === 'auto 100%' ? `auto ${zoom}%`
           : `${zoom}% ${zoom}%`;
    }

    const regla = info.tipo === 'img'
      ? `${info.sel}{object-fit:${OBJ[aj.size] || 'cover'} !important;` +
        `object-position:${nx}% ${ny}% !important;` +
        (zoom !== 100 ? `transform:scale(${(zoom / 100).toFixed(3)});transform-origin:${nx}% ${ny}%;` : '') + `}`
      : `${info.sel}{background-size:${size} !important;` +
        `background-position:${nx}% ${ny}% !important;background-repeat:no-repeat !important;}`;

    // La regla va al final del <style>, alcanzada a la cara correcta. Editar la original sería
    // adivinar dónde empieza y termina; agregar gana por orden y es reversible.
    const sel = `.lienzo:nth-of-type(${cara + 1}) ${info.sel}`;
    const css = `\n/* encuadre ${new Date().toISOString().slice(0, 16)} */\n` +
                regla.replace(info.sel, sel) + '\n';
    let out = fs.readFileSync(entrada, 'utf8');
    if (info.marcado) {
      await b.close();
      fin({ ok: false, error: 'la foto no tiene clase propia; pedí el cambio por texto' });
    }
    const i = out.lastIndexOf('</style>');
    out = i >= 0 ? out.slice(0, i) + css + out.slice(i)
                 : out.replace('</head>', `<style>${css}</style></head>`);
    fs.writeFileSync(salida, out);
    await b.close();
    fin({ ok: true, selector: sel, tipo: info.tipo, size, pos: `${nx}% ${ny}%` });
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    fin({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
