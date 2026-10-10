#!/usr/bin/env node
/* El informe de auditoría como DOCUMENTO: un HTML autocontenido y su PDF A4.
 *
 * POR QUÉ NO ES LA PANTALLA IMPRESA. El panel muestra la auditoría de a una sección y esconde las
 * conclusiones detrás de un botón, porque ahí se navega. Un informe se lee de corrido y se manda
 * por mail: va todo junto, con portada, y las recomendaciones completas de los tres canales.
 *
 * SIN NINGUNA DEPENDENCIA EXTERNA. Los gráficos son SVG escrito a mano, no Chart.js desde un CDN.
 * Dos razones: un PDF que al renderizarse sale a buscar un script a internet falla el día que el
 * CDN tosa y nadie se enteró; y el SVG imprime nítido a cualquier tamaño, mientras que un canvas
 * se rasteriza. Las tipografías son las del sistema por lo mismo.
 *
 * Uso: auditoria_informe.js <dir_trabajo> <slug> <nombre_negocio> <salida.html> <salida.pdf>
 * Lee del dir: web.json, ig.json, pauta.json, reco_web.md, reco_ig.md, reco_pauta.md
 */
const fs = require('fs');
const path = require('path');

const [dirw, slug, nombreNeg, outHtml, outPdf] = process.argv.slice(2);
if (!dirw || !outHtml) { console.log(JSON.stringify({ ok: false, error: 'faltan argumentos' })); process.exit(2); }

const leerJson = f => { try { return JSON.parse(fs.readFileSync(path.join(dirw, f), 'utf8')); } catch (_) { return null; } };
const leerTxt  = f => { try { return fs.readFileSync(path.join(dirw, f), 'utf8'); } catch (_) { return ''; } };

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = n => (n == null ? '—' : new Intl.NumberFormat('es-AR').format(n));

/* Markdown mínimo: títulos, negrita, código, listas y párrafos. Es lo que el creativo escribe en
 * reco_*.md y nada más; un parser completo sería más superficie para que algo salga raro. */
function md(t) {
  if (!t) return '';
  const inline = s => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let lista = null;
  const cerrar = () => { if (lista) { out.push(`</${lista}>`); lista = null; } };
  for (const raw of t.split('\n')) {
    const l = raw.trim();
    if (!l) { cerrar(); continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      cerrar();
      // El informe ya tiene su propia jerarquía: el ## del markdown entra como h3 para no competir
      // con el título del canal.
      const n = Math.min(m[1].length + 1, 5);
      out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue;
    }
    if ((m = l.match(/^[-*]\s+(.*)$/))) {
      if (lista !== 'ul') { cerrar(); out.push('<ul>'); lista = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = l.match(/^(\d+)\.\s+(.*)$/))) {
      if (lista !== 'ol') { cerrar(); out.push('<ol>'); lista = 'ol'; }
      out.push(`<li>${inline(m[2])}</li>`); continue;
    }
    cerrar(); out.push(`<p>${inline(l)}</p>`);
  }
  cerrar();
  return out.join('\n');
}

/* ── Fichas de benchmark ──────────────────────────────────────────────────────────────────────
 * Cada métrica ya viene evaluada por benchmarks.py: se muestra su veredicto tal cual. No se
 * recalcula nada acá — si el informe y la pantalla difirieran, no habría forma de saber cuál
 * miente. */
const VERED = { bien: ['ok', 'En rango'], atencion: ['warn', 'Atención'], mal: ['bad', 'Fuera de rango'],
                sin_dato: ['none', 'Sin dato'] };
function fichas(ms) {
  if (!ms || !ms.length) return '';
  return `<div class="bm">${ms.map(m => {
    const [cls, rot] = VERED[m.veredicto] || VERED.sin_dato;
    const rango = (m.rango && m.rango[0] != null) ? `${m.rango[0]}–${m.rango[1]}${m.unidad || ''}` : '—';
    return `<div class="bmc ${cls}">
      <div class="bml">${esc(m.etiqueta)}</div>
      <div class="bmv">${m.valor == null ? '—' : esc(m.valor) + esc(m.unidad || '')}</div>
      <div class="bmr">referencia ${esc(rango)}</div>
      <div class="bmt">${esc(rot)}</div>
    </div>`;
  }).join('')}</div>`;
}

function fuentes(ms) {
  const f = [...new Set((ms || []).map(m => m.fuente).filter(Boolean))];
  if (!f.length) return '';
  return `<p class="fuente">Referencias: ${f.map(esc).join(' · ')}.</p>`;
}

function kpis(pares) {
  const vivos = pares.filter(p => p[1] !== null && p[1] !== undefined);
  if (!vivos.length) return '';
  return `<div class="kpis">${vivos.map(([rot, v]) =>
    `<div class="kpi"><div class="kv">${esc(v)}</div><div class="kr">${esc(rot)}</div></div>`).join('')}</div>`;
}

/* Barras horizontales en SVG. Horizontales a propósito: las etiquetas son palabras —"carrusel",
 * "reel"— y en vertical se superponen o salen rotadas. */
function barras(items, titulo, fmtVal) {
  const datos = items.filter(i => i.valor != null && !Number.isNaN(i.valor));
  if (!datos.length) return '';
  const max = Math.max(...datos.map(d => d.valor)) || 1;
  const fila = 26, anchoRot = 108, anchoBar = 330, pad = 6;
  const h = datos.length * fila + pad * 2;
  const f = fmtVal || (v => num(v));
  const barras = datos.map((d, i) => {
    const y = pad + i * fila;
    const w = Math.max(2, Math.round(d.valor / max * anchoBar));
    return `<text x="${anchoRot - 8}" y="${y + 15}" class="sl" text-anchor="end">${esc(d.rotulo)}</text>
      <rect x="${anchoRot}" y="${y + 5}" width="${w}" height="13" rx="2" class="sb"/>
      <text x="${anchoRot + w + 6}" y="${y + 15}" class="sv">${esc(f(d.valor))}</text>`;
  }).join('');
  return `<div class="graf"><div class="gt">${esc(titulo)}</div>
    <svg viewBox="0 0 ${anchoRot + anchoBar + 60} ${h}" width="100%" height="${h}">${barras}</svg></div>`;
}

/* ── Los tres canales ─────────────────────────────────────────────────────────────────────── */
function seccionWeb(k, reco) {
  if (!k || k.score == null) return '';
  return `<section class="can"><h2>Web</h2>
    <p class="sub">${esc(k.dominio || '')} · ${k.score}/100 de salud técnica ·
      ${num(k.checks_ok)} de ${num(k.checks_total)} controles en orden</p>
    ${fichas(k.metricas)}${fuentes(k.metricas)}
    ${barras((k.categorias || []).map(c => ({ rotulo: c.nombre, valor: c.pct != null ? c.pct : c.score })),
             'Controles en orden por categoría', v => v + '%')}
    <div class="reco">${md(reco)}</div></section>`;
}

function seccionIg(k, reco) {
  if (!k || !k.global) return '';
  const g = k.global, afuera = k.fuente === 'lente_publica';
  const cab = [k.followers ? num(k.followers) + ' seguidores' : null,
               afuera && k.publicaciones_totales
                 ? `${g.posts} de ${num(k.publicaciones_totales)} publicaciones leídas`
                 : `${g.posts} publicaciones`,
               k.periodo].filter(Boolean).join(' · ');
  // Medido desde afuera no existe el alcance: se muestran las métricas que SÍ se ven y se dice por
  // qué faltan las otras. Un cero en alcance se leería como "rinde mal" y lo que pasa es que es
  // privado de la cuenta.
  const fila = afuera
    ? [['Interacciones (mediana)', num(g.interac_med)], ['Interacciones (promedio)', num(g.interac_prom)],
       ['Likes por publicación', num(g.likes_prom)], ['Comentarios por publicación', num(g.comentarios_prom)]]
    : [['Alcance promedio', num(g.reach_prom)], ['Vistas promedio', num(g.views_prom)],
       ['Guardados por post', num(g.guard_prom)], ['Compartidos por post', num(g.compart_prom)]];
  const porFmt = (k.por_formato || []).map(f => ({
    rotulo: f.formato, valor: afuera ? f.interac_med : f.reach_prom }));
  const porDia = (k.por_dia || []).map(d => ({
    rotulo: d.dia, valor: afuera ? d.interac_prom : d.reach_prom }));
  return `<section class="can"><h2>Instagram</h2>
    <p class="sub">${esc(cab)}</p>
    ${afuera ? `<div class="nota"><strong>Mirada de afuera.</strong> ${esc(k.nota_fuente || '')}</div>` : ''}
    ${fichas(k.metricas)}${fuentes(k.metricas)}
    ${kpis(fila)}
    ${barras(porFmt, afuera ? 'Interacciones por formato (mediana)' : 'Alcance promedio por formato')}
    ${barras(porDia, afuera ? 'Interacciones promedio por día' : 'Alcance promedio por día')}
    ${barras((k.cadencia || []).map(c => ({ rotulo: c.mes, valor: c.posts })), 'Publicaciones por mes')}
    <div class="reco">${md(reco)}</div></section>`;
}

function seccionPauta(k, reco) {
  if (!k || !k.global) return '';
  const g = k.global;
  const filas = (k.avisos || []).map(v => `<tr>
    <td>CF-${String(v.numero).padStart(4, '0')} ${esc(v.titulo || '')}</td>
    <td class="n">US$${(v.gasto || 0).toFixed(2)}</td><td class="n">${num(v.impresiones)}</td>
    <td class="n">${v.ctr_link != null ? v.ctr_link + '%' : '—'}</td>
    <td class="n">${v.cpm != null ? 'US$' + v.cpm : '—'}</td></tr>`).join('');
  return `<section class="can"><h2>Pauta Meta</h2>
    <p class="sub">${esc(k.periodo || '')} · US$${g.gasto} invertidos</p>
    ${fichas(k.metricas)}${fuentes(k.metricas)}
    ${kpis([['Impresiones', num(g.impresiones)], ['Personas alcanzadas', num(g.alcance)],
            ['Clics al destino', num(g.clics_link)],
            ['Costo por clic', g.costo_clic != null ? 'US$' + g.costo_clic : null]])}
    ${filas ? `<table class="tab"><thead><tr><th>Creativo</th><th class="n">Gasto</th>
      <th class="n">Impresiones</th><th class="n">CTR link</th><th class="n">CPM</th></tr></thead>
      <tbody>${filas}</tbody></table>
      <p class="fuente">Los avisos se comparan por CTR de link y CPM. El alcance no compara nada:
        lo define el presupuesto.</p>` : ''}
    <div class="reco">${md(reco)}</div></section>`;
}

/* ── Documento ────────────────────────────────────────────────────────────────────────────── */
const web = leerJson('web.json'), ig = leerJson('ig.json'), pauta = leerJson('pauta.json');
const hoy = new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });

const canales = [
  web && web.score != null ? 'Web' : null,
  ig && ig.global ? 'Instagram' : null,
  pauta && pauta.global ? 'Pauta Meta' : null,
].filter(Boolean);

if (!canales.length) { console.log(JSON.stringify({ ok: false, error: 'nada que informar' })); process.exit(1); }

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
*{box-sizing:border-box;}
body{margin:0;font:11pt/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a18;}
h1{font-size:25pt;line-height:1.1;margin:0 0 6pt;letter-spacing:-.4pt;}
h2{font-size:16pt;margin:0 0 2pt;letter-spacing:-.2pt;}
h3{font-size:12pt;margin:14pt 0 4pt;}
h4,h5{font-size:11pt;margin:11pt 0 3pt;}
p{margin:0 0 7pt;} ul,ol{margin:0 0 8pt;padding-left:17pt;} li{margin:0 0 3pt;}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9.5pt;background:#f1f0ec;padding:1px 3px;border-radius:3px;}
strong{font-weight:650;}
.port{border-bottom:2.5pt solid #1a1a18;padding-bottom:12pt;margin-bottom:16pt;}
.port .ag{font-size:8.5pt;letter-spacing:1.6pt;text-transform:uppercase;color:#6e6a62;margin:0 0 10pt;}
.port .me{font-size:9.5pt;color:#55524c;margin:0;}
/* Cada canal arranca en página nueva: es un informe, no una página web que se desliza. El primero
   no, para que no quede una portada suelta con un tercio de hoja en blanco debajo. */
.can{page-break-before:always;}
.can:first-of-type{page-break-before:avoid;}
.sub{font-size:9.5pt;color:#55524c;margin:0 0 11pt;}
.nota{border-left:2.5pt solid #b06a1c;background:#fbf4ea;padding:8pt 10pt;font-size:9.5pt;margin:0 0 12pt;}
.bm{display:flex;flex-wrap:wrap;gap:7pt;margin:0 0 9pt;}
.bmc{flex:1 1 118pt;border:.8pt solid #ddd9d1;border-radius:4pt;padding:7pt 8pt;border-left-width:2.5pt;}
.bmc.ok{border-left-color:#2e7d32;} .bmc.warn{border-left-color:#c58a14;}
.bmc.bad{border-left-color:#b3261e;} .bmc.none{border-left-color:#b9b5ad;}
.bml{font-size:8pt;color:#6e6a62;text-transform:uppercase;letter-spacing:.5pt;margin-bottom:2pt;}
.bmv{font-size:16pt;font-weight:650;line-height:1.1;}
.bmr{font-size:8pt;color:#8a857c;} .bmt{font-size:8pt;font-weight:600;margin-top:2pt;}
.bmc.ok .bmt{color:#2e7d32;} .bmc.warn .bmt{color:#9a6b0e;}
.bmc.bad .bmt{color:#b3261e;} .bmc.none .bmt{color:#8a857c;}
.kpis{display:flex;flex-wrap:wrap;gap:7pt;margin:0 0 11pt;}
.kpi{flex:1 1 100pt;background:#f6f5f1;border-radius:4pt;padding:7pt 8pt;}
.kv{font-size:14pt;font-weight:650;} .kr{font-size:8pt;color:#6e6a62;}
.graf{margin:0 0 12pt;page-break-inside:avoid;}
.gt{font-size:9pt;font-weight:600;color:#55524c;margin-bottom:3pt;}
.sl{font-size:8.5px;fill:#55524c;} .sv{font-size:8.5px;fill:#1a1a18;font-weight:600;}
.sb{fill:#2f6f7d;}
.tab{width:100%;border-collapse:collapse;font-size:9pt;margin:0 0 6pt;}
.tab th,.tab td{border-bottom:.6pt solid #e4e0d8;padding:4pt 5pt;text-align:left;}
.tab th{font-size:8pt;text-transform:uppercase;letter-spacing:.4pt;color:#6e6a62;}
.tab .n{text-align:right;white-space:nowrap;}
.fuente{font-size:8.5pt;color:#8a857c;margin:0 0 10pt;}
.reco{border-top:.8pt solid #e4e0d8;margin-top:13pt;padding-top:10pt;}
.reco h3:first-child{margin-top:0;}
.pie{margin-top:18pt;padding-top:8pt;border-top:.8pt solid #e4e0d8;font-size:8pt;color:#8a857c;}
`;

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Auditoría ${esc(nombreNeg || slug)}</title><style>${CSS}</style></head><body>
<div class="port">
  <p class="ag">ClaUsina · Auditoría de presencia digital</p>
  <h1>${esc(nombreNeg || slug)}</h1>
  <p class="me">Generada el ${esc(hoy)} · ${esc(canales.join(' · '))}</p>
</div>
${seccionWeb(web, leerTxt('reco_web.md'))}
${seccionIg(ig, leerTxt('reco_ig.md'))}
${seccionPauta(pauta, leerTxt('reco_pauta.md'))}
<p class="pie">Cada número de este informe sale de una medición guardada, y cada métrica con
referencia trae su fuente al pie de la sección. Donde dice "sin dato" es que no se pudo medir, no
que el resultado sea cero.</p>
</body></html>`;

fs.writeFileSync(outHtml, html);

(async () => {
  if (!outPdf) { console.log(JSON.stringify({ ok: true, html: outHtml, pdf: null })); return; }
  let b;
  try {
    const { chromium } = require('/root/clausina/core/node_modules/playwright');
    b = await chromium.launch();
    const p = await b.newPage();
    await p.goto('file://' + path.resolve(outHtml), { waitUntil: 'load', timeout: 45000 });
    await p.emulateMedia({ media: 'print' });
    // preferCSSPageSize para que manden los márgenes del @page: con los de Chromium el A4 queda
    // con el doble de margen y el informe pierde una línea por hoja.
    await p.pdf({ path: outPdf, printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font:7.5pt -apple-system,sans-serif;color:#8a857c;
        padding:0 14mm;display:flex;justify-content:space-between;">
        <span>${esc(nombreNeg || slug)} · auditoría</span>
        <span class="pageNumber"></span></div>` });
    await b.close();
    console.log(JSON.stringify({ ok: true, html: outHtml, pdf: outPdf }));
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    // El HTML ya quedó escrito: si falla Chromium, se informa pero no se pierde el documento.
    console.log(JSON.stringify({ ok: false, html: outHtml, error: String(e.message || e).slice(0, 200) }));
    process.exit(1);
  }
})();
