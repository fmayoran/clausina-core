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
      { id: 'marcas',       label: 'Marcas',            icon: 'boxes',            href: '.' },
      { id: 'pantallas',    label: 'Pantallas',         icon: 'monitor',          href: 'audiovisual' },
      { id: 'estilo',       label: 'Estilo',            icon: 'palette',          href: 'estilo' },
      { id: 'arquitectura', label: 'Arquitectura',      icon: 'git-fork',         href: 'arquitectura' },
    ],
    'Marca activa': [
      { id: 'cola',      label: 'Cola y aprobación', icon: 'inbox',       href: 'proyecto' },
      { id: 'instagram', label: 'Instagram',         icon: 'instagram',   href: 'instagram' },
      { id: 'avisos',    label: 'Avisos',            icon: 'megaphone',   href: 'avisos' },
      { id: 'landing',   label: 'Landing',           icon: 'globe',       href: 'landing' },
      { id: 'perfil',    label: 'Perfil',            icon: 'settings-2',  href: 'perfil' },
    ],
  };

  function link(it, active) {
    var on = it.id === active;
    var cls = on
      ? 'on flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm transition'
      : 'flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm text-pmut dark:text-mut hover:text-pfg dark:hover:text-fg hover:bg-black/5 dark:hover:bg-white/5 transition';
    return '<a href="' + it.href + '" class="' + cls + '"><i data-lucide="' + it.icon + '" class="w-4 h-4 shrink-0"></i><span class="nlabel">' + it.label + '</span></a>';
  }

  function nav(active) {
    var out = '';
    Object.keys(NAV).forEach(function (sec) {
      out += '<div class="nsec mono text-[10px] tracking-[0.16em] uppercase text-pmut dark:text-mut px-2.5 mb-1 mt-4 first:mt-0">' + sec + '</div>';
      out += NAV[sec].map(function (it) { return link(it, active); }).join('');
    });
    return out;
  }

  function html(active) {
    return '' +
    '<aside class="sidebar bg-side dark:bg-sideD border-r border-pline dark:border-line flex flex-col gap-1 px-3 py-4 sticky top-0 h-[100dvh] overflow-y-auto">' +
      '<div class="brandhead flex items-center gap-2.5 px-2 pb-3">' +
        '<svg viewBox="0 0 28 34" width="18" height="22" fill="none" class="shrink-0"><path id="uS" d="M5 5 V19 a9 9 0 0 0 18 0 V5" class="stroke-pfg dark:stroke-fg" stroke-width="3.4" stroke-linecap="round"/><circle r="2.2" fill="#CCF24D"><animateMotion dur="2.6s" repeatCount="indefinite" rotate="auto"><mpath href="#uS"/></animateMotion></circle></svg>' +
        '<span class="wordmark display font-bold tracking-tight">ClaUsina<span class="acc-text">.</span></span>' +
        '<button onclick="document.body.classList.toggle(\'col\')" class="ml-auto grid place-items-center w-7 h-7 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-pmut dark:text-mut" aria-label="colapsar menú"><i data-lucide="panel-left-close" class="w-4 h-4"></i></button>' +
      '</div>' +
      '<button class="switch flex items-center gap-2.5 px-2.5 py-2 rounded-xl border border-pline dark:border-line mb-3 text-left opacity-90" title="Selector de marca (próximamente)">' +
        '<span class="grid place-items-center w-6 h-6 rounded-lg bg-acc text-accink display font-bold text-xs shrink-0" id="sw-ini">·</span>' +
        '<span class="switch-tx min-w-0"><span class="block text-sm display font-semibold truncate" id="sw-nombre">marca</span><span class="block mono text-[10px] text-pmut dark:text-mut">marca activa</span></span>' +
        '<i data-lucide="chevrons-up-down" class="switch-tx w-4 h-4 ml-auto text-pmut dark:text-mut shrink-0"></i>' +
      '</button>' +
      '<nav class="nav flex flex-col gap-0.5">' + nav(active) + '</nav>' +
      '<div class="mt-auto flex items-center gap-1 pt-3">' +
        '<button onclick="toggleMode()" class="grid place-items-center w-9 h-9 rounded-lg border border-pline dark:border-line hover:border-acc transition shrink-0" aria-label="modo"><i data-lucide="sun-medium" class="w-4 h-4 hidden dark:block"></i><i data-lucide="moon" class="w-4 h-4 block dark:hidden"></i></button>' +
        '<button onclick="salir()" class="nlabel flex-1 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-pmut dark:text-mut hover:text-cor transition"><i data-lucide="log-out" class="w-4 h-4"></i> Salir</button>' +
      '</div>' +
    '</aside>' +
    '<div class="backdrop" onclick="document.body.classList.remove(\'navopen\')"></div>' +
    '<div class="mtop flex items-center gap-2.5 px-5 h-14 bg-side dark:bg-sideD border-b border-pline dark:border-line">' +
      '<button onclick="document.body.classList.toggle(\'navopen\')" class="grid place-items-center w-9 h-9 -ml-2 rounded-lg" aria-label="menú"><i data-lucide="menu" class="w-5 h-5"></i></button>' +
      '<span class="display font-bold tracking-tight">ClaUsina<span class="acc-text">.</span></span>' +
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
    shell.insertAdjacentHTML('afterbegin', html(opts.active || ''));
    // Páginas de contenido (panel.css) son dark-only: forzar dark y ocultar el toggle.
    if (opts.darkOnly) {
      document.documentElement.classList.add('dark');
      shell.querySelectorAll('[aria-label="modo"]').forEach(function (b) { b.remove(); });
    }
    // Ocultar el header/statusbar legados (las páginas viejas tenían su propio chrome).
    document.querySelectorAll('body > header').forEach(function (h) { h.style.display = 'none'; });
    var sb = document.getElementById('statusbar'); if (sb) sb.style.display = 'none';
    if (window.lucide) lucide.createIcons();
    // poblar el selector con la marca activa
    fetch('api/marcas').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var a = (d.marcas || []).find(function (m) { return m.slug === d.activa; });
      if (!a) return;
      var ini = document.getElementById('sw-ini'), nom = document.getElementById('sw-nombre');
      if (ini) ini.textContent = (a.nombre || '?').trim().charAt(0).toUpperCase() || '·';
      if (nom) nom.textContent = a.nombre || 'marca';
    }).catch(function () {});
  };
})();
