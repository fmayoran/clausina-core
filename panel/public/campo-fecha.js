/* Campo de fecha dd/mm/aaaa con calendario propio — ClaUsina.
 *
 * El <input type="date"> nativo muestra los segmentos en el orden del NAVEGADOR, no del sitio.
 * Con el navegador en inglés, escribir 28/8/2026 guarda el 2 como mes y el 8 como día: queda
 * 08/02/2026. Pasó de verdad, y dejó cinco invitaciones vencidas antes de nacer.
 *
 * Vivía dentro de reservas.html. Se saca acá para que la segunda pantalla que necesite una fecha
 * no arranque copiando ochenta líneas — que es como se terminan teniendo dos campos que se
 * comportan distinto.
 *
 * Marcado esperado:
 *   <div class="fecha">
 *     <input type="text" class="fecha-txt" readonly placeholder="dd/mm/aaaa">
 *     <button type="button" class="fecha-btn" aria-label="Abrir calendario">…</button>
 *     <div class="fecha-pop"></div>
 *   </div>
 *
 * Uso:  const f = CampoFecha(cont, { min: '2026-08-06', onChange(iso) {…} });
 *       f.valor = '2026-08-28';   f.valor  // '2026-08-28'
 */
const DIAS_CF = [[1,'lun'],[2,'mar'],[3,'mié'],[4,'jue'],[5,'vie'],[6,'sáb'],[7,'dom']];
const hoyISO = () => new Date().toISOString().slice(0, 10);

// El nativo <input type="date"> muestra el formato del navegador, no el del sitio. Este campo
// siempre escribe dd/mm/aaaa y trae su propio calendario.
const aLatino = iso => iso ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : '';

function CampoFecha(cont, opts) {
  opts = opts || {};
  let iso = '', mes = '';
  const txt = cont.querySelector('.fecha-txt');
  const pop = cont.querySelector('.fecha-pop');

  function pintar() {
    const y = +mes.slice(0, 4), m = +mes.slice(5, 7);
    const nom = new Date(mes + 'T12:00:00').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    const arranque = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() || 7) - 1;
    const dias = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let celdas = '';
    for (let i = 0; i < arranque; i++) celdas += '<button type="button" class="fp-d vacia"></button>';
    for (let d = 1; d <= dias; d++) {
      const f = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const fuera = opts.min && f < opts.min;
      celdas += `<button type="button" class="fp-d${fuera ? ' off' : ''}${f === iso ? ' sel' : ''}${f === hoyISO() ? ' hoy' : ''}"
        ${fuera ? 'disabled' : `data-f="${f}"`}>${d}</button>`;
    }
    pop.innerHTML = `<div class="fp-cab">
        <button type="button" class="fp-nav" data-mes="-1">‹</button>
        <span class="fp-mes">${nom}</span>
        <button type="button" class="fp-nav" data-mes="1">›</button>
      </div>
      <div class="fp-grid">${DIAS_CF.map(([, l]) => `<span class="fp-dow">${l.slice(0,1)}</span>`).join('')}${celdas}</div>`;
  }
  function abrir() { mes = (iso || hoyISO()).slice(0, 8) + '01'; pintar(); pop.classList.add('on'); }
  function cerrar() { pop.classList.remove('on'); }

  txt.addEventListener('click', () => pop.classList.contains('on') ? cerrar() : abrir());
  cont.querySelector('.fecha-btn').addEventListener('click', e => {
    e.preventDefault(); pop.classList.contains('on') ? cerrar() : abrir();
  });
  pop.addEventListener('click', e => {
    const nav = e.target.closest('.fp-nav');
    if (nav) { const d = new Date(mes + 'T12:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + (+nav.dataset.mes), 1);
      mes = d.toISOString().slice(0, 10); pintar(); return; }
    const dia = e.target.closest('.fp-d[data-f]');
    if (dia) { api.valor = dia.dataset.f; cerrar(); if (opts.onChange) opts.onChange(iso); }
  });
  // Cerrar al tocar fuera: si no, quedan dos calendarios abiertos pisándose.
  document.addEventListener('click', e => {
    // Se mira el CAMINO del evento y no `contains`: al cambiar de mes el calendario se repinta
    // entero, así que para cuando el clic llega hasta acá el botón ‹ o › que se tocó ya no está
    // en el DOM, `contains` da false y el calendario se cerraba justo al navegar. composedPath
    // se arma al despachar el evento, cuando el botón todavía existía.
    const camino = e.composedPath ? e.composedPath() : [];
    if (!camino.includes(cont) && !cont.contains(e.target)) cerrar();
  });

  const api = {
    get valor() { return iso; },
    set valor(v) { iso = v || ''; txt.value = aLatino(iso); },
  };
  return api;
}
