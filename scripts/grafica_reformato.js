#!/usr/bin/env node
// Cambia el TAMAÑO de una pieza sin rediseñarla: escala el lienzo entero.
// Uso: grafica_reformato.js <entrada.html> <salida.html> <anchoMM> <altoMM>   (medidas CON sangre)
//
// Sirve cuando el diseño ya está aprobado y sólo cambia el formato —un flyer A5 que pasa a A6—.
// Rediseñarlo desde cero devolvería otra pieza; acá vuelve la misma, más chica.
//
// Ojo con "proporcional": A5 es 148×210 y A6 105×148, y esos números NO guardan exactamente la
// misma proporción (0,7095 contra 0,7048) porque la norma los redondea a milímetros enteros. Se
// escala por el lado que MÁS necesita, así el diseño sobra un poco y no queda ningún borde sin
// cubrir; el excedente se lo come la sangre, que existe justamente para eso.
const fs = require("fs");

const [entrada, salida, aW, aH] = process.argv.slice(2);
const fin = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
if (!entrada || !salida || !aW || !aH) fin({ ok: false, error: "uso: <in> <out> <anchoMM> <altoMM>" });

const nw = Number(aW), nh = Number(aH);
if (!(nw > 0 && nh > 0)) fin({ ok: false, error: "medidas inválidas" });

let html;
try { html = fs.readFileSync(entrada, "utf8"); } catch (e) { fin({ ok: false, error: "no pude leer el diseño" }); }

// El tamaño actual sale del @page del propio diseño: es el único lugar donde está declarado en
// milímetros reales y sin depender de cómo se llamen las clases.
const m = html.match(/@page[^{]*\{[^}]*size:\s*([\d.]+)mm\s+([\d.]+)mm/i);
if (!m) fin({ ok: false, error: "el diseño no declara su tamaño en @page; no se puede reescalar" });
const vw = parseFloat(m[1]), vh = parseFloat(m[2]);

const k = Math.max(nw / vw, nh / vh);
// Cada cara tiene que ocupar EXACTAMENTE una página. Escalar a secas deja el lienzo un pelo más
// alto que la hoja —el sobrante de escalar por el lado mayor—, y ese milímetro y medio empuja
// contenido a una página de más. Se le fija la medida previa al zoom para que, ya escalado, dé
// justo; lo que sobra lo recorta el propio lienzo, que es para lo que está la sangre.
const preW = (nw / k).toFixed(3), preH = (nh / k).toFixed(3);
// El bloque va delimitado para poder SACARLO antes de escribir el nuevo. Sin esto, reformatear
// dos veces apila dos bloques y gana lo peor de cada uno: pasó al corregir G-0003, donde el
// recorte del primer intento seguía activo y el PDF salía con una sola cara.
const MARCA_INI = "/* ── reformato ClaUsina ── */", MARCA_FIN = "/* ── fin reformato ── */";
const css = `
${MARCA_INI}
/* ${vw}×${vh}mm → ${nw}×${nh}mm (${new Date().toISOString().slice(0, 16)}) */
@page { size: ${nw}mm ${nh}mm; margin: 0; }
html, body { width: ${nw}mm; margin: 0; }
/* zoom y no transform: zoom rehace el layout, así los milímetros de adentro se recalculan y el
   texto no queda pixelado como pasaría con una escala visual. */
.lienzo { zoom: ${k.toFixed(5)}; width: ${preW}mm; height: ${preH}mm; overflow: hidden; }
${MARCA_FIN}
`;

// Fuera el bloque anterior, si lo hay: el tamaño de origen se lee del @page original, que nunca
// se toca, así que reformatear de nuevo siempre parte del diseño como fue dibujado.
const desde = html.indexOf(MARCA_INI);
if (desde >= 0) {
  const hasta = html.indexOf(MARCA_FIN, desde);
  if (hasta > desde) html = html.slice(0, desde) + html.slice(hasta + MARCA_FIN.length);
}

const i = html.lastIndexOf("</style>");
const out = i >= 0 ? html.slice(0, i) + css + html.slice(i)
                   : html.replace("</head>", `<style>${css}</style></head>`);
try { fs.writeFileSync(salida, out); } catch (e) { fin({ ok: false, error: "no pude escribir el diseño" }); }
fin({ ok: true, de: `${vw}x${vh}`, a: `${nw}x${nh}`, zoom: +k.toFixed(5),
      queda: `${(vw * k).toFixed(1)}x${(vh * k).toFixed(1)}` });
