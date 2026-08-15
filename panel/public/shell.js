/* ClaUsina — shell del panel (chrome reutilizable). Ver core/planes/SISTEMA_MARCA.md.
 * Uso en cada página:
 *   <div class="shell"><main>...</main></div>
 *   <script src="shell.js"></script><script>ClausinaShell({active:'inicio'})</script>
 * Provee window.toggleMode y window.salir. El init de dark va inline en el <head>. */
(function () {
  // El menú se lee de arriba abajo en orden de uso: primero el negocio que estás mirando, después
  // la agencia, y al final la administración —que se toca una vez por mes y no tiene por qué
  // ocupar el mismo lugar que el trabajo diario—. `ambito:'negocio'` marca los grupos que
  // dependen del selector de arriba: sin esa distinción, "Instagram" no dice de quién es.
  var NAV = {
    Identidad: [
      { id: 'identidad', label: 'Identidad',         icon: 'id-card',     href: 'identidad' },
      // Vive acá y no en Comunicación: mide quién es el negocio puertas afuera (su presencia),
      // no una pieza que haya que aprobar. Antes no tenía entrada y se llegaba sólo de rebote.
      { id: 'auditoria', label: 'Auditoría',         icon: 'chart-column', href: 'auditoria' },
    ],
    'Comunicación': [
      // Primera del grupo: una campaña es el paraguas del que cuelgan las demás acciones de
      // comunicación, así que se lee antes que las piezas sueltas.
      { id: 'campanias', label: 'Campañas',          icon: 'target',      href: 'campanias' },
      { id: 'propuestas', label: 'Propuestas',       icon: 'lightbulb',   href: 'propuestas' },
      { id: 'cola',      label: 'Cola y aprobación', icon: 'inbox',       href: 'proyecto' },
      { id: 'instagram', label: 'Instagram',         icon: 'instagram',   href: 'instagram' },
      { id: 'avisos',    label: 'Avisos',            icon: 'megaphone',   href: 'avisos' },
      { id: 'grafica',   label: 'Gráfica',          icon: 'layout-template', href: 'grafica' },
      { id: 'landing',   label: 'Landing',           icon: 'globe',       href: 'landing' },
      { id: 'pauta',     label: 'Pauta',             icon: 'badge-dollar-sign', href: 'pauta' },
      { id: 'biblioteca',label: 'Biblioteca',        icon: 'images',      href: 'biblioteca' },
    ],
    // WhatsApp vive acá y no en Comunicación: todo lo que está allá pasa por la compuerta de
    // aprobación — nada sale sin visto humano. El bot contesta en tiempo real y toma reservas,
    // que es el modo de falla de Operación.
    'Operación': [
      { id: 'clientes',  label: 'Clientes',          icon: 'users-round',    href: 'clientes' },
      { id: 'reservas',  label: 'Reservas',          icon: 'calendar-check', href: 'reservas' },
      { id: 'whatsapp',  label: 'WhatsApp',          icon: 'message-circle', href: 'whatsapp' },
      { id: 'invitaciones', label: 'Invitaciones',   icon: 'ticket',         href: 'invitaciones' },
    ],
    Agencia: [
      { id: 'inicio',       label: 'Inicio',            icon: 'layout-dashboard', href: '.' },
      { id: 'maquinas',     label: 'Sala de máquinas',  icon: 'gauge',            href: 'maquinas' },
      { id: 'negocios',     label: 'Negocios',          icon: 'boxes',            href: 'negocios' },
      { id: 'pantallas',    label: 'Pantallas',         icon: 'monitor',          href: 'audiovisual' },
      { id: 'estilo',       label: 'Sistema de diseño', icon: 'palette',          href: 'estilo' },
      // Las instrucciones de los agentes: genéricas de la agencia. Lo particular de cada negocio
      // vive en Identidad, y el agente lo lee del negocio activo.
      { id: 'skills',       label: 'Skills',            icon: 'sparkles',         href: 'skills' },
    ],
    // Lo estructural: se configura una vez y se mira poco. Arranca plegada a propósito.
    'Administración': [
      { id: 'arquitectura', label: 'Arquitectura',      icon: 'git-fork',    href: 'arquitectura' },
      { id: 'usuarios',     label: 'Usuarios',          icon: 'users',       href: 'usuarios' },
      { id: 'rubros',       label: 'Rubros y atributos',icon: 'tags',        href: 'rubros' },
    ],
    // Fuera de las secciones de negocio: es la cuenta de quien está mirando, no del negocio activo.
    Vos: [
      { id: 'micuenta',  label: 'Mi cuenta',         icon: 'user-round',  href: 'mi-cuenta' },
    ],
  };

  // Los grupos que dependen del negocio activo. Se dibujan pegados al selector y con un filete
  // al costado: es lo que contesta "¿esto es de Cortafuego o de la agencia?" sin agregar texto.
  var AMBITO_NEGOCIO = ['Identidad', 'Comunicación', 'Operación'];
  // Plegadas la primera vez. Después manda lo que haya elegido la persona.
  var PLEGADAS_POR_DEFECTO = ['Administración'];

  function link(it, active) {
    var on = it.id === active;
    var cls = on
      ? 'on flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm transition'
      : 'flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm text-pmut dark:text-mut hover:text-pfg dark:hover:text-fg hover:bg-black/5 dark:hover:bg-white/5 transition';
    return '<a href="' + it.href + '" data-nav="' + it.id + '" class="' + cls + '"><i data-lucide="' + it.icon + '" class="w-4 h-4 shrink-0"></i><span class="nlabel">' + it.label + '</span></a>';
  }

  // Qué secciones están plegadas. Se recuerda entre visitas: si alguien plegó Agencia porque no
  // la usa, volver a abrírsela en cada carga sería molesto.
  function plegadas() {
    try {
      var g = localStorage.getItem('clausina-nav-plegadas');
      // Nunca eligió nada: arranca con lo estructural plegado. Distinto de haber elegido
      // "ninguna plegada", que es una lista vacía y hay que respetar.
      return g === null ? PLEGADAS_POR_DEFECTO.slice() : JSON.parse(g || '[]');
    } catch (e) { return []; }
  }
  function guardarPlegadas(arr) {
    try { localStorage.setItem('clausina-nav-plegadas', JSON.stringify(arr)); } catch (e) {}
  }

  function nav(active) {
    var cerradas = plegadas();
    var out = '';
    Object.keys(NAV).forEach(function (sec) {
      // La sección de la página actual nunca arranca plegada: esconder dónde estás parado
      // es peor que un menú largo.
      var tiene = NAV[sec].some(function (it) { return it.id === active; });
      var off = cerradas.indexOf(sec) >= 0 && !tiene;
      var neg = AMBITO_NEGOCIO.indexOf(sec) >= 0;
      out += '<button type="button" data-sec="' + sec + '" class="nsec' + (off ? ' plegada' : '') +
        (neg ? ' delnegocio' : '') +
        ' w-full flex items-center gap-1.5 mono text-[10px] tracking-[0.16em] uppercase text-pmut dark:text-mut px-2.5 mb-1 mt-4 first:mt-0 hover:text-pfg dark:hover:text-fg transition">' +
        '<svg class="chev w-3 h-3 shrink-0 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
        '<span>' + sec + '</span></button>';
      out += '<div class="ngrupo' + (off ? ' oculta' : '') + (neg ? ' delnegocio' : '') +
        '" data-grupo="' + sec + '">' +
        NAV[sec].map(function (it) { return link(it, active); }).join('') + '</div>';
    });
    return out;
  }

  // Secciones que pertenecen al negocio activo (y no a la plataforma): definen el breadcrumb.
  var SECS_NEGOCIO = AMBITO_NEGOCIO;
  function labelOf(id){ for(var s in NAV){ for(var i=0;i<NAV[s].length;i++) if(NAV[s][i].id===id) return NAV[s][i].label; } return ''; }
  function sectionOf(id){ for(var s in NAV){ for(var i=0;i<NAV[s].length;i++) if(NAV[s][i].id===id) return s; } return ''; }
  // Breadcrumb contextual: Inicio › Marca › Página. La Marca enlaza al proyecto (home de la marca).
  function crumb(active){
    if(!active || active==='inicio') return '';
    var lab=labelOf(active); if(!lab) return '';
    var L='mono text-[11px] text-pmut dark:text-mut hover:text-pfg dark:hover:text-fg transition';
    var S='<span class="mono text-[11px] text-pmut dark:text-mut opacity-50">/</span>';
    var CUR='mono text-[11px] text-pfg dark:text-fg';
    var out='<nav class="flex items-center flex-wrap gap-2 mb-6"><a class="'+L+'" href=".">Inicio</a>';
    if(SECS_NEGOCIO.indexOf(sectionOf(active))>=0){
      if(active==='cola'){ out+=S+'<span class="'+CUR+'" id="cr-marca">negocio</span>'; }
      else { out+=S+'<a class="'+L+'" href="proyecto" id="cr-marca">negocio</a>'+S+'<span class="'+CUR+'">'+lab+'</span>'; }
    } else {
      out+=S+'<span class="'+CUR+'">'+lab+'</span>';
    }
    return out+'</nav>';
  }

  function html(active) {
    return '' +
    '<aside class="sidebar bg-side dark:bg-sideD border-r border-pline dark:border-line flex flex-col gap-1 px-3 py-4 sticky top-0 h-[100dvh] overflow-y-auto">' +
      '<div class="brandhead flex items-center gap-2.5 px-2 pb-3">' +
        '<a href="." class="flex items-center gap-2.5 min-w-0 hover:opacity-80 transition" title="Ir al inicio">' +
          '<svg viewBox="0 0 28 34" width="18" height="22" fill="none" class="shrink-0"><path id="uS" d="M5 5 V19 a9 9 0 0 0 18 0 V5" class="stroke-pfg dark:stroke-fg" stroke-width="3.4" stroke-linecap="round"/><circle r="2.2" fill="#CCF24D"><animateMotion dur="2.6s" repeatCount="indefinite" rotate="auto"><mpath href="#uS"/></animateMotion></circle></svg>' +
          '<span class="wordmark display font-bold tracking-tight">ClaUsina<span class="acc-text">.</span></span>' +
        '</a>' +
        '<button onclick="document.body.classList.toggle(\'col\')" class="ml-auto grid place-items-center w-7 h-7 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-pmut dark:text-mut" aria-label="colapsar menú"><i data-lucide="panel-left-close" class="w-4 h-4"></i></button>' +
      '</div>' +
      '<div class="relative mb-3">' +
        '<button onclick="var m=document.getElementById(\'sw-menu\');if(m)m.classList.toggle(\'hidden\')" class="switch w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl border border-pline dark:border-line hover:border-acc transition text-left">' +
          '<span class="grid place-items-center w-6 h-6 rounded-lg bg-acc text-accink display font-bold text-xs shrink-0" id="sw-ini">·</span>' +
          '<span class="switch-tx min-w-0"><span class="block text-sm display font-semibold truncate" id="sw-nombre">negocio</span><span class="block mono text-[10px] text-pmut dark:text-mut">cambiar negocio</span></span>' +
          '<i data-lucide="chevrons-up-down" class="switch-tx w-4 h-4 ml-auto text-pmut dark:text-mut shrink-0"></i>' +
        '</button>' +
        '<div id="sw-menu" class="hidden absolute left-0 right-0 top-full mt-1 z-30 rounded-xl border border-pline dark:border-line bg-side dark:bg-sideD shadow-xl p-1 max-h-72 overflow-auto"></div>' +
      '</div>' +
      '<button type="button" class="nbuscar mb-2" onclick="ClausinaPaleta(true)">' +
        '<i data-lucide="search" class="w-4 h-4 shrink-0"></i><span>Buscar sección</span>' +
        '<kbd>Ctrl K</kbd></button>' +
      '<nav class="nav flex flex-col gap-0.5">' + nav(active) + '</nav>' +
      '<div class="mt-auto flex items-center gap-1 pt-3">' +
        '<button onclick="toggleMode()" class="grid place-items-center w-9 h-9 rounded-lg border border-pline dark:border-line hover:border-acc transition shrink-0" aria-label="modo"><i data-lucide="sun-medium" class="w-4 h-4 hidden dark:block"></i><i data-lucide="moon" class="w-4 h-4 block dark:hidden"></i></button>' +
        '<button onclick="salir()" class="nlabel flex-1 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-pmut dark:text-mut hover:text-cor transition"><i data-lucide="log-out" class="w-4 h-4"></i> Salir</button>' +
      '</div>' +
    '</aside>' +
    '<div class="paleta" id="paleta" onclick="if(event.target===this)ClausinaPaleta(false)">' +
      '<div class="paleta-caja">' +
        '<input id="paleta-q" placeholder="Ir a…" autocomplete="off" spellcheck="false">' +
        '<div class="paleta-lista" id="paleta-lista"></div>' +
      '</div></div>' +
    '<div class="backdrop" onclick="document.body.classList.remove(\'navopen\')"></div>' +
    '<div class="mtop flex items-center gap-2.5 px-5 h-14 bg-side dark:bg-sideD border-b border-pline dark:border-line">' +
      '<button onclick="document.body.classList.toggle(\'navopen\')" class="grid place-items-center w-9 h-9 -ml-2 rounded-lg" aria-label="menú"><i data-lucide="menu" class="w-5 h-5"></i></button>' +
      '<a href="." class="display font-bold tracking-tight">ClaUsina<span class="acc-text">.</span></a>' +
      '<button onclick="toggleMode()" class="ml-auto grid place-items-center w-9 h-9 rounded-lg border border-pline dark:border-line" aria-label="modo"><i data-lucide="sun-medium" class="w-4 h-4 hidden dark:block"></i><i data-lucide="moon" class="w-4 h-4 block dark:hidden"></i></button>' +
    '</div>';
  }

  /* ── Buscador de secciones ────────────────────────────────────────────────
   * Con 22 destinos, encontrar deja de ser mirar y pasa a ser recordar en qué grupo quedó cada
   * cosa. Escribir tres letras no exige recordar nada.
   *
   * Sale de la MISMA lista NAV que dibuja el menú: una lista aparte se desactualiza el día que
   * se agrega una sección, y el buscador queda mintiendo sin que nadie se entere. Los destinos
   * que los permisos le sacaron a esta persona tampoco se ofrecen acá.
   */
  var PAL = { items: [], sel: 0, filtrados: [] };

  function palItems() {
    var out = [];
    Object.keys(NAV).forEach(function (sec) {
      NAV[sec].forEach(function (it) {
        // Si el enlace no está en el menú, los permisos lo sacaron: tampoco va acá.
        if (!document.querySelector('[data-nav="' + it.id + '"]')) return;
        out.push({ id: it.id, label: it.label, href: it.href, icon: it.icon, grupo: sec });
      });
    });
    return out;
  }

  // Sin tildes y en minúscula: buscar "grafica" tiene que encontrar "Gráfica".
  function plano(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function palPintar() {
    var q = plano((document.getElementById('paleta-q') || {}).value || '');
    PAL.filtrados = !q ? PAL.items : PAL.items.filter(function (it) {
      return plano(it.label).indexOf(q) >= 0 || plano(it.grupo).indexOf(q) >= 0;
    });
    if (PAL.sel >= PAL.filtrados.length) PAL.sel = 0;
    var lista = document.getElementById('paleta-lista');
    if (!lista) return;
    lista.innerHTML = PAL.filtrados.length
      ? PAL.filtrados.map(function (it, i) {
          return '<a class="paleta-it' + (i === PAL.sel ? ' sel' : '') + '" href="' + it.href + '" data-i="' + i + '">' +
            '<i data-lucide="' + it.icon + '" class="w-4 h-4 shrink-0"></i>' +
            '<span>' + esc(it.label) + '</span><span class="g">' + esc(it.grupo) + '</span></a>';
        }).join('')
      : '<div class="paleta-vacio">Nada con ese nombre.</div>';
    if (window.lucide) lucide.createIcons();
    if (window.fixIgIcons) window.fixIgIcons(lista);
    var sel = lista.querySelector('.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  window.ClausinaPaleta = function (abrir) {
    var pal = document.getElementById('paleta'); if (!pal) return;
    if (abrir === false) { pal.classList.remove('on'); return; }
    PAL.items = palItems(); PAL.sel = 0;
    var q = document.getElementById('paleta-q');
    if (q) q.value = '';
    pal.classList.add('on');
    palPintar();
    if (q) q.focus();
  };

  function palTeclas(e) {
    var pal = document.getElementById('paleta');
    var abierta = pal && pal.classList.contains('on');
    var enCampo = /^(input|textarea|select)$/i.test((e.target.tagName || '')) || e.target.isContentEditable;
    if (!abierta) {
      // "/" sólo cuando no se está escribiendo en otro lado; Ctrl/⌘+K siempre.
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ClausinaPaleta(true); }
      else if (e.key === '/' && !enCampo) { e.preventDefault(); ClausinaPaleta(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); ClausinaPaleta(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); PAL.sel = Math.min(PAL.sel + 1, PAL.filtrados.length - 1); palPintar(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); PAL.sel = Math.max(PAL.sel - 1, 0); palPintar(); return; }
    if (e.key === 'Enter') {
      var it = PAL.filtrados[PAL.sel];
      if (it) { e.preventDefault(); location.href = it.href; }
    }
  }

  window.toggleMode = function () {
    var d = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('clausina-mode', d ? 'dark' : 'light'); } catch (e) {}
  };
  window.salir = async function () {
    try { await fetch('api/logout', { method: 'POST' }); } catch (e) {}
    location.href = 'login';
  };

  // Sólo aparece cuando algo está roto: un cartel permanente se vuelve parte del fondo y deja de
  // leerse a la semana.
  function avisarCaidos(shell) {
    fetch('api/salud-externa').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var lista = (d && d.chequeos) || [];
      var malos = lista.filter(function (x) { return x.estado === 'fallo'; });
      if (!malos.length) return;
      var main = shell.querySelector('main'); if (!main) return;
      var que = malos.map(function (x) { return String(x.chequeo || '').split('·')[0].trim(); }).join(', ');
      var det = malos.reduce(function (a, x) { return a.concat(x.detalle || []); }, []);
      // Los pasos van ACÁ, no del otro lado de un enlace. Mandarlo a la Sala de máquinas —que
      // tiene el circuito, los signos vitales y la integridad— para encontrar cinco renglones es
      // hacerle buscar la aguja: el problema se arregla donde se ve.
      var pasos = malos.reduce(function (a, x) { return a.concat(x.guia || []); }, []);
      var C = '#E0503A';
      var html = '<div class="mb-5 rounded-xl px-4 py-3" ' +
        'style="border:1px solid rgba(196,68,42,.35);background:rgba(196,68,42,.09)">' +
        '<div class="flex items-start gap-3">' +
        '<span style="color:' + C + ';font-size:15px;line-height:1.3">●</span>' +
        '<div class="mono text-[11px]" style="color:' + C + ';line-height:1.7">' +
        '<b>' + (malos.length === 1 ? 'Un servicio caído' : malos.length + ' servicios caídos') +
        ': ' + que + '.</b> Mientras esté así no se publica ni se mide.' +
        det.map(function (x) {
          return '<br><span style="opacity:.85">' + String(x).replace(/</g, '&lt;') + '</span>';
        }).join('') +
        '</div></div>';
      if (pasos.length) {
        html += '<details style="margin:8px 0 0 27px">' +
          '<summary class="mono text-[11px]" style="cursor:pointer;color:' + C + '">Cómo se arregla</summary>' +
          '<ol class="mono text-[11px] text-pfg dark:text-fg" style="margin:7px 0 3px 16px;line-height:1.85">' +
          pasos.map(function (g) { return '<li>' + String(g).replace(/</g, '&lt;') + '</li>'; }).join('') +
          '</ol></details>';
      }
      html += '<div class="mono text-[10px]" style="margin:8px 0 0 27px">' +
        '<a href="maquinas" class="text-pmut dark:text-mut hover:underline">Ver el estado completo en la Sala de máquinas →</a></div>';
      main.insertAdjacentHTML('afterbegin', html + '</div>');
    }).catch(function () {});
  }

  window.ClausinaShell = function (opts) {
    opts = opts || {};
    var shell = document.querySelector('.shell');
    if (!shell) return;
    if (!document.getElementById('cap-style')) {
      var st = document.createElement('style'); st.id = 'cap-style';
      st.textContent = '.nav-off{opacity:.42;} .nav-off:hover{opacity:.62;}' +
        '.capguard{margin:40px 28px;padding:28px 26px;border:1px dashed #20242B;border-radius:12px;max-width:620px;}' +
        '.capguard h2{font-size:1.4rem;font-weight:800;color:#F5F2EC;margin:0 0 8px;}' +
        '.capguard p{color:#8A8F98;line-height:1.45;margin:0 0 16px;}' +
        '.capguard a{display:inline-block;background:#CCF24D;color:#0c0c0a;font-weight:700;padding:9px 16px;border-radius:8px;text-decoration:none;}' +
        // Secciones plegables: el menú creció y ya no entra de un vistazo.
        '.nsec{cursor:pointer;background:none;border:0;text-align:left;}' +
        '.nsec .chev{transform:rotate(0deg);opacity:.55;}' +
        '.nsec.plegada .chev{transform:rotate(-90deg);}' +
        '.ngrupo{display:flex;flex-direction:column;gap:2px;}' +
        '.ngrupo.oculta{display:none;}' +
        // Un filete al costado ata los grupos del negocio activo al selector de arriba. Sin esto
        // "Instagram" y "Negocios" se ven igual y no se sabe cuál depende de cuál.
        '.nsec.delnegocio,.ngrupo.delnegocio{border-left:2px solid var(--acc,#CCF24D);' +
        'padding-left:8px;margin-left:2px;}' +
        '.nsec.delnegocio{border-left-color:color-mix(in srgb,var(--acc,#CCF24D) 45%,transparent);}' +
        '.ngrupo.delnegocio{border-left-color:color-mix(in srgb,var(--acc,#CCF24D) 20%,transparent);}' +
        // Con el menú colapsado a íconos, los títulos, las flechas y el filete estorban.
        'body.col .nsec{display:none;} body.col .ngrupo.oculta{display:flex;}' +
        'body.col .ngrupo.delnegocio{border-left:0;padding-left:0;margin-left:0;}' +
        // Buscador de secciones (Ctrl+K o /).
        '.nbuscar{display:flex;align-items:center;gap:7px;width:100%;padding:7px 10px;' +
        'border-radius:10px;border:1px solid var(--pline,#20242B);background:none;cursor:text;' +
        'color:inherit;opacity:.6;font-size:.78rem;transition:.15s;}' +
        '.nbuscar:hover{opacity:1;border-color:var(--acc,#CCF24D);}' +
        '.nbuscar kbd{margin-left:auto;font-family:\'JetBrains Mono\',monospace;font-size:.6rem;' +
        'border:1px solid currentColor;border-radius:4px;padding:1px 4px;opacity:.7;}' +
        'body.col .nbuscar span,body.col .nbuscar kbd{display:none;}' +
        '.paleta{position:fixed;inset:0;z-index:200;display:none;background:rgba(0,0,0,.55);' +
        'padding:14vh 18px 18px;}' +
        '.paleta.on{display:block;}' +
        '.paleta-caja{max-width:520px;margin:0 auto;border-radius:14px;overflow:hidden;' +
        'border:1px solid var(--pline,#20242B);background:var(--surf,#12151A);box-shadow:0 18px 60px rgba(0,0,0,.5);}' +
        '.paleta input{width:100%;padding:15px 17px;border:0;outline:none;background:none;' +
        'color:inherit;font-size:1rem;font-family:inherit;}' +
        '.paleta-lista{max-height:52vh;overflow:auto;border-top:1px solid var(--pline,#20242B);}' +
        '.paleta-it{display:flex;align-items:center;gap:10px;padding:10px 17px;cursor:pointer;' +
        'text-decoration:none;color:inherit;}' +
        '.paleta-it .g{margin-left:auto;font-family:\'JetBrains Mono\',monospace;font-size:.6rem;opacity:.5;}' +
        '.paleta-it.sel{background:color-mix(in srgb,var(--acc,#CCF24D) 14%,transparent);}' +
        '.paleta-vacio{padding:16px 17px;font-size:.8rem;opacity:.6;}';
      document.head.appendChild(st);
    }
    shell.insertAdjacentHTML('afterbegin', html(opts.active || ''));
    if (window.fixIgIcons) window.fixIgIcons(shell);

    // Plegar y desplegar secciones. Un solo listener sobre el menú, no uno por título.
    var navEl = shell.querySelector('.nav');
    if (navEl) navEl.addEventListener('click', function (e) {
      var b = e.target.closest('.nsec'); if (!b) return;
      var sec = b.getAttribute('data-sec');
      var g = navEl.querySelector('[data-grupo="' + sec.replace(/"/g, '') + '"]');
      if (!g) return;
      var cerrar = !g.classList.contains('oculta');
      g.classList.toggle('oculta', cerrar);
      b.classList.toggle('plegada', cerrar);
      var arr = plegadas().filter(function (x) { return x !== sec; });
      if (cerrar) arr.push(sec);
      guardarPlegadas(arr);
    });
    // El buscador se arma DESPUÉS de los permisos: pregunta por los enlaces que quedaron
    // dibujados, así que no puede ofrecer lo que a esta persona se le quitó.
    aplicarPermisos(opts.active || '').then(function () { PAL.items = palItems(); });
    document.addEventListener('keydown', palTeclas);
    var pq = document.getElementById('paleta-q');
    if (pq) pq.addEventListener('input', function () { PAL.sel = 0; palPintar(); });
    var plista = document.getElementById('paleta-lista');
    if (plista) plista.addEventListener('mousemove', function (e) {
      var a = e.target.closest('.paleta-it'); if (!a) return;
      var i = +a.getAttribute('data-i');
      if (i !== PAL.sel) { PAL.sel = i; palPintar(); }
    });
    marcarCapacidades();
    if (opts.cap) guardarCapacidad(opts.cap);
    // Páginas de contenido (panel.css) son dark-only: forzar dark y ocultar el toggle.
    if (opts.darkOnly) {
      document.documentElement.classList.add('dark');
      shell.querySelectorAll('[aria-label="modo"]').forEach(function (b) { b.remove(); });
    }
    // Ocultar el header/statusbar legados (las páginas viejas tenían su propio chrome).
    document.querySelectorAll('body > header').forEach(function (h) { h.style.display = 'none'; });
    var sb = document.getElementById('statusbar'); if (sb) sb.style.display = 'none';
    // Breadcrumb al tope del contenido
    var main = shell.querySelector('main');
    if (main) { var ch = crumb(opts.active || ''); if (ch) main.insertAdjacentHTML('afterbegin', ch); }
    // Alarma de servicios caídos, en TODAS las pantallas. El monitor detecta estas cosas hace
    // rato, pero vivía sólo en la Sala de máquinas: el token de Instagram estuvo vencido quince
    // días sin que nadie lo viera. Una credencial caída no publica, no mide y no avisa sola.
    avisarCaidos(shell);
    if (window.lucide) lucide.createIcons();
    // poblar el selector + dropdown de marcas
    fetch('api/negocios').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var negocios = d.negocios || [];
      var a = negocios.find(function (m) { return m.slug === d.activa; });
      var ini = document.getElementById('sw-ini'), nom = document.getElementById('sw-nombre');
      if (a && ini) ini.textContent = (a.nombre || '?').trim().charAt(0).toUpperCase() || '·';
      if (a && nom) nom.textContent = a.nombre || 'negocio';
      var crm = document.getElementById('cr-marca'); if (crm && a) crm.textContent = a.nombre || 'negocio';
      var menu = document.getElementById('sw-menu');
      if (menu) {
        menu.innerHTML = negocios.map(function (m) {
          var on = m.slug === d.activa;
          var cls = on ? 'text-pfg dark:text-fg bg-black/5 dark:bg-white/5'
                       : 'text-pmut dark:text-mut hover:text-pfg dark:hover:text-fg hover:bg-black/5 dark:hover:bg-white/5';
          return '<button onclick="ClausinaSetMarca(\'' + esc(m.slug) + '\')" class="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition ' + cls + '">' +
            '<span class="grid place-items-center w-5 h-5 rounded bg-acc text-accink display font-bold text-[10px] shrink-0">' + esc((m.nombre || '?').trim().charAt(0).toUpperCase()) + '</span>' +
            '<span class="truncate display font-medium text-sm">' + esc(m.nombre || '—') + '</span>' +
            (on ? '<i data-lucide="check" class="w-3.5 h-3.5 ml-auto acc-text shrink-0"></i>'
                : (m.activo ? '' : '<span class="ml-auto mono text-[9px] text-pmut dark:text-mut shrink-0">inactiva</span>')) +
          '</button>';
        }).join('');
        if (window.lucide) lucide.createIcons();
      }
    }).catch(function () {});
  };

  // Grisa en el menú las capacidades que la negocio activo tiene deshabilitadas (siguen visibles:
  // se habilitan desde el panel del proyecto). nav id -> capacidad.
  var NAV_CAP = { instagram: 'instagram', pauta: 'pauta', avisos: 'pantalla', landing: 'web', clientes: 'clientes', reservas: 'reservas', whatsapp: 'whatsapp', invitaciones: 'invitaciones' };
  // Secciones que son de la plataforma, no de un negocio: sólo el admin las ve.
  // 'inicio' es el tablero de la agencia (consume /api/agencia, /api/maquinas, alta de negocios):
  // para un usuario de negocio no tiene nada, así que además lo mandamos a la home de SU negocio.
  var NAV_ADMIN = ['inicio', 'maquinas', 'negocios', 'arquitectura', 'usuarios', 'rubros', 'skills'];

  function aplicarPermisos(active) {
    return fetch('api/yo').then(function (r) { return r.ok ? r.json() : null; }).then(function (yo) {
      if (!yo) return null;
      // Primer ingreso: completar el perfil antes de entrar al panel. El admin no pasa por acá
      // (la migración marcó como completos a los usuarios que ya existían).
      if (!yo.perfil_completo && !/mi-cuenta/.test(location.pathname)) {
        location.replace('mi-cuenta'); return yo;
      }
      if (yo.admin) return yo;
      NAV_ADMIN.forEach(function (id) {
        var a = document.querySelector('[data-nav="' + id + '"]');
        if (a) a.remove();
      });
      // Si una sección se quedó sin ítems, su título sobra. Se mira el GRUPO, no el hermano
      // siguiente: los enlaces viven dentro del div, así que quitarlos deja el div vacío en su
      // lugar y el título quedaba colgado igual. Con Administración —que para un usuario de
      // negocio se vacía entera— eso se veía como un encabezado sin nada debajo.
      document.querySelectorAll('.nsec').forEach(function (h) {
        var sec = h.getAttribute('data-sec');
        var g = document.querySelector('[data-grupo="' + (sec || '').replace(/"/g, '') + '"]');
        if (!g || !g.querySelector('a')) { if (g) g.remove(); h.remove(); }
      });
      if (NAV_ADMIN.indexOf(active) >= 0) location.replace('proyecto');
      return yo;
    }).catch(function () { return null; });
  }

  function marcarCapacidades() {
    fetch('api/capacidades').then(function (r) { return r.ok ? r.json() : null; }).then(function (caps) {
      if (!caps) return;
      var off = {};
      caps.forEach(function (c) { if (!c.habilitada) off[c.id] = true; });
      Object.keys(NAV_CAP).forEach(function (navId) {
        if (!off[NAV_CAP[navId]]) return;
        var a = document.querySelector('[data-nav="' + navId + '"]');
        if (a) { a.classList.add('nav-off'); a.title = 'Deshabilitada — habilitala en el panel del proyecto'; }
      });
    }).catch(function () {});
  }

  // Guarda: si la capacidad de esta página está deshabilitada para la negocio activo, mostramos
  // el aviso para habilitarla en vez del contenido (evita páginas vacías o rotas).
  function guardarCapacidad(capId) {
    fetch('api/capacidades').then(function (r) { return r.ok ? r.json() : null; }).then(function (caps) {
      if (!caps) return;
      var c = caps.find(function (x) { return x.id === capId; });
      if (!c || c.habilitada) return;
      var main = document.querySelector('.shell main');
      if (!main) return;
      main.innerHTML = '<div class="capguard"><h2>' + esc(c.label) + ' está deshabilitada</h2>' +
        '<p>Este negocio no tiene activada esta capacidad. Podés habilitarla desde el panel del proyecto ' +
        'y completar su configuración.</p><a href="proyecto">Ir al panel del proyecto</a></div>';
    }).catch(function () {});
  }

  // Lucide sacó los logos de marca: no tiene ícono 'instagram'. Usamos un SVG monocromático
  // propio (hereda currentColor, mismo peso de trazo que Lucide). window.igIcon(cls) -> markup.
  window.igIcon = function (cls) {
    return '<svg xmlns="http://www.w3.org/2000/svg" class="' + (cls || 'w-4 h-4') + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="2" y="2" width="20" height="20" rx="5"/>' +
      '<circle cx="12" cy="12" r="4"/>' +
      '<circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/>' +
      '</svg>';
  };
  // Reemplaza los <i data-lucide="instagram"> por el SVG propio (Lucide los deja vacíos).
  window.fixIgIcons = function (root) {
    (root || document).querySelectorAll('[data-lucide="instagram"]').forEach(function (el) {
      var cls = el.getAttribute('class') || 'w-4 h-4';
      el.outerHTML = window.igIcon(cls);
    });
  };

  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  window.ClausinaSetMarca = function (slug) {
    fetch('api/negocio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: slug }) })
      .then(function () { location.reload(); })
      .catch(function () { location.reload(); });
  };
})();
