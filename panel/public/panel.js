// Lógica compartida del panel (home / instagram / avisos).
const esc = s => (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fecha = s => { if(!s) return ''; const d=new Date(s); return d.toLocaleDateString('es-AR',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}); };
const pad4 = n => String(n).padStart(4,'0');
const hace = s => { if(!s) return ''; const d=Math.max(0,(Date.now()-new Date(s).getTime())/1000|0); if(d<60) return 'recién'; const m=Math.floor(d/60); return m<60 ? 'hace '+m+'m' : 'hace '+Math.floor(m/60)+'h'; };
const nf = x => Number(x||0).toLocaleString('es-AR');
const thumbSrc = m => (m && m.url) ? ((m.tipo==='video' && m.poster_url) ? m.poster_url : m.url) : '';
const revBadge = p => p.nro>1 ? `<span class="badge rev">rev ${p.nro}</span>` : `<span class="badge">rev ${p.nro}</span>`;
const fmtBadge = p => p.formato ? `<span class="badge fmt">${esc(p.formato)}</span>` : '';
const carrBadge = p => p.n_media>1 ? `<span class="badge">carrusel ${p.n_media}</span>` : '';
const cfBadge = p => p.numero ? `<span class="badge cf">CF-${pad4(p.numero)}</span>` : '';

let acting=false;
let currentLoad=function(){};
let toastT;
function toast(msg, err){ const t=document.getElementById('toast'); if(!t)return; t.textContent=msg; t.classList.toggle('err',!!err); t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),3800); }
async function salir(){ try{ await fetch('api/logout',{method:'POST'}); }catch(_){} location.href='login'; }
function busy(btn, txt){ const a=btn.closest('.acts'); if(a) a.querySelectorAll('button,label').forEach(b=>b.disabled=true); if(txt) btn.textContent=txt; }
const _lastHtml = {};
function fill(id, n, html){
  html = html || '<div class="empty">— vacío —</div>';
  if(_lastHtml[id] === html) return;          // sin cambios: no re-renderizar (no reinicia los <video> en curso)
  _lastHtml[id] = html;
  const c=document.getElementById(id); if(!c) return;
  c.innerHTML = html;
  const nn=document.getElementById(n); if(nn) nn.textContent = (c.querySelectorAll('.card').length)||'';
}

/* ---------- Tarjetas Instagram ---------- */
// Tira de medios para revisar un carrusel completo (cada uno abre la imagen/video original).
function mediaGallery(medios){
  return `<div class="cargal">${medios.map((m,i)=>{
    const t=thumbSrc(m), full=m.url||'';
    const inner = t ? `<img loading="lazy" src="${esc(t)}" onerror="this.style.opacity=.15">` : '<span class="cgph"></span>';
    return `<a class="cgi" href="${esc(full)}" target="_blank" rel="noopener" title="Abrir ${i+1}/${medios.length}">${inner}${m.tipo==='video'?'<span class="cgv">▶</span>':''}<span class="cgn">${i+1}</span></a>`;
  }).join('')}</div>`;
}
// Tarjeta de pieza EN MODIFICACIÓN (estado rechazada): visible en la columna de pendientes
// para que el requerimiento no "desaparezca" del board mientras el agente la reprocesa.
function modCard(p, canal){
  const enProceso = !p.derivado_en;
  const t = thumbSrc(p.media);
  const medios = Array.isArray(p.medios) ? p.medios : [];
  const thumb = canal==='aviso'
    ? (p.media&&p.media.url ? `<video class="avvid" src="${esc(p.media.url)}" ${p.media.poster_url?`poster="${esc(p.media.poster_url)}"`:''} preload="none" muted loop playsinline controls></video>` : '<div class="thumb"></div>')
    : (medios.length>1 ? mediaGallery(medios) : (t ? `<img class="thumb" loading="lazy" src="${esc(t)}" onerror="this.style.display='none'">` : '<div class="thumb"></div>'));
  const motivo = p.motivo_rechazo ? `<div class="copy"><b>Pediste:</b> ${esc(p.motivo_rechazo)}</div>` : '';
  const banner = enProceso
    ? `<span class="rst proc">En modificación… ${hace(p.actualizado_en)}</span>`
    : `<span class="rst rech">Modificación no resuelta — revisá o reintentá</span>`;
  const acts = enProceso ? '' : `<div class="acts"><div class="acts-row">
      <button class="btn no" onclick="rechazar('${p.id}',this)">Modificar de nuevo</button>
      <button class="btn del" onclick="descartar('${p.id}',this)">Descartar</button>
    </div></div>`;
  return `<div class="card">${thumb}<div class="body">
    <div class="tt">${esc(p.titulo_interno)} <span class="intlbl" title="Nombre interno — no se publica">interno</span></div>
    <div class="meta">${cfBadge(p)}${fmtBadge(p)}${revBadge(p)}${carrBadge(p)}<span>${fecha(p.actualizado_en)}</span></div>
    <div class="meta2">${banner}</div>
    ${motivo}
    </div>${acts}</div>`;
}
function pendCard(p){
  if(p.estado==='rechazada') return modCard(p,'instagram');
  const t = thumbSrc(p.media);
  const medios = Array.isArray(p.medios) ? p.medios : [];
  const thumb = medios.length>1
    ? mediaGallery(medios)
    : (t ? `<img class="thumb" loading="lazy" src="${esc(t)}" onerror="this.style.display='none'">` : '<div class="thumb"></div>');
  const copy = p.caption ? `<div class="copy">${esc(p.caption).replace(/\n/g,'<br>')}</div>` : '';
  return `<div class="card">${thumb}<div class="body">
    <div class="tt">${esc(p.titulo_interno)} <span class="intlbl" title="Nombre interno — no se publica">interno</span></div>
    <div class="meta">${cfBadge(p)}${fmtBadge(p)}${revBadge(p)}${carrBadge(p)}<span>${fecha(p.actualizado_en)}</span></div>
    ${copy}
    </div>
    <div class="acts">
      <button class="btn ok" onclick="aprobar('${p.id}',this)">Aprobar y publicar</button>
      <div class="acts-row">
        <button class="btn no" onclick="rechazar('${p.id}',this)">Modificar</button>
        <button class="btn del" onclick="descartar('${p.id}',this)">Descartar</button>
      </div>
    </div></div>`;
}
function pubCard(p){
  const t = thumbSrc(p.media);
  const full = (p.media && p.media.url) || '';
  const mini = t ? `<a class="mw" href="${esc(full)}" target="_blank" rel="noopener" title="Abrir completa"><img class="mini" loading="lazy" src="${esc(t)}" onerror="this.style.display='none'"></a>` : '';
  const ig = p.ig_permalink ? `<a class="link" href="${esc(p.ig_permalink)}" target="_blank" rel="noopener">Ver en Instagram ↗</a>` : '';
  const met = (p.m_views!=null) ? `<div class="metr"><b>${nf(p.m_views)}</b> vistas · ${nf(p.m_reach)} alcance · ${nf(p.m_likes)} likes</div>` : '';
  return `<div class="card row">${mini}<div class="rbody">
    <div class="tt">${esc(p.titulo_interno)}</div>
    <div class="meta">${cfBadge(p)}${fmtBadge(p)}${revBadge(p)}<span>${fecha(p.publicado_en)}</span></div>
    ${met}${ig}</div></div>`;
}

/* ---------- Tarjetas Avisos (pantalla) ---------- */
function ctxBadges(p){
  let h = p.momento ? `<span class="badge mom">${esc(p.momento)}</span>` : '';
  for(const k of ['daypart','clima','transito']){ if(p[k] && p[k]!=='cualquiera') h+=`<span class="badge">${esc(p[k])}</span>`; }
  if(p.duracion_s) h+=`<span class="badge">${p.duracion_s}s</span>`;
  return h;
}
function avisoPendCard(p){
  if(p.estado==='rechazada') return modCard(p,'aviso');
  const m=p.media||{};
  const vid = m.url ? `<video class="avvid" src="${esc(m.url)}" ${m.poster_url?`poster="${esc(m.poster_url)}"`:''} preload="none" muted loop playsinline controls></video>` : '<div class="thumb"></div>';
  const copy = p.caption ? `<div class="copy">${esc(p.caption).replace(/\n/g,'<br>')}</div>` : '';
  return `<div class="card">${vid}<div class="body">
    <div class="tt">${esc(p.titulo_interno)} <span class="intlbl">interno</span></div>
    <div class="meta">${cfBadge(p)}${revBadge(p)}<span>${fecha(p.actualizado_en)}</span></div>
    <div class="ctx">${ctxBadges(p)}</div>
    ${copy}
    </div>
    <div class="acts">
      <button class="btn ok" onclick="aprobar('${p.id}',this)">Aprobar (a pantalla)</button>
      <div class="acts-row">
        <button class="btn no" onclick="rechazar('${p.id}',this)">Modificar</button>
        <button class="btn del" onclick="descartar('${p.id}',this)">Descartar</button>
      </div>
    </div></div>`;
}
function avisoPubCard(p){
  const m=p.media||{};
  const mini = m.poster_url ? `<img class="avmini" loading="lazy" src="${esc(m.poster_url)}">` : (m.url?`<video class="avmini" src="${esc(m.url)}" preload="none" muted></video>`:'');
  return `<div class="card row">${mini}<div class="rbody">
    <div class="tt">${esc(p.titulo_interno)}</div>
    <div class="meta">${cfBadge(p)}<span>${fecha(p.publicado_en)}</span></div>
    <div class="ctx">${ctxBadges(p)}</div>
    </div></div>`;
}

/* ---------- Requerimientos (cola) ---------- */
function reqStatus(b){
  if(!b.pieza_id){
    if(b.brief_estado==='propuesta')  return {l:'Propuesta del creativo', c:'prop'};
    if(b.brief_estado==='pendiente')  return {l:'En cola', c:'cola'};
    if(b.brief_estado==='procesando') return {l:'Procesando…', c:'proc'};
    if(b.brief_estado==='error')      return {l:'Error al procesar', c:'err'};
    return {l:b.brief_estado, c:'cola'};
  }
  switch(b.pieza_estado){
    case 'pendiente_aprobacion': return {l:'Pieza pendiente de aprobación', c:'pend'};
    case 'rechazada':            return {l:`A modificar · reprocesando (rev ${b.pieza_rev})`, c:'rech'};
    case 'aprobada':             return {l:'Aprobada · publicando…', c:'ok'};
    case 'borrador':             return {l:'En preparación', c:'proc'};
    case 'publicada':            return {l:'Publicada', c:'ok'};
    default:                     return {l:b.pieza_estado, c:'cola'};
  }
}
const canalBadge = b => b.canal_destino==='aviso'
  ? '<span class="badge canal aviso">aviso</span>'
  : '<span class="badge canal">instagram</span>';
// Compacta: una línea que abre el popup con el texto completo + material + acciones.
function propCard(b){
  const n = b.n_material||0;
  const hint = [b.requiere_material?'pide material':'', n?`${n} aportado(s)`:''].filter(Boolean).join(' · ');
  return `<div class="card prop">
    <button class="qhead" onclick="openReqModal('${b.id}')">
      <span class="rst prop">Propuesta</span>
      <span class="qtt">${esc(b.req_titulo||'Propuesta')}</span>
      ${canalBadge(b)}
      ${hint?`<span class="phint">${hint}</span>`:''}
      <span class="qchev">⤢</span>
    </button></div>`;
}
function mentionCard(b){
  return `<div class="card men">
    <button class="qhead" onclick="openReqModal('${b.id}')">
      <span class="rst men">Mención</span>
      <span class="qtt">${esc(b.req_titulo||'Mención')}</span>
      ${canalBadge(b)}
      <span class="qchev">⤢</span>
    </button></div>`;
}
function solicitudCard(b){
  const txt = b.brief_estado==='procesando' ? 'El creativo está elaborando propuestas…' : 'Pedido de propuestas en cola…';
  return `<div class="card prop"><div class="reqbody">
    <div class="meta2"><span class="rst proc">Creativo trabajando</span>${canalBadge(b)}</div>
    <div class="ptt">${txt}</div>
    ${b.enfasis?`<div class="reqtext">Énfasis: ${esc(b.enfasis)}</div>`:''}
  </div></div>`;
}
// Clasifica un brief para la sección a la que pertenece.
//   'work' = pedido en curso (creativo elaborando) · 'prop' = propuesta/mención por revisar · 'cola' = requerimiento en pipeline.
function reqClass(b){
  if(b.es_solicitud) return 'work';
  if(b.brief_estado==='propuesta' && (b.origen==='mencion' || b.origen==='creativo')) return 'prop';
  return 'cola';
}
const firstLine = (t,n=64) => { t=(t||'').trim().split('\n')[0]; return t.length>n ? t.slice(0,n).trim()+'…' : t; };

// Fila compacta de la cola: una línea (estado + título); la descripción se despliega al entrar.
const _openReq = new Set();
function toggleReq(id){ _openReq.has(id) ? _openReq.delete(id) : _openReq.add(id); renderCola(); }
function reqRow(b){
  const s = reqStatus(b);
  const open = _openReq.has(b.id);
  const cf = b.pieza_numero ? `<span class="badge cf">CF-${pad4(b.pieza_numero)}</span>` : '';
  const kind = b.tiene_audio ? 'audio' : (b.media_type || 'texto');
  const title = esc(b.req_titulo || firstLine(b.texto) || '(sin texto)');
  let det = '';
  if(open){
    const thumb = (b.tiene_media && b.media_type==='photo')
        ? `<img class="qmedia" loading="lazy" src="api/brief/${b.id}/media" onerror="this.classList.add('ph');this.removeAttribute('src')">`
        : (b.tiene_media ? `<div class="qmedia ph">▶</div>` : '');
    const needs = b.requiere_material ? `<div class="needs"><b>Necesita:</b> ${esc(b.requiere_material)}</div>` : '';
    det = `<div class="qdet">${thumb}
      <div class="reqtext">${esc(b.texto||'(sin texto)').replace(/\n/g,'<br>')}</div>
      ${needs}
      <div class="meta2"><span class="badge">${esc(kind)}</span><span>${fecha(b.creado_en)}</span>${cf}</div>
    </div>`;
  }
  return `<div class="card qcard ${open?'open':''}">
    <button class="qhead" onclick="toggleReq('${b.id}')">
      <span class="rst ${s.c}">${esc(s.l)}</span>
      <span class="qtt">${title}</span>
      ${canalBadge(b)}
      <span class="qchev">${open?'▼':'▶'}</span>
    </button>${det}</div>`;
}

/* ---------- Barra de status ---------- */
const procName={correccion:'Modificaciones', ingesta_briefs:'Ingesta de requerimientos', propuestas:'Propuestas'};
const humanSec = s => { s=Math.max(0,s|0); if(s<60) return s+'s'; const m=Math.floor(s/60); return m+'m'+(s%60?' '+(s%60)+'s':''); };
function renderStatus(rows){
  const sb=document.getElementById('statusbar');
  if(!sb) return;
  if(!rows || !rows.length){ sb.innerHTML=''; return; }
  sb.innerHTML = rows.map(r=>{
    const stale = r.hace_s > r.intervalo_s*3;
    return `<span class="it"><span class="dotp ${stale?'stale':''}"></span>${procName[r.proceso]||r.proceso}: última hace <b>${humanSec(r.hace_s)}</b> · próxima ~<b>${humanSec(r.proxima_s)}</b></span>`;
  }).join('');
}
function setUpd(){ const u=document.getElementById('upd'); if(u) u.textContent='actualizado '+new Date().toLocaleTimeString('es-AR'); }

/* ---------- Acciones sobre piezas (canal-neutrales; el backend ramifica) ---------- */
async function aprobar(id, btn){
  if(acting) return;
  if(!confirm('Aprobar y publicar esta pieza. ¿Confirmás?')) return;
  acting=true; busy(btn,'Publicando…');
  try{ const d=await fetch('api/piezas/'+id+'/aprobar',{method:'POST'}).then(r=>r.json());
    toast(d.ok?'Aprobada — publicando':'No se pudo aprobar ('+(d.error||d.status)+')', !d.ok);
  }catch(e){ toast('Error de conexión', true); }
  acting=false; setTimeout(currentLoad, 1500);
}
// Rechazo con material: abre un modal con el motivo + galería opcional de imágenes/videos a aportar.
// El material se sube a la pieza (mientras está pendiente) y la rutina de corrección lo usa al reprocesar.
function rechazar(id, btn){ if(acting) return; openRejectModal(id); }
async function descartar(id, btn){
  if(acting) return;
  if(!confirm('Descartar la pieza definitivamente. No se publica ni se corrige. ¿Confirmás?')) return;
  acting=true; busy(btn,'Descartando…');
  try{ const d=await fetch('api/piezas/'+id+'/descartar',{method:'POST'}).then(r=>r.json());
    toast(d.ok?'Descartada':'No se pudo descartar ('+(d.error||d.status)+')', !d.ok);
  }catch(e){ toast('Error de conexión', true); }
  acting=false; setTimeout(currentLoad, 1000);
}

/* ---------- Acciones sobre requerimientos (cola) ---------- */
async function pedirPropuestas(){
  const inp=document.getElementById('enfasis'), sel=document.getElementById('canalprop'), cant=document.getElementById('cantprop'), btn=document.getElementById('askbtn'), t=btn.textContent;
  const cantidad=Math.min(8,Math.max(1,parseInt(cant&&cant.value,10)||5));
  btn.disabled=true; btn.textContent='Pidiendo…';
  try{
    const d=await fetch('api/proponer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enfasis:inp.value, canal: sel?sel.value:'instagram', cantidad})}).then(r=>r.json());
    toast(d.ok?`Pedido enviado (${cantidad}) — el creativo carga propuestas en unos minutos`:'No se pudo pedir', !d.ok);
    if(d.ok) inp.value='';
  }catch(e){ toast('Error de conexión', true); }
  btn.disabled=false; btn.textContent=t;
}
async function descartarReq(id, btn){
  if(acting) return; if(!confirm('Descartar este requerimiento. ¿Confirmás?')) return;
  acting=true; if(btn){btn.disabled=true; btn.textContent='Descartando…';}
  try{ const d=await fetch('api/requerimientos/'+id+'/descartar',{method:'POST'}).then(r=>r.json()); toast(d.ok?'Descartado':'No se pudo descartar',!d.ok); }
  catch(e){ toast('Error de conexión', true); }
  acting=false; setTimeout(currentLoad, 800);
}
// Descartar desde el popup de propuesta/mención.
async function descartarDesdeModal(){
  if(!modalId||acting) return;
  if(!confirm('Descartar este requerimiento. No se genera nada. ¿Confirmás?')) return;
  const id=modalId, btn=document.getElementById('rm-desc'), t=btn?btn.textContent:'';
  acting=true; if(btn){btn.disabled=true; btn.textContent='Descartando…';}
  try{
    const d=await fetch('api/requerimientos/'+id+'/descartar',{method:'POST'}).then(r=>r.json());
    if(d.ok){ toast('Descartado'); modalId=null; document.getElementById('reqmodal').classList.add('hidden'); }
    else toast('No se pudo descartar', true);
  }catch(e){ toast('Error de conexión', true); }
  if(btn){btn.disabled=false; btn.textContent=t;} acting=false; setTimeout(currentLoad, 500);
}

/* ---------- Ventana de interacción con el creativo (preview + comentarios + generar) ---------- */
let _reqs={};        // briefs de la última carga, por id (para abrir el modal sin re-fetch)
let modalId=null;    // requerimiento abierto en el modal
function openReqModal(id){
  const b=_reqs[id]; if(!b) return;
  modalId=id;
  document.getElementById('rm-tt').textContent=b.req_titulo||'Propuesta';
  document.getElementById('rm-concepto').innerHTML=esc(b.texto||'').replace(/\n/g,'<br>');
  const link=document.getElementById('rm-link');
  if(link){
    if(b.enlace){ link.innerHTML=`<a class="link" href="${esc(b.enlace)}" target="_blank" rel="noopener">Ver post en Instagram ↗</a>`; link.style.display=''; }
    else link.style.display='none';
  }
  const needs=document.getElementById('rm-needs');
  if(b.requiere_material){ needs.innerHTML=`<b>Necesita:</b> ${esc(b.requiere_material)}`; needs.style.display=''; }
  else needs.style.display='none';
  document.getElementById('rm-coment').value=b.comentarios||'';
  document.getElementById('reqmodal').classList.remove('hidden');
  loadMateriales();
}
function closeReqModal(){ if(acting) return; modalId=null; document.getElementById('reqmodal').classList.add('hidden'); setTimeout(currentLoad,150); }
function matTile(m){
  const inner = m.media_type==='photo'
    ? `<img src="api/material/${m.id}/media" loading="lazy" onerror="this.style.opacity=.2">`
    : `<div class="vidtile">▶<span>${esc(m.filename||'video')}</span></div>`;
  return `<div class="tile">${inner}<button class="tile-x" title="Quitar" onclick="rmDelMaterial('${m.id}')">×</button></div>`;
}
async function loadMateriales(){
  if(!modalId) return;
  const g=document.getElementById('rm-gallery');
  try{
    const mats=await fetch('api/requerimientos/'+modalId+'/materiales').then(r=>r.json());
    g.innerHTML = (mats&&mats.length) ? mats.map(matTile).join('') : '<div class="empty">— sin material aún —</div>';
  }catch(e){}
}
async function rmAddFiles(input){
  const files=[...(input.files||[])]; if(!files.length||acting||!modalId) return;
  const lbl=input.closest('label'), txt=lbl.querySelector('.flbl'), base=txt.textContent;
  acting=true; lbl.style.pointerEvents='none';
  let okc=0;
  for(let i=0;i<files.length;i++){
    txt.textContent='Subiendo '+(i+1)+'/'+files.length+'…';
    try{
      const dataUrl=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(files[i]);});
      const d=await fetch('api/requerimientos/'+modalId+'/material',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl,filename:files[i].name})}).then(r=>r.json());
      if(d.ok) okc++;
    }catch(e){}
  }
  input.value=''; txt.textContent=base; lbl.style.pointerEvents=''; acting=false;
  toast(okc?okc+' material(es) agregado(s)':'No se pudo subir', !okc);
  loadMateriales();
}
async function rmDelMaterial(mid){
  if(acting||!modalId) return; acting=true;
  try{ await fetch('api/requerimientos/'+modalId+'/material/'+mid,{method:'DELETE'}); }catch(e){}
  acting=false; loadMateriales();
}
async function generarPublicacion(){
  if(!modalId||acting) return;
  if(!confirm('Generar la publicación: se manda a crear la pieza y entra al circuito de aprobación. ¿Confirmás?')) return;
  const coment=document.getElementById('rm-coment').value, btn=document.getElementById('rm-gen');
  acting=true; btn.disabled=true; btn.textContent='Generando…';
  try{
    const d=await fetch('api/requerimientos/'+modalId+'/generar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({comentarios:coment})}).then(r=>r.json());
    if(d.ok){ toast('Generando — entra al circuito de aprobación'); modalId=null; document.getElementById('reqmodal').classList.add('hidden'); }
    else toast('No se pudo generar', true);
  }catch(e){ toast('Error de conexión', true); }
  btn.disabled=false; btn.textContent='Generar publicación'; acting=false; setTimeout(currentLoad,500);
}

/* ---------- Loaders por pantalla ---------- */
// Estado del resumen (dashboard), alimentado desde loadCola (cola/prop/work) y updateMenuCounts (aprob/pub).
const _stats={cola:0,prop:0,work:0,aprob:0,pub:0};
function setStat(id, val){ const e=document.getElementById(id); if(e) e.textContent=val; }
function paintResumen(){
  setStat('st-cola', _stats.cola);
  setStat('st-prop', _stats.prop);
  setStat('st-aprob', _stats.aprob);
  setStat('st-pub', _stats.pub);
  const px=document.getElementById('st-prop-x');
  if(px) px.textContent = _stats.work ? `${_stats.work} en elaboración` : 'del creativo, por revisar';
  const ta=document.querySelector('.statile.c-aprob'); if(ta) ta.classList.toggle('alert', _stats.aprob>0);
  const tp=document.querySelector('.statile.c-prop'); if(tp) tp.classList.toggle('alert', _stats.prop>0);
}
async function updateMenuCounts(){
  const mi=document.getElementById('mc-ig'), ma=document.getElementById('mc-av'), mw=document.getElementById('mc-web');
  if(!mi && !ma && !mw && !document.getElementById('resumen')) return;
  try{
    const tasks=[fetch('api/piezas?canal=instagram').then(r=>r.json()),fetch('api/piezas?canal=aviso').then(r=>r.json())];
    if(mw) tasks.push(fetch('api/landing').then(r=>r.json()).catch(()=>[]));
    const [ig,av,land]=await Promise.all(tasks);
    const pe=a=>a.filter(p=>p.estado==='pendiente_aprobacion').length;
    const pu=a=>a.filter(p=>p.estado==='publicada').length;
    _stats.aprob=pe(ig)+pe(av); _stats.pub=pu(ig)+pu(av); paintResumen();
    if(mi) mi.textContent=pe(ig)+' pendiente(s) · '+pu(ig)+' publicada(s)';
    if(ma) ma.textContent=pe(av)+' pendiente(s) · '+pu(av)+' en pantalla';
    if(mw){
      const L=land||[];
      const borr=L.filter(c=>c.estado==='borrador').length;
      const gen=L.filter(c=>c.estado==='pendiente'||c.estado==='procesando').length;
      const prod=L.some(c=>c.estado==='en_produccion');
      let t, alert=false;
      if(borr){ t=borr+' borrador(es) por aprobar'; alert=true; }
      else if(gen){ t='generando borrador…'; }
      else if(prod){ t='En producción'; }
      else { t='—'; }
      mw.textContent=t;
      mw.classList.toggle('alert', alert);
    }
  }catch(_){}
}
let _reqList=[];
// Render de las dos secciones operativas a partir del cache (sin re-fetch). Lo llama loadCola y el acordeón.
function renderCola(){
  const work=_reqList.filter(b=>reqClass(b)==='work');
  const prop=_reqList.filter(b=>reqClass(b)==='prop');
  const cola=_reqList.filter(b=>reqClass(b)==='cola');
  // Propuestas: primero los pedidos en curso (estado), después las propuestas/menciones accionables.
  const propHtml = work.map(solicitudCard).join('')
    + prop.map(b => b.origen==='mencion' ? mentionCard(b) : propCard(b)).join('');
  fill('c-prop','n-prop', propHtml);
  fill('c-cola','n-cola', cola.map(reqRow).join(''));
  _stats.cola=cola.length; _stats.prop=prop.length; _stats.work=work.length; paintResumen();
}
async function loadCola(){
  if(acting) return;
  try{
    const r=await fetch('api/requerimientos'); if(r.status===401){ location.href='login'; return; }
    const [reqs, status] = await Promise.all([ r.json(), fetch('api/status').then(x=>x.json()).catch(()=>[]) ]);
    _reqs={}; reqs.forEach(b=>{ if(b.id) _reqs[b.id]=b; });
    _reqList=reqs;
    // Limpia del set de "abiertos" los que ya no están en la cola.
    for(const id of [..._openReq]) if(!_reqs[id]) _openReq.delete(id);
    renderCola();
    renderStatus(status); setUpd(); updateMenuCounts();
  }catch(e){ setUpd(); }
}
async function loadInstagram(){
  if(acting) return;
  try{
    const r=await fetch('api/piezas?canal=instagram'); if(r.status===401){ location.href='login'; return; }
    const piezas=await r.json();
    fill('c-pend','n-pend', piezas.filter(p=>['pendiente_aprobacion','aprobada','borrador'].includes(p.estado) || (p.estado==='rechazada' && !p.derivado_en)).map(pendCard).join(''));
    fill('c-pub','n-pub', piezas.filter(p=>p.estado==='publicada').map(pubCard).join(''));
    setUpd();
  }catch(e){ setUpd(); }
}
async function loadAvisos(){
  if(acting) return;
  try{
    const r=await fetch('api/piezas?canal=aviso'); if(r.status===401){ location.href='login'; return; }
    const piezas=await r.json();
    fill('c-pend','n-pend', piezas.filter(p=>['pendiente_aprobacion','aprobada','borrador'].includes(p.estado) || (p.estado==='rechazada' && !p.derivado_en)).map(avisoPendCard).join(''));
    fill('c-pub','n-pub', piezas.filter(p=>p.estado==='publicada').map(avisoPubCard).join(''));
    setUpd();
  }catch(e){ setUpd(); }
}

/* ---------- Modal de modificación (motivo + material opcional) ---------- */
// Disponible en cualquier página (Instagram/Avisos): se inyecta en el DOM la primera vez.
let rejectId=null;
function ensureRejectModal(){
  if(document.getElementById('rejmodal')) return;
  const d=document.createElement('div');
  d.id='rejmodal'; d.className='modal hidden';
  d.innerHTML=`
    <div class="modal-bg" onclick="closeRejectModal()"></div>
    <div class="modal-box">
      <div class="modal-head">
        <div class="modal-tt">Modificar pieza</div>
        <button class="modal-x" onclick="closeRejectModal()" title="Cerrar">×</button>
      </div>
      <div class="modal-body">
        <div class="modal-sec">
          <div class="modal-lbl">Qué modificar (se usa para corregir)</div>
          <textarea id="rj-motivo" maxlength="500" placeholder="Qué corregir: copy, recorte, el texto tapa la comida, otro encuadre, sumá las fotos nuevas…"></textarea>
        </div>
        <div class="modal-sec">
          <div class="modal-lbl">Material para la corrección (opcional)</div>
          <div class="gallery" id="rj-gallery"></div>
          <label class="btn ok filelbl mt8"><span class="flbl">+ Agregar imágenes / videos</span><input type="file" accept="image/*,video/*" multiple onchange="rjAddFiles(this)"></label>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn no" id="rj-go" onclick="confirmRechazo()">Modificar</button>
        <button class="btn no" onclick="closeRejectModal()">Cancelar</button>
      </div>
    </div>`;
  document.body.appendChild(d);
}
function openRejectModal(id){
  ensureRejectModal();
  rejectId=id;
  document.getElementById('rj-motivo').value='';
  document.getElementById('rejmodal').classList.remove('hidden');
  loadRejMateriales();
}
function closeRejectModal(){ if(acting) return; rejectId=null; document.getElementById('rejmodal').classList.add('hidden'); }
async function loadRejMateriales(){
  if(!rejectId) return;
  const g=document.getElementById('rj-gallery');
  try{
    const mats=await fetch('api/piezas/'+rejectId+'/materiales').then(r=>r.json());
    g.innerHTML = (mats&&mats.length) ? mats.map(rejTile).join('') : '<div class="empty">— sin material extra —</div>';
  }catch(e){}
}
function rejTile(m){
  const inner = m.media_type==='photo'
    ? `<img src="api/material/${m.id}/media" loading="lazy" onerror="this.style.opacity=.2">`
    : `<div class="vidtile">▶<span>${esc(m.filename||'video')}</span></div>`;
  return `<div class="tile">${inner}<button class="tile-x" title="Quitar" onclick="rjDelMaterial('${m.id}')">×</button></div>`;
}
async function rjAddFiles(input){
  const files=[...(input.files||[])]; if(!files.length||acting||!rejectId) return;
  const lbl=input.closest('label'), txt=lbl.querySelector('.flbl'), base=txt.textContent;
  acting=true; lbl.style.pointerEvents='none';
  let okc=0;
  for(let i=0;i<files.length;i++){
    txt.textContent='Subiendo '+(i+1)+'/'+files.length+'…';
    try{
      const dataUrl=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(files[i]);});
      const d=await fetch('api/piezas/'+rejectId+'/material',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl,filename:files[i].name})}).then(r=>r.json());
      if(d.ok) okc++;
    }catch(e){}
  }
  input.value=''; txt.textContent=base; lbl.style.pointerEvents=''; acting=false;
  toast(okc?okc+' material(es) agregado(s)':'No se pudo subir', !okc);
  loadRejMateriales();
}
async function rjDelMaterial(mid){
  if(acting||!rejectId) return; acting=true;
  try{ await fetch('api/piezas/'+rejectId+'/material/'+mid,{method:'DELETE'}); }catch(e){}
  acting=false; loadRejMateriales();
}
async function confirmRechazo(){
  if(!rejectId||acting) return;
  const motivo=document.getElementById('rj-motivo').value.trim();
  if(!motivo){ toast('Hace falta un motivo', true); return; }
  const id=rejectId, btn=document.getElementById('rj-go');
  acting=true; btn.disabled=true; btn.textContent='Modificando…';
  try{
    const d=await fetch('api/piezas/'+id+'/rechazar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({motivo})}).then(r=>r.json());
    if(d.ok){ toast('Modificación enviada — se va a corregir'); rejectId=null; document.getElementById('rejmodal').classList.add('hidden'); }
    else toast('No se pudo enviar la modificación ('+(d.error||d.status)+')', true);
  }catch(e){ toast('Error de conexión', true); }
  btn.disabled=false; btn.textContent='Modificar'; acting=false; setTimeout(currentLoad, 1200);
}

/* ---------- Marca activa (multi-tenant) ---------- */
const _nm = s => (s||'').split('—')[0].trim();   // "Ardora — Distrito" -> "Ardora"
async function initMarca(){
  const header=document.querySelector('header'); if(!header) return;
  if(document.body.classList.contains('av')||document.body.classList.contains('dash')) return;   // Audiovisual o dashboard de agencia: vistas cross-marca, sin selector
  let data; try{ data=await fetch('api/marcas').then(r=>r.json()); }catch(_){ return; }
  if(!data || !data.marcas) return;
  const activa=data.activa, act=data.marcas.find(m=>m.slug===activa);
  // El logo y el título reflejan la marca activa (no "perder el contexto de marca").
  const logo=header.querySelector('.logo');
  if(logo && act){
    const nm=_nm(act.nombre), isUrl=act.logo && /^https?:\/\//.test(act.logo);
    logo.innerHTML=(isUrl?`<img class="hdrlogo" src="${esc(act.logo)}" alt="" onerror="this.remove()">`:'')+esc(nm).toUpperCase();
    document.title=nm+' — Panel';
  }
  // El cambio de proyecto se hace desde el dashboard de la Agencia (no hay selector en las páginas).
}
initMarca();
