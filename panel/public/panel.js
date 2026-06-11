// Lógica compartida del panel (home / instagram / avisos).
const esc = s => (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fecha = s => { if(!s) return ''; const d=new Date(s); return d.toLocaleDateString('es-AR',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}); };
const pad4 = n => String(n).padStart(4,'0');
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
function pendCard(p){
  const t = thumbSrc(p.media);
  const thumb = t ? `<img class="thumb" loading="lazy" src="${esc(t)}" onerror="this.style.display='none'">` : '<div class="thumb"></div>';
  const copy = p.caption ? `<div class="copy">${esc(p.caption).replace(/\n/g,'<br>')}</div>` : '';
  return `<div class="card">${thumb}<div class="body">
    <div class="tt">${esc(p.titulo_interno)} <span class="intlbl" title="Nombre interno — no se publica">interno</span></div>
    <div class="meta">${cfBadge(p)}${fmtBadge(p)}${revBadge(p)}${carrBadge(p)}<span>${fecha(p.actualizado_en)}</span></div>
    ${copy}
    </div>
    <div class="acts">
      <button class="btn ok" onclick="aprobar('${p.id}',this)">Aprobar y publicar</button>
      <div class="acts-row">
        <button class="btn no" onclick="rechazar('${p.id}',this)">Rechazar</button>
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
        <button class="btn no" onclick="rechazar('${p.id}',this)">Rechazar</button>
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
    case 'rechazada':            return {l:`Rechazada · reprocesando (rev ${b.pieza_rev})`, c:'rech'};
    case 'aprobada':             return {l:'Aprobada · publicando…', c:'ok'};
    case 'borrador':             return {l:'En preparación', c:'proc'};
    case 'publicada':            return {l:'Publicada', c:'ok'};
    default:                     return {l:b.pieza_estado, c:'cola'};
  }
}
const canalBadge = b => b.canal_destino==='aviso'
  ? '<span class="badge canal aviso">aviso</span>'
  : '<span class="badge canal">instagram</span>';
function propCard(b){
  const noMat = /no requiere/i.test(b.requiere_material||'');
  return `<div class="card prop"><div class="reqbody">
    <div class="meta2"><span class="rst prop">Propuesta del creativo</span>${canalBadge(b)}</div>
    <div class="ptt">${esc(b.req_titulo||'Propuesta')}</div>
    <div class="reqtext">${esc((b.texto||'')).slice(0,300)}</div>
    ${b.requiere_material ? `<div class="needs"><b>Necesita:</b> ${esc(b.requiere_material)}</div>` : ''}
    <div class="acts">
      ${noMat
        ? `<button class="btn ok" onclick="activarReq('${b.id}',this)">Activar (sin material)</button>`
        : `<label class="btn ok filelbl">Aportar material<input type="file" accept="image/*,video/*" onchange="aportar('${b.id}',this)"></label>`}
      <div class="acts-row">
        ${noMat ? `<label class="btn no filelbl">Aportar igual<input type="file" accept="image/*,video/*" onchange="aportar('${b.id}',this)"></label>` : ''}
        <button class="btn del" onclick="descartarReq('${b.id}',this)">Descartar</button>
      </div>
    </div></div></div>`;
}
function mentionCard(b){
  const link = b.enlace ? `<a class="link" href="${esc(b.enlace)}" target="_blank" rel="noopener">Ver post en Instagram ↗</a>` : '';
  return `<div class="card men"><div class="reqbody">
    <div class="meta2"><span class="rst men">Mención entrante</span>${canalBadge(b)}</div>
    <div class="ptt">${esc(b.req_titulo||'Mención')}</div>
    <div class="reqtext">${esc((b.texto||'')).slice(0,240)}</div>
    ${link}
    <div class="acts">
      <button class="btn ok" onclick="activarReq('${b.id}',this)">Generar publicación</button>
      <div class="acts-row"><button class="btn del" onclick="descartarReq('${b.id}',this)">Descartar</button></div>
    </div></div></div>`;
}
function solicitudCard(b){
  const txt = b.brief_estado==='procesando' ? 'El creativo está elaborando propuestas…' : 'Pedido de propuestas en cola…';
  return `<div class="card prop"><div class="reqbody">
    <div class="meta2"><span class="rst proc">Creativo trabajando</span>${canalBadge(b)}</div>
    <div class="ptt">${txt}</div>
    ${b.enfasis?`<div class="reqtext">Énfasis: ${esc(b.enfasis)}</div>`:''}
  </div></div>`;
}
function reqCard(b){
  if(b.es_solicitud) return solicitudCard(b);
  if(b.origen==='mencion' && b.brief_estado==='propuesta') return mentionCard(b);
  if(b.origen==='creativo' && b.brief_estado==='propuesta') return propCard(b);
  const s = reqStatus(b);
  const thumb = (b.tiene_media && b.media_type==='photo')
      ? `<img class="reqthumb" loading="lazy" src="api/brief/${b.id}/media" onerror="this.classList.add('ph');this.removeAttribute('src')">`
      : (b.tiene_media ? `<div class="reqthumb ph">▶</div>` : '');
  const cf = b.pieza_numero ? `<span class="badge cf">CF-${pad4(b.pieza_numero)}</span>` : '';
  const kind = b.tiene_audio ? 'audio' : (b.media_type || 'texto');
  return `<div class="card"><div class="reqrow">${thumb}
    <div class="reqbody">
      <div class="meta2"><span class="rst ${s.c}">${esc(s.l)}</span>${canalBadge(b)}${cf}</div>
      <div class="meta2"><span class="badge">${esc(kind)}</span><span>${fecha(b.creado_en)}</span></div>
      <div class="reqtext">${esc((b.texto||'(sin texto)')).slice(0,200)}</div>
    </div></div></div>`;
}

/* ---------- Barra de status ---------- */
const procName={correccion:'Corrección de rechazos', ingesta_briefs:'Ingesta de requerimientos', propuestas:'Propuestas'};
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
async function rechazar(id, btn){
  if(acting) return;
  const motivo = prompt('Motivo del rechazo (se usa para corregir la pieza):');
  if(motivo===null) return;
  if(!motivo.trim()){ toast('Hace falta un motivo', true); return; }
  acting=true; busy(btn,'Rechazando…');
  try{ const d=await fetch('api/piezas/'+id+'/rechazar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({motivo})}).then(r=>r.json());
    toast(d.ok?'Rechazada — se va a corregir':'No se pudo rechazar ('+(d.error||d.status)+')', !d.ok);
  }catch(e){ toast('Error de conexión', true); }
  acting=false; setTimeout(currentLoad, 1200);
}
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
  const inp=document.getElementById('enfasis'), sel=document.getElementById('canalprop'), btn=document.getElementById('askbtn'), t=btn.textContent;
  btn.disabled=true; btn.textContent='Pidiendo…';
  try{
    const d=await fetch('api/proponer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enfasis:inp.value, canal: sel?sel.value:'instagram'})}).then(r=>r.json());
    toast(d.ok?'Pedido enviado — el creativo carga propuestas en unos minutos':'No se pudo pedir', !d.ok);
    if(d.ok) inp.value='';
  }catch(e){ toast('Error de conexión', true); }
  btn.disabled=false; btn.textContent=t;
}
async function aportar(id, input){
  const f=input.files && input.files[0]; if(!f || acting) return;
  acting=true; input.closest('.acts').querySelectorAll('button,label').forEach(x=>x.style.pointerEvents='none');
  toast('Subiendo material…');
  try{
    const dataUrl=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f);});
    const d=await fetch('api/requerimientos/'+id+'/material',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl,filename:f.name})}).then(r=>r.json());
    toast(d.ok?'Material recibido — la propuesta entra al circuito':'No se pudo subir ('+(d.error||'')+')', !d.ok);
  }catch(e){ toast('Error al subir', true); }
  acting=false; setTimeout(currentLoad, 800);
}
async function activarReq(id, btn){
  if(acting) return; if(!confirm('Se manda a generar una pieza y entra al circuito de aprobación. ¿Confirmás?')) return;
  acting=true; if(btn){btn.disabled=true; btn.textContent='Activando…';}
  try{ const d=await fetch('api/requerimientos/'+id+'/activar',{method:'POST'}).then(r=>r.json()); toast(d.ok?'Activada — entra al circuito':'No se pudo activar',!d.ok); }
  catch(e){ toast('Error de conexión', true); }
  acting=false; setTimeout(currentLoad, 800);
}
async function descartarReq(id, btn){
  if(acting) return; if(!confirm('Descartar este requerimiento. ¿Confirmás?')) return;
  acting=true; if(btn){btn.disabled=true; btn.textContent='Descartando…';}
  try{ const d=await fetch('api/requerimientos/'+id+'/descartar',{method:'POST'}).then(r=>r.json()); toast(d.ok?'Descartado':'No se pudo descartar',!d.ok); }
  catch(e){ toast('Error de conexión', true); }
  acting=false; setTimeout(currentLoad, 800);
}

/* ---------- Loaders por pantalla ---------- */
async function updateMenuCounts(){
  const mi=document.getElementById('mc-ig'), ma=document.getElementById('mc-av');
  if(!mi && !ma) return;
  try{
    const [ig,av]=await Promise.all([fetch('api/piezas?canal=instagram').then(r=>r.json()),fetch('api/piezas?canal=aviso').then(r=>r.json())]);
    const pe=a=>a.filter(p=>p.estado==='pendiente_aprobacion').length;
    if(mi) mi.textContent=pe(ig)+' pendiente(s) · '+ig.filter(p=>p.estado==='publicada').length+' publicada(s)';
    if(ma) ma.textContent=pe(av)+' pendiente(s) · '+av.filter(p=>p.estado==='publicada').length+' en pantalla';
  }catch(_){}
}
async function loadCola(){
  if(acting) return;
  try{
    const r=await fetch('api/requerimientos'); if(r.status===401){ location.href='login'; return; }
    const [reqs, status] = await Promise.all([ r.json(), fetch('api/status').then(x=>x.json()).catch(()=>[]) ]);
    fill('c-brief','n-brief', reqs.map(reqCard).join(''));
    renderStatus(status); setUpd(); updateMenuCounts();
  }catch(e){ setUpd(); }
}
async function loadInstagram(){
  if(acting) return;
  try{
    const r=await fetch('api/piezas?canal=instagram'); if(r.status===401){ location.href='login'; return; }
    const piezas=await r.json();
    fill('c-pend','n-pend', piezas.filter(p=>['pendiente_aprobacion','aprobada','borrador'].includes(p.estado)).map(pendCard).join(''));
    fill('c-pub','n-pub', piezas.filter(p=>p.estado==='publicada').map(pubCard).join(''));
    setUpd();
  }catch(e){ setUpd(); }
}
async function loadAvisos(){
  if(acting) return;
  try{
    const r=await fetch('api/piezas?canal=aviso'); if(r.status===401){ location.href='login'; return; }
    const piezas=await r.json();
    fill('c-pend','n-pend', piezas.filter(p=>['pendiente_aprobacion','aprobada','borrador'].includes(p.estado)).map(avisoPendCard).join(''));
    fill('c-pub','n-pub', piezas.filter(p=>p.estado==='publicada').map(avisoPubCard).join(''));
    setUpd();
  }catch(e){ setUpd(); }
}

/* ---------- Marca activa (multi-tenant) ---------- */
const _nm = s => (s||'').split('—')[0].trim();   // "Ardora — Distrito" -> "Ardora"
async function initMarca(){
  const header=document.querySelector('header'); if(!header) return;
  let data; try{ data=await fetch('api/marcas').then(r=>r.json()); }catch(_){ return; }
  if(!data || !data.marcas) return;
  const activa=data.activa, act=data.marcas.find(m=>m.slug===activa);
  // El logo y el título reflejan la marca activa (no "perder el contexto de marca").
  const logo=header.querySelector('.logo');
  if(logo && act){ logo.innerHTML=esc(_nm(act.nombre)).toUpperCase(); document.title=_nm(act.nombre)+' — Panel'; }
  // Selector (solo si hay más de una marca).
  if(data.marcas.length>1){
    const nav=header.querySelector('nav')||header;
    const sel=document.createElement('select');
    sel.className='marcasel'; sel.title='Marca activa';
    sel.innerHTML=data.marcas.map(m=>`<option value="${esc(m.slug)}" ${m.slug===activa?'selected':''}>${esc(_nm(m.nombre))}${m.activo?'':' (inactiva)'}</option>`).join('');
    sel.onchange=async()=>{ try{ await fetch('api/marca',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:sel.value})}); }catch(_){} location.reload(); };
    nav.insertBefore(sel, nav.firstChild);
  }
  // URL del player en la playbar de programación, con la marca activa.
  const pb=document.querySelector('.playbar b');
  if(pb && activa) pb.textContent='cortafuego.ar/panel/play'+(activa==='cortafuego'?'':('?marca='+activa));
}
initMarca();
