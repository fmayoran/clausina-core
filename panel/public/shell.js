/* ClaUsina — shell del panel (chrome reutilizable). Ver core/planes/SISTEMA_MARCA.md.
 * Uso en cada página:
 *   <div class="shell"><main>...</main></div>
 *   <script src="shell.js"></script><script>ClausinaShell({active:'inicio'})</script>
 * Provee window.toggleMode y window.salir. El init de dark va inline en el <head>. */
(function () {
  var NAV = {
    Agencia: [
      { id: 'inicio',       label: 'Inicio',            icon: 'layout-dashboard', href: '.' },
      { id: 'maquinas',     label: 'Sala de máquinas',  icon: 'gauge',            href: 'maquinas' },
      { id: 'marcas',       label: 'Marcas',            icon: 'boxes',            href: 'marcas' },
      { id: 'pantallas',    label: 'Pantallas',         icon: 'monitor',          href: 'audiovisual' },
      { id: 'estilo',       label: 'Estilo',            icon: 'palette',          href: 'estilo' },
      { id: 'arquitectura', label: 'Arquitectura',      icon: 'git-fork',         href: 'arquitectura' },
    ],
    'Marca activa': [
      { id: 'propuestas', label: 'Propuestas',       icon: 'lightbulb',   href: 'propuestas' },
      { id: 'cola',      label: 'Cola y aprobación', icon: 'inbox',       href: 'proyecto' },
      { id: 'instagram', label: 'Instagram',         icon: 'instagram',   href: 'instagram' },
      { id: 'avisos',    label: 'Avisos',            icon: 'megaphone',   href: 'avisos' },
      { id: 'landing',   label: 'Landing',           icon: 'globe',       href: 'landing' },
      { id: 'pauta',     label: 'Pauta',             icon: 'badge-dollar-sign', href: 'pauta' },
      { id: 'biblioteca',label: 'Biblioteca',        icon: 'images',      href: 'biblioteca' },
      { id: 'perfil',    label: 'Perfil',            icon: 'settings-2',  href: 'perfil' },
    ],
  };

  function link(it, active) {
    var on = it.id === active;
    var cls = on
      ? 'on flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm transition'
      : 'flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm text-pmut dark:text-mut hover:text-pfg dark:hover:text-fg hover:bg-black/5 dark:hover:bg-white/5 transition';
    return '<a href="' + it.href + '" data-nav="' + it.id + '" class="' + cls + '"><i data-lucide="' + it.icon + '" class="w-4 h-4 shrink-0"></i><span class="nlabel">' + it.label + '</span></a>';
  }

  function nav(active) {
    var out = '';
    Object.keys(NAV).forEach(function (sec) {
      out += '<div class="nsec mono text-[10px] tracking-[0.16em] uppercase text-pmut dark:text-mut px-2.5 mb-1 mt-4 first:mt-0">' + sec + '</div>';
      out += NAV[sec].map(function (it) { return link(it, active); }).join('');
    });
    return out;
  }

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
    if(sectionOf(active)==='Marca activa'){
      if(active==='cola'){ out+=S+'<span class="'+CUR+'" id="cr-marca">marca</span>'; }
      else { out+=S+'<a class="'+L+'" href="proyecto" id="cr-marca">marca</a>'+S+'<span class="'+CUR+'">'+lab+'</span>'; }
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
          '<span class="switch-tx min-w-0"><span class="block text-sm display font-semibold truncate" id="sw-nombre">marca</span><span class="block mono text-[10px] text-pmut dark:text-mut">cambiar marca</span></span>' +
          '<i data-lucide="chevrons-up-down" class="switch-tx w-4 h-4 ml-auto text-pmut dark:text-mut shrink-0"></i>' +
        '</button>' +
        '<div id="sw-menu" class="hidden absolute left-0 right-0 top-full mt-1 z-30 rounded-xl border border-pline dark:border-line bg-side dark:bg-sideD shadow-xl p-1 max-h-72 overflow-auto"></div>' +
      '</div>' +
      '<nav class="nav flex flex-col gap-0.5">' + nav(active) + '</nav>' +
      '<div class="mt-auto flex items-center gap-1 pt-3">' +
        '<button onclick="toggleMode()" class="grid place-items-center w-9 h-9 rounded-lg border border-pline dark:border-line hover:border-acc transition shrink-0" aria-label="modo"><i data-lucide="sun-medium" class="w-4 h-4 hidden dark:block"></i><i data-lucide="moon" class="w-4 h-4 block dark:hidden"></i></button>' +
        '<button onclick="salir()" class="nlabel flex-1 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-pmut dark:text-mut hover:text-cor transition"><i data-lucide="log-out" class="w-4 h-4"></i> Salir</button>' +
      '</div>' +
    '</aside>' +
    '<div class="backdrop" onclick="document.body.classList.remove(\'navopen\')"></div>' +
    '<div class="mtop flex items-center gap-2.5 px-5 h-14 bg-side dark:bg-sideD border-b border-pline dark:border-line">' +
      '<button onclick="document.body.classList.toggle(\'navopen\')" class="grid place-items-center w-9 h-9 -ml-2 rounded-lg" aria-label="menú"><i data-lucide="menu" class="w-5 h-5"></i></button>' +
      '<a href="." class="display font-bold tracking-tight">ClaUsina<span class="acc-text">.</span></a>' +
      '<button onclick="toggleMode()" class="ml-auto grid place-items-center w-9 h-9 rounded-lg border border-pline dark:border-line" aria-label="modo"><i data-lucide="sun-medium" class="w-4 h-4 hidden dark:block"></i><i data-lucide="moon" class="w-4 h-4 block dark:hidden"></i></button>' +
    '</div>';
  }

  window.toggleMode = function () {
    var d = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('clausina-mode', d ? 'dark' : 'light'); } catch (e) {}
  };
  window.salir = async function () {
    try { await fetch('api/logout', { method: 'POST' }); } catch (e) {}
    location.href = 'login';
  };

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
        '.capguard a{display:inline-block;background:#CCF24D;color:#0c0c0a;font-weight:700;padding:9px 16px;border-radius:8px;text-decoration:none;}';
      document.head.appendChild(st);
    }
    shell.insertAdjacentHTML('afterbegin', html(opts.active || ''));
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
    if (window.lucide) lucide.createIcons();
    // poblar el selector + dropdown de marcas
    fetch('api/marcas').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var marcas = d.marcas || [];
      var a = marcas.find(function (m) { return m.slug === d.activa; });
      var ini = document.getElementById('sw-ini'), nom = document.getElementById('sw-nombre');
      if (a && ini) ini.textContent = (a.nombre || '?').trim().charAt(0).toUpperCase() || '·';
      if (a && nom) nom.textContent = a.nombre || 'marca';
      var crm = document.getElementById('cr-marca'); if (crm && a) crm.textContent = a.nombre || 'marca';
      var menu = document.getElementById('sw-menu');
      if (menu) {
        menu.innerHTML = marcas.map(function (m) {
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

  // Grisa en el menú las capacidades que la marca activa tiene deshabilitadas (siguen visibles:
  // se habilitan desde el panel del proyecto). nav id -> capacidad.
  var NAV_CAP = { instagram: 'instagram', pauta: 'pauta', avisos: 'pantalla', landing: 'web' };
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

  // Guarda: si la capacidad de esta página está deshabilitada para la marca activa, mostramos
  // el aviso para habilitarla en vez del contenido (evita páginas vacías o rotas).
  function guardarCapacidad(capId) {
    fetch('api/capacidades').then(function (r) { return r.ok ? r.json() : null; }).then(function (caps) {
      if (!caps) return;
      var c = caps.find(function (x) { return x.id === capId; });
      if (!c || c.habilitada) return;
      var main = document.querySelector('.shell main');
      if (!main) return;
      main.innerHTML = '<div class="capguard"><h2>' + esc(c.label) + ' está deshabilitada</h2>' +
        '<p>Esta marca no tiene activada esta capacidad. Podés habilitarla desde el panel del proyecto ' +
        'y completar su configuración.</p><a href="proyecto">Ir al panel del proyecto</a></div>';
    }).catch(function () {});
  }

  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  window.ClausinaSetMarca = function (slug) {
    fetch('api/marca', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: slug }) })
      .then(function () { location.reload(); })
      .catch(function () { location.reload(); });
  };
})();
