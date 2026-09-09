#!/usr/bin/env node
/* Foto diaria de la carta online del negocio.
 *
 * POR QUÉ EXISTE. Media docena de las consultas que el asistente de WhatsApp derivaba a una
 * persona estaban contestadas en la propia carta: si el menú ejecutivo es de lunes a viernes,
 * cuánto sale el combo de sándwich de vacío, qué hay para vegetarianos. El bot no las podía leer.
 *
 * POR QUÉ UNA COPIA Y NO LEERLA EN EL MOMENTO. El menú es una aplicación JavaScript: el HTML llega
 * vacío y hay que renderizarlo con un navegador para sacarle el texto. Eso tarda segundos y no se
 * puede hacer con alguien esperando del otro lado. Se guarda una foto por día y el bot lee de ahí.
 *
 * Si la carta no se puede leer, se deja el error a la vista y se CONSERVA el texto anterior: una
 * carta de ayer sirve; ninguna carta no.
 */
const { chromium } = require('/root/clausina/core/node_modules/playwright');
const { execFileSync } = require('child_process');

// A la base se llega como el resto de los jobs del host: por el contenedor de Postgres. Sin
// cliente de pg instalado acá y sin puerto publicado, es el camino que ya usan colabs_sync y
// compañía, y evita repartir la contraseña en un lugar más.
const PG = () => execFileSync('docker', ['ps', '-q', '-f', 'name=crm_pgvector.1'], { encoding: 'utf8' })
  .trim().split('\n')[0];
function psql(sql, params = []) {
  // Los parámetros van por stdin en un DO/SELECT preparado no: se escapan acá, que es lo único
  // que entra —urls y texto de la carta— y así no se arma SQL con concatenación a ciegas.
  const esc = (v) => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  const q = sql.replace(/\$(\d+)/g, (_, i) => esc(params[Number(i) - 1]));
  const out = execFileSync('docker', ['exec', '-i', PG(), 'psql', '-U', 'postgres', '-d', 'claude',
    '-At', '-F', '|', '-c', q], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.trim() ? out.trim().split('\n').map(l => l.split('|')) : [];
}

const fin = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };

async function leerCarta(url) {
  let b;
  try {
    b = await chromium.launch({ args: ['--no-sandbox'] });
    const p = await b.newPage({ viewport: { width: 420, height: 1400 } });
    await p.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(2500);
    // Categorías plegadas: se abren para que el texto traiga los platos y no sólo los títulos.
    for (let i = 0; i < 3; i++) {
      const n = await p.$$eval('button,[role=button]', els => {
        let c = 0;
        els.forEach(e => { if (/ver|más|mas|abrir|categor/i.test(e.textContent || '')) { e.click(); c++; } });
        return c;
      }).catch(() => 0);
      await p.waitForTimeout(800);
      if (!n) break;
    }
    // Cargas perezosas: se recorre la página entera antes de leerla.
    await p.evaluate(async () => {
      for (let y = 0; y < 25; y++) { window.scrollBy(0, 900); await new Promise(r => setTimeout(r, 200)); }
    });
    await p.waitForTimeout(1500);
    const txt = await p.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').trim());
    await b.close();
    return txt;
  } catch (e) {
    try { if (b) await b.close(); } catch (_) {}
    throw e;
  }
}

(async () => {
  const filas = psql('SELECT c.negocio_id, c.url, n.slug FROM contenido.negocio_carta c '
                   + 'JOIN contenido.negocios n ON n.id=c.negocio_id');
  const hechas = [];
  for (const [negocio_id, url, slug] of filas) {
    const r = { negocio_id, url, slug };
    try {
      const txt = await leerCarta(r.url);
      // Una carta de 200 caracteres es una página que no cargó, no una carta corta. Guardarla
      // sería peor que no tocar nada: el bot contestaría con la mitad del menú.
      if (!txt || txt.length < 400) throw new Error(`la página devolvió ${txt ? txt.length : 0} caracteres`);
      psql('UPDATE contenido.negocio_carta SET texto=$2, actualizado_en=now(), error=NULL WHERE negocio_id=$1',
           [r.negocio_id, txt.slice(0, 20000)]);
      hechas.push(`${r.slug}: ${txt.length} caracteres`);
    } catch (e) {
      psql('UPDATE contenido.negocio_carta SET error=$2 WHERE negocio_id=$1',
           [r.negocio_id, String(e.message || e).slice(0, 300)]);
      hechas.push(`${r.slug}: ERROR ${String(e.message || e).slice(0, 80)}`);
    }
  }
  fin({ ok: true, cartas: hechas });
})().catch(e => fin({ ok: false, error: String(e.message || e) }));
