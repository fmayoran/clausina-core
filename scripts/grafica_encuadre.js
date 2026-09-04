#!/usr/bin/env node
// Reencuadra una cara SIN pasar por el director de arte: foto (posición, encuadre, zoom) y texto
// sobreimpreso (desplazamiento y tamaño).
// Uso: grafica_encuadre.js <entrada.html> <salida.html> <json_ajuste>
//   json: {"cara":"frente|dorso","size":"cover|ancho|alto|contain","pos_x":50,"pos_y":50,"zoom":100,
//          "texto_x":0,"texto_y":0,"texto_escala":100}
//
// Por qué existe: "que la imagen ocupe todo el ancho" es background-size. Pedírselo a un modelo
// que reescribe el HTML entero cuesta minutos y a veces no acierta. Acá se identifica el elemento
// con el navegador —los diseños no usan siempre el mismo nombre de clase— y se agregan reglas al
// final, que ganan por orden sin tocar una línea del diseño original.
//
// La detección y las reglas NO viven acá: están en panel/public/encuadre_dom.js, que también carga
// el panel para la vista previa en vivo. Es el mismo archivo a propósito — si fueran dos, la previa
// mostraría una cosa y la pieza saldría otra.
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const MODULO = path.join(__dirname, '..', 'panel', 'public', 'encuadre_dom.js');
const [entrada, salida, crudo] = process.argv.slice(2);
const fin = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!entrada || !salida || !crudo) fin({ ok: false, error: 'uso: grafica_encuadre.js <in> <out> <json>' });

let aj;
try { aj = JSON.parse(crudo); } catch (e) { fin({ ok: false, error: 'ajuste ilegible' }); }

(async () => {
  let b;
  try {
    const html = fs.readFileSync(entrada, 'utf8');
    b = await chromium.launch();
    const p = await (await b.newContext()).newPage();
    await p.setContent(html, { waitUntil: 'domcontentloaded' });
    await p.addScriptTag({ content: fs.readFileSync(MODULO, 'utf8') });

    const cara = aj.cara === 'dorso' ? 1 : 0;
    const info = await p.evaluate((i) => {
      const caras = document.querySelectorAll('.lienzo');
      return window.EncuadreDOM.detectar(caras[i] || caras[0]);
    }, cara);
    if (info.error) { await b.close(); fin({ ok: false, error: info.error }); }

    const css = await p.evaluate(([info, aj]) => window.EncuadreDOM.reglas(info, aj, aj.cara), [info, aj]);
    await b.close();
    if (!css) fin({ ok: false, error: 'el ajuste no cambia nada de esta cara' });

    // Las reglas van al final del <style>. Editar las del diseño sería adivinar dónde empiezan y
    // terminan; agregar gana por orden y es reversible.
    const bloque = `\n/* encuadre ${new Date().toISOString().slice(0, 16)} */\n${css}\n`;
    const i = html.lastIndexOf('</style>');
    fs.writeFileSync(salida, i >= 0 ? html.slice(0, i) + bloque + html.slice(i)
                                    : html.replace('</head>', `<style>${bloque}</style></head>`));
    fin({ ok: true, foto: info.hayFoto ? info.tipoFoto : 'sin foto', bloques_de_texto: info.textos.length,
          reglas: css.split('\n').length });
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    fin({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
})();
