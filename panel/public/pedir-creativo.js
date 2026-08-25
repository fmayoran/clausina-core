/* ClaUsina — "Pedirle al creativo" desde donde estás trabajando.
 *
 * Hasta ahora el creativo proponía ideas sueltas y recién después se decidía en qué convertirlas.
 * Eso lo obliga a trabajar de espaldas al destino: propone sin saber si va a ser un feed, una
 * historia o un aviso de pantalla, y sin saber para qué. Acá el canal viene dado por la pantalla
 * desde la que se lo llama, y el objetivo lo escribe quien pide.
 *
 * No reemplaza el circuito: lo que vuelve son PROPUESTAS, se revisan en Ideas y de ahí siguen el
 * mismo camino de aprobación de siempre. Nada sale sin visto humano.
 *
 * Uso:  <script src="pedir-creativo.js"></script>
 *       PedirCreativo.abrir({ canal: 'instagram' })
 */
(function () {
  var CANALES = {
    instagram: { titulo: 'Pedirle publicaciones al creativo',
                 ph: 'Ej.: llenar el mediodía de la semana que viene, que se note que hay menú express y que se come rápido.' },
    aviso:     { titulo: 'Pedirle avisos al creativo',
                 ph: 'Ej.: que quien pasa por la avenida a la noche sepa que estamos abiertos y con la parrilla encendida.' },
  };
  var material = [], canal = 'instagram';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function pintarMaterial() {
    var c = $('pc-mats'); if (!c) return;
    c.innerHTML = material.length
      ? material.map(function (m, i) {
          return '<span class="pc-mat">' + esc(m.filename || 'material') +
                 '<button onclick="PedirCreativo.quitar(' + i + ')" title="Quitar">&times;</button></span>';
        }).join('')
      : '<span class="pc-vacio">sin material — el creativo va a proponer con lo que ya conoce de la marca</span>';
  }

  function abrir(op) {
    canal = (op && CANALES[op.canal]) ? op.canal : 'instagram';
    material = [];
    var cfg = CANALES[canal];
    var ov = $('pc-ov');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'pc-ov'; ov.className = 'modal';
      document.body.appendChild(ov);
    }
    ov.innerHTML =
      '<div class="modal-bg" onclick="PedirCreativo.cerrar()"></div>' +
      '<div class="modal-box pc-box">' +
        '<div class="modal-head"><div class="modal-tt">' + esc(cfg.titulo) + '</div>' +
          '<button class="modal-x" onclick="PedirCreativo.cerrar()" title="Cerrar">&times;</button></div>' +
        '<div class="modal-body">' +
          '<div class="cfgfld"><label>¿Qué querés lograr?</label>' +
            '<textarea id="pc-obj" rows="3" maxlength="1000" placeholder="' + esc(cfg.ph) + '"></textarea>' +
            '<div class="cfghint">El objetivo, no la pieza. De la pieza se encarga él.</div></div>' +
          '<div class="cfgfld"><label>Cuántas propuestas</label>' +
            '<select id="pc-cant"><option>1</option><option>2</option><option>3</option>' +
            '<option selected>5</option><option>8</option></select>' +
            '<div class="cfghint">Una sola cuando ya sabés qué querés; varias para elegir.</div></div>' +
          '<div class="cfgfld"><label>Material <span class="cfghint">— opcional</span></label>' +
            '<div class="pc-bar">' +
              '<label class="ibtn">Subir de disco<input type="file" accept="image/*,video/*" multiple hidden ' +
                'onchange="PedirCreativo.deDisco(this)"></label>' +
              '<button class="ibtn" onclick="PedirCreativo.deBiblioteca()">De la biblioteca</button>' +
            '</div>' +
            '<div id="pc-mats" class="pc-mats"></div>' +
            '<div class="cfghint">Si subís material, el creativo propone <b>usándolo</b> en vez de inventar.</div></div>' +
        '</div>' +
        '<div class="modal-foot"><button class="btn ok" id="pc-go" onclick="PedirCreativo.enviar()">Pedir propuestas</button>' +
          '<span class="msg" id="pc-msg"></span></div>' +
      '</div>';
    ov.classList.remove('hidden');
    pintarMaterial();
    var t = $('pc-obj'); if (t) t.focus();
  }

  function cerrar() { var ov = $('pc-ov'); if (ov) ov.classList.add('hidden'); }

  async function deDisco(input) {
    var files = [].slice.call(input.files || []); input.value = '';
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      try {
        var dataUrl = await new Promise(function (r) {
          var fr = new FileReader(); fr.onload = function () { r(fr.result); }; fr.readAsDataURL(f);
        });
        var d = await fetch('api/proponer/material', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: dataUrl, filename: f.name }) }).then(function (r) { return r.json(); });
        if (d.ok) { material.push(d); pintarMaterial(); }
        else if (window.toast) toast('No se pudo subir ' + f.name, true);
      } catch (e) { if (window.toast) toast('Error al subir ' + f.name, true); }
    }
  }

  // Reusa el selector de biblioteca del panel: es el mismo material y el mismo criterio.
  function deBiblioteca() {
    if (typeof abrirPicker !== 'function') { if (window.toast) toast('El selector no está disponible acá', true); return; }
    fetch('api/biblioteca').then(function (r) { return r.json(); }).then(function (data) {
      var items = (data.items || []).filter(function (i) { return i.carpeta === 'En proceso' || i.carpeta === 'Terminado'; });
      abrirPicker({ titulo: 'Material para el creativo', sub: 'elegí uno o varios', items,
        pick: async function (m, el) {
          if (el.classList.contains('bpadded')) return;
          el.classList.add('bpadded');
          var d = await fetch('api/proponer/material-biblioteca', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ media_path: m.media_path, tipo: m.tipo, filename: m.nombre || m.codigo }) })
            .then(function (r) { return r.json(); }).catch(function () { return {}; });
          if (d.ok) { material.push({ media_path: d.media_path, media_type: d.media_type, filename: d.filename });
                      pintarMaterial(); if (window.toast) toast('Agregado'); }
          else { el.classList.remove('bpadded'); if (window.toast) toast('No se pudo agregar', true); }
        } });
    }).catch(function () { if (window.toast) toast('No se pudo abrir la biblioteca', true); });
  }

  async function enviar() {
    var obj = ($('pc-obj').value || '').trim();
    var m = $('pc-msg');
    // El objetivo no es opcional: sin él vuelve a ser "proponeme cualquier cosa", que es
    // exactamente lo que estamos dejando atrás.
    if (!obj) { m.className = 'msg mal'; m.textContent = 'Contale qué querés lograr'; $('pc-obj').focus(); return; }
    var btn = $('pc-go'); btn.disabled = true; btn.textContent = 'Pidiendo…';
    try {
      var d = await fetch('api/proponer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enfasis: obj, canal: canal, cantidad: +$('pc-cant').value, material: material }) })
        .then(function (r) { return r.json(); });
      if (d.ok) {
        cerrar();
        if (window.toast) toast('Pedido enviado — el creativo está trabajando');
        // Refresco inmediato: la columna de propuestas de esta misma pantalla muestra el pedido
        // en curso, así que no hace falta un cartel aparte que diga lo mismo.
        if (typeof currentLoad === 'function') setTimeout(currentLoad, 400);
      } else { m.className = 'msg mal'; m.textContent = 'No se pudo pedir'; }
    } catch (e) { m.className = 'msg mal'; m.textContent = 'Error de conexión'; }
    btn.disabled = false; btn.textContent = 'Pedir propuestas';
  }

  window.PedirCreativo = { abrir, cerrar, enviar, deDisco, deBiblioteca,
    quitar: function (i) { material.splice(i, 1); pintarMaterial(); } };
})();
