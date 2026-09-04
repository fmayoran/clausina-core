/* Encuadre de una cara: detectar qué es foto y qué es texto, y traducir el ajuste a CSS.
 *
 * Este archivo lo cargan DOS lugares, y es el mismo archivo a propósito:
 *   - el panel (grafica.html), para la vista previa EN VIVO sobre el HTML de la versión;
 *   - scripts/grafica_encuadre.js, que lo inyecta en Playwright para escribir el HTML definitivo.
 * Si cada uno tuviera su copia, la previa mostraría una cosa y la pieza saldría otra, que es
 * exactamente el problema que la previa viene a resolver.
 */
(function (raiz) {
  var MM = 25.4 / 96;                      // 1 px CSS en mm
  var SIZE = { cover: 'cover', ancho: '100% auto', alto: 'auto 100%', contain: 'contain' };
  var OBJ  = { cover: 'cover', ancho: 'cover', alto: 'cover', contain: 'contain' };

  /* Un selector que no depende de que el diseño haya puesto clases: la ruta de hijos desde la
   * cara. La versión anterior exigía clase propia y se rendía ("pedí el cambio por texto") justo
   * en los diseños más simples, que son los que no la ponen. */
  function ruta(el, lienzo) {
    var pasos = [];
    for (var x = el; x && x !== lienzo; x = x.parentElement) {
      var i = Array.prototype.indexOf.call(x.parentElement.children, x) + 1;
      pasos.unshift(':nth-child(' + i + ')');
    }
    return pasos.length ? ' > ' + pasos.join(' > ') : '';
  }

  function detectar(lienzo) {
    if (!lienzo) return { error: 'el diseño no tiene .lienzo' };
    var foto = null, tipo = 'fondo', i, x, bg;
    var todos = [lienzo].concat(Array.prototype.slice.call(lienzo.querySelectorAll('*')));
    for (i = 0; i < todos.length; i++) {
      bg = getComputedStyle(todos[i]).backgroundImage;
      if (bg && bg !== 'none' && bg.indexOf('url(') >= 0) { foto = todos[i]; break; }
    }
    if (!foto) {                                   // sin fondo CSS: el <img> más grande
      var mejor = null, area = 0, imgs = lienzo.querySelectorAll('img');
      for (i = 0; i < imgs.length; i++) {
        var r = imgs[i].getBoundingClientRect();
        if (r.width * r.height > area) { area = r.width * r.height; mejor = imgs[i]; }
      }
      if (mejor) { foto = mejor; tipo = 'img'; }
    }
    // El texto es todo lo demás: los hijos directos de la cara que no son la foto ni la contienen.
    var textos = [];
    for (i = 0; i < lienzo.children.length; i++) {
      x = lienzo.children[i];
      if (!foto || (x !== foto && !x.contains(foto))) textos.push(ruta(x, lienzo));
    }
    var caja = lienzo.getBoundingClientRect();
    return {
      foto: foto ? ruta(foto, lienzo) : null, tipoFoto: tipo, hayFoto: !!foto,
      textos: textos, ancho_mm: caja.width * MM, alto_mm: caja.height * MM,
    };
  }

  /* El ajuste -> reglas CSS. Se agregan al final de la hoja y ganan por orden: el diseño original
   * no se toca, así que un encuadre siempre se puede rehacer sobre la pieza limpia. */
  function reglas(info, aj, cara) {
    if (!info || info.error) return '';
    var base = '.lienzo:nth-of-type(' + ((cara === 'dorso' ? 1 : 0) + 1) + ')';
    var out = [], i;
    var lim = function (v, d, a, b) { v = Number(v); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
    var nx = lim(aj.pos_x, 50, 0, 100), ny = lim(aj.pos_y, 50, 0, 100), z = lim(aj.zoom, 100, 40, 300);

    if (info.hayFoto) {
      var sel = base + info.foto;
      var s = SIZE[aj.size] || 'cover';
      if (z !== 100 && s !== 'contain') {
        s = s === '100% auto' ? z + '% auto' : s === 'auto 100%' ? 'auto ' + z + '%' : z + '% ' + z + '%';
      }
      out.push(info.tipoFoto === 'img'
        ? sel + '{object-fit:' + (OBJ[aj.size] || 'cover') + ' !important;object-position:' + nx + '% ' + ny + '% !important;'
          + (z !== 100 ? 'transform:scale(' + (z / 100).toFixed(3) + ');transform-origin:' + nx + '% ' + ny + '%;' : '') + '}'
        : sel + '{background-size:' + s + ' !important;background-position:' + nx + '% ' + ny + '% !important;'
          + 'background-repeat:no-repeat !important;}');
    }

    // Texto: se mueve como bloque. El desplazamiento va en mm —la pieza está diseñada en mm— para
    // que la previa del navegador y el render de imprenta den lo mismo.
    var tx = lim(aj.texto_x, 0, -50, 50), ty = lim(aj.texto_y, 0, -50, 50), te = lim(aj.texto_escala, 100, 50, 200);
    if (info.textos.length && (tx || ty || te !== 100)) {
      var dx = (tx / 100) * info.ancho_mm, dy = (ty / 100) * info.alto_mm;
      var t = 'translate(' + dx.toFixed(2) + 'mm,' + dy.toFixed(2) + 'mm)'
            + (te !== 100 ? ' scale(' + (te / 100).toFixed(3) + ')' : '');
      for (i = 0; i < info.textos.length; i++) {
        out.push(base + info.textos[i] + '{transform:' + t + ' !important;transform-origin:center center;}');
      }
    }
    return out.join('\n');
  }

  raiz.EncuadreDOM = { detectar: detectar, reglas: reglas };
})(typeof window !== 'undefined' ? window : globalThis);
