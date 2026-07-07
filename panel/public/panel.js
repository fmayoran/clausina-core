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
function busy(btn, txt){ if(!btn) return; const a=btn.closest('.acts'); if(a) a.querySelectorAll('button,label').forEach(b=>b.disabled=true); if(txt) btn.textContent=txt; }
const _lastHtml = {};
function fill(id, n, html){
  html = html || '<div class="empty">— vacío —</div>';
  if(_lastHtml[id] === html) return;          // sin cambios: no re-renderizar (no reinicia los <video> en curso)
  _lastHtml[id] = html;
  const c=document.getElementById(id); if(!c) return;
  c.innerHTML = html;
  const nn=document.getElementById(n); if(nn) nn.textContent = (c.querySelectorAll('.card').length)||'';
}

/* ---------- Bitácora de generación ("cómo se generó") ---------- */
// Render markdown-lite (## títulos, - bullets, **negrita**) con estilos inline (páginas dark-only).
function mdLite(s){
  const lines = String(s||'').split('\n'); let html=''; let inList=false;
  const bold = t => esc(t).replace(/\*\*(.+?)\*\*/g,'<b style="color:#ECEEF0">$1</b>');
  const close = () => { if(inList){ html+='</ul>'; inList=false; } };
  for(let raw of lines){
    const ln = raw.trim();
    if(!ln){ close(); continue; }
    if(/^#{1,4}\s+/.test(ln)){ close(); html+=`<div style="font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#CCF24D;margin:16px 0 6px">${bold(ln.replace(/^#{1,4}\s+/,''))}</div>`; }
    else if(/^[-*]\s+/.test(ln)){ if(!inList){ html+='<ul style="margin:0 0 6px;padding-left:18px;list-style:disc">'; inList=true; } html+=`<li style="font-size:13.5px;line-height:1.5;margin-bottom:4px;color:#cfd3d8">${bold(ln.replace(/^[-*]\s+/,''))}</li>`; }
    else { close(); html+=`<p style="margin:0 0 8px;font-size:13.5px;line-height:1.55;color:#cfd3d8">${bold(ln)}</p>`; }
  }
  close(); return html || '<p style="color:#8A8F98">Sin contenido.</p>';
}
function cerrarBitacora(){ const o=document.getElementById('bit-ov'); if(o) o.remove(); }
async function verBitacora(piezaId){
  let d=null;
  try{ const r=await fetch('api/piezas/'+piezaId+'/bitacora'); if(r.ok) d=await r.json(); }catch(e){}
  cerrarBitacora();
  const ov=document.createElement('div'); ov.id='bit-ov';
  ov.style.cssText='position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.62)';
  ov.onclick=e=>{ if(e.target===ov) cerrarBitacora(); };
  const cont = (d && d.bitacora) ? mdLite(d.bitacora) : '<p style="color:#8A8F98;font-size:13.5px">No se registró bitácora para esta generación (piezas anteriores a esta función).</p>';
  const tt = d ? esc(d.titulo_interno||'Pieza') : 'Pieza';
  ov.innerHTML = `<div style="max-width:640px;width:100%;max-height:82vh;overflow:auto;background:#111317;border:1px solid #20242B;border-radius:16px;padding:20px 24px;color:#ECEEF0;font-family:Inter,system-ui,sans-serif">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8A8F98">Cómo se generó</span>
      <button onclick="cerrarBitacora()" style="margin-left:auto;background:none;border:0;color:#8A8F98;font-size:22px;cursor:pointer;line-height:1">×</button>
    </div>
    <div style="font-family:'Inter Tight',sans-serif;font-weight:700;font-size:16px;margin-bottom:12px">${tt}</div>
    <div>${cont}</div>
  </div>`;
  document.body.appendChild(ov);
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
  const m = p.media || {};
  const thumb = medios.length>1
    ? mediaGallery(medios)
    : (m.tipo==='video' && m.url)
      ? `<video class="thumb" style="aspect-ratio:9/16;height:auto;max-height:70vh;object-fit:contain;background:#000" src="${esc(m.url)}" ${m.poster_url?`poster="${esc(m.poster_url)}"`:''} preload="metadata" playsinline muted loop controls></video>`
      : (t ? `<img class="thumb" loading="lazy" src="${esc(t)}" onerror="this.style.display='none'">` : '<div class="thumb"></div>');
  const copy = p.caption ? `<div class="copy">${esc(p.caption).replace(/\n/g,'<br>')}</div>` : '';
  return `<div class="card">${thumb}<div class="body">
    <div class="tt">${esc(p.titulo_interno)} <span class="intlbl" title="Nombre interno — no se publica">interno</span></div>
    <div class="meta">${cfBadge(p)}${fmtBadge(p)}${revBadge(p)}${carrBadge(p)}<span>${fecha(p.actualizado_en)}</span></div>
    ${copy}
    ${p.tiene_bitacora ? `<button class="bitlink" onclick="verBitacora('${p.id}')">↳ cómo se generó</button>` : ''}
    </div>
    <div class="acts">
      <button class="btn ok" onclick='aprobarIG("${p.id}", ${JSON.stringify(p.colaboradores||[])})'>Aprobar y publicar</button>
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
  const collab = (p.colaboradores && p.colaboradores.length) ? `<span class="badge collab" title="Colaboración (Collab)">Collab: ${p.colaboradores.map(h=>'@'+esc(h)).join(', ')}</span>` : '';
  return `<div class="card row">${mini}<div class="rbody">
    <div class="tt">${esc(p.titulo_interno)}</div>
    <div class="meta">${cfBadge(p)}${fmtBadge(p)}${revBadge(p)}${collab}<span>${fecha(p.publicado_en)}</span></div>
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
    ${p.tiene_bitacora ? `<button class="bitlink" onclick="verBitacora('${p.id}')">↳ cómo se generó</button>` : ''}
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
  if(b.brief_estado==='revisar' || b.brief_estado==='revisando') return 'work';   // propuesta que el creativo está reescribiendo
  if(!b.pieza_id && (b.brief_estado==='pendiente' || b.brief_estado==='procesando')) return 'work';  // el creativo está armando la pieza
  if(b.brief_estado==='propuesta' && (b.origen==='mencion' || b.origen==='creativo')) return 'prop';
  return 'cola';
}
// Propuesta en proceso de reescritura (loop "pedir nueva versión"): visible mientras el creativo la ajusta.
function revisandoCard(b){
  return `<div class="card prop"><div class="reqbody">
    <div class="meta2"><span class="rst proc">Preparando nueva versión…</span>${canalBadge(b)}</div>
    <div class="ptt">${esc(b.req_titulo||'Propuesta')}</div>
    <div class="reqtext">El creativo está ajustando el concepto con tus comentarios.</div>
  </div></div>`;
}
// Pieza generándose tras "Generar publicación": visible hasta que aparece en Cola y aprobación.
function generandoCard(b){
  return `<div class="card prop"><div class="reqbody">
    <div class="meta2"><span class="rst proc">Generando la pieza…</span>${canalBadge(b)}</div>
    <div class="ptt">${esc(b.req_titulo||'Propuesta')}</div>
    <div class="reqtext">El creativo está armando la publicación. Cuando esté lista aparece en Cola y aprobación para tu visto.</div>
  </div></div>`;
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
const procName={correccion:'Modificaciones', ingesta_briefs:'Ingesta', propuestas:'Propuestas'};
const humanSec = s => { s=Math.max(0,s|0); if(s<60) return s+'s'; const m=Math.floor(s/60); if(m<60) return m+'m'; const h=Math.floor(m/60); return h<24 ? h+'h' : Math.floor(h/24)+'d'; };
const _dot = c => `<span class="dotp" style="background:${c}"></span>`;
// Barra de control de workers (salud de la plataforma de un vistazo). Datos de batch_runs (/api/status).
// Verde = activo/procesando · gris = en espera (ok) · rojo = problema. Tooltips (title) explican cada estado.
const ST_GREEN='#30a46c', ST_GREY='#8a8a8a', ST_RED='#e5484d';
function renderStatus(rows){
  const sb=document.getElementById('statusbar'); if(!sb) return;
  const by={}; (rows||[]).forEach(r=>by[r.proceso]=r);
  const parts=[];
  // 1) Dispatcher (orquestador): revisa la base cada ~1 min y encola el trabajo.
  const d=by.dispatcher, dDown=!d || d.hace_s>90;
  const dTip='Orquestador: revisa la base cada ~1 min y encola el trabajo pendiente (corrección, propuestas, briefs, landings). Verde = activo · Rojo = dejó de chequear (revisar cf-dispatcher.timer).';
  parts.push(`<span class="it" title="${dTip}">${_dot(dDown?ST_RED:ST_GREEN)}Dispatcher: <b>${dDown?'sin señal':'activo · hace '+humanSec(d.hace_s)}</b></span>`);
  // 2) Workers: ejecutan las tareas. Verde procesando · gris en espera · rojo caído.
  const w=by.worker, wDown=!w || w.hace_s>30, proc=w&&(w.last_msg||'').startsWith('procesando');
  const ult=['correccion','propuestas','ingesta_briefs'].filter(k=>by[k]).map(k=>`${procName[k]}: hace ${humanSec(by[k].hace_s)}`).join(' · ')||'sin datos';
  const wTip=`Ejecutan las tareas sobre la suscripción de Claude. Verde = procesando ahora · Gris = en espera (libre, ok) · Rojo = caído (revisar cf-worker). Última actividad — ${ult}.`;
  const wColor=wDown?ST_RED:(proc?ST_GREEN:ST_GREY);
  const wTxt=wDown?'sin señal':(proc?esc(w.last_msg):'en espera');
  parts.push(`<span class="it" title="${wTip}">${_dot(wColor)}Workers (1): <b>${wTxt}</b></span>`);
  sb.innerHTML = parts.join('');
}
function setUpd(){ const u=document.getElementById('upd'); if(u) u.textContent='actualizado '+new Date().toLocaleTimeString('es-AR'); }

/* ---------- Acciones sobre piezas (canal-neutrales; el backend ramifica) ---------- */
async function aprobar(id, btn, colaboradores){
  if(acting) return;
  const conColab = Array.isArray(colaboradores);   // IG: viene del modal de collabs (ya es la confirmación)
  if(!conColab && !confirm('Aprobar y publicar esta pieza. ¿Confirmás?')) return;
  acting=true; busy(btn,'Publicando…');
  try{ const opt = conColab ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({colaboradores})} : {method:'POST'};
    const d=await fetch('api/piezas/'+id+'/aprobar',opt).then(r=>r.json());
    toast(d.ok?'Aprobada — publicando':'No se pudo aprobar ('+(d.error||d.status)+')', !d.ok);
  }catch(e){ toast('Error de conexión', true); }
  acting=false; setTimeout(currentLoad, 1500);
}
// Aprobar una pieza de IG: primero elegir/editar los colaboradores (Collab).
let _colId=null, _colList=[];
function aprobarIG(id, colabs){
  if(acting) return;
  _colId=id; _colList=(Array.isArray(colabs)?colabs:[]).slice();
  renderColab(); document.getElementById('colab-ov').style.display='flex';
}
function renderColab(){
  let ov=document.getElementById('colab-ov');
  if(!ov){ ov=document.createElement('div'); ov.id='colab-ov'; ov.className='colabov'; document.body.appendChild(ov); ov.addEventListener('click',e=>{ if(e.target===ov) cerrarColab(); }); }
  const chips=_colList.length ? _colList.map((h,i)=>`<span class="colchip">@${esc(h)}<button title="Quitar" onclick="quitarColab(${i})">×</button></span>`).join('')
                              : '<span class="colnone">sin colaboradores — se publica sin Collab</span>';
  ov.innerHTML=`<div class="colabbox">
    <div class="colabhead"><b>Colaboradores del post</b><button class="colx" onclick="cerrarColab()" title="Cerrar">×</button></div>
    <p class="colabhint">Se invita a estas cuentas a Collab (aparece también en su feed si aceptan). Sacá o agregá las que quieras.</p>
    <div class="colchips">${chips}</div>
    <div class="coladd"><input id="colab-in" placeholder="agregar cuenta (ej. ardora.ar)" onkeydown="if(event.key==='Enter'){event.preventDefault();agregarColab();}"><button onclick="agregarColab()">+</button></div>
    <div class="colabfoot"><button class="btn ok" onclick="confirmarAprobIG()">Aprobar y publicar</button><button class="btn no" onclick="cerrarColab()">Cancelar</button></div>
  </div>`;
}
function quitarColab(i){ _colList.splice(i,1); renderColab(); }
function agregarColab(){ const el=document.getElementById('colab-in'); const v=(el.value||'').trim().replace(/^@+/,'').toLowerCase(); if(v && !_colList.includes(v)) _colList.push(v); el.value=''; renderColab(); document.getElementById('colab-in').focus(); }
function cerrarColab(){ const o=document.getElementById('colab-ov'); if(o) o.style.display='none'; _colId=null; }
async function confirmarAprobIG(){ const id=_colId, colabs=_colList.slice(); cerrarColab(); await aprobar(id, null, colabs); }
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
    if(d.ok){ inp.value=''; if(typeof window.afterProponer==='function') window.afterProponer(); }
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
const MAT_MAX=85*1024*1024;   // tope por archivo (media store en disco; margen para el base64 del body)
async function rmAddFiles(input){
  const files=[...(input.files||[])]; if(!files.length||acting||!modalId) return;
  const lbl=input.closest('label'), txt=lbl.querySelector('.flbl'), base=txt.textContent;
  acting=true; lbl.style.pointerEvents='none';
  let okc=0, pesados=0, fallos=0;
  for(let i=0;i<files.length;i++){
    if(files[i].size>MAT_MAX){ pesados++; continue; }
    txt.textContent='Subiendo '+(i+1)+'/'+files.length+'…';
    try{
      const dataUrl=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(files[i]);});
      const rp=await fetch('api/requerimientos/'+modalId+'/material',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl,filename:files[i].name})});
      const d=await rp.json().catch(()=>({ok:false}));
      if(d.ok){ okc++; await loadMateriales(); }        // refresco en vivo: se ve cada archivo apenas sube
      else { fallos++; if(rp.status===413) pesados++; }
    }catch(e){ fallos++; }
  }
  input.value=''; txt.textContent=base; lbl.style.pointerEvents=''; acting=false;
  let msg = okc ? okc+' material(es) agregado(s)' : 'No se pudo subir el material';
  if(pesados) msg += ` · ${pesados} muy pesado(s) (máx ~85MB)`;
  else if(!okc && fallos) msg += ' (probá de nuevo)';
  toast(msg, !okc);
  loadMateriales();
}
async function rmDelMaterial(mid){
  if(acting||!modalId) return; acting=true;
  try{ await fetch('api/requerimientos/'+modalId+'/material/'+mid,{method:'DELETE'}); }catch(e){}
  acting=false; loadMateriales();
}
// --- Elegir material desde la biblioteca (taller) para una propuesta ---
let _pickItems=[];
async function abrirPickerBiblio(){
  if(!modalId) return;
  let data; try{ data=await fetch('api/biblioteca').then(r=>r.json()); }catch(e){ toast('No se pudo abrir la biblioteca',true); return; }
  _pickItems=(data.items||[]).filter(i=>i.carpeta==='En proceso'||i.carpeta==='Terminado');
  let ov=document.getElementById('bp-ov');
  if(!ov){ ov=document.createElement('div'); ov.id='bp-ov'; ov.className='bpov'; document.body.appendChild(ov); ov.addEventListener('click',e=>{ if(e.target===ov) cerrarPicker(); }); }
  const cells=_pickItems.length ? _pickItems.map((m,i)=>{
    const u='media/'+m.media_path;
    const th=m.tipo==='video'?`<video src="${esc(u)}#t=0.1" muted></video>`:`<img src="${esc(u)}" onerror="this.style.opacity=.15">`;
    return `<div class="bpcell" onclick="attachBiblio(${i},this)" title="${esc(m.nombre||'')}">${th}<span class="bpcode">${esc(m.codigo||'')}</span></div>`;
  }).join('') : '<div class="bpempty">— la biblioteca (taller) está vacía; subí o generá material primero —</div>';
  ov.innerHTML=`<div class="bpbox"><div class="bphead"><b>Agregar desde la biblioteca</b><span>elegí uno o varios · se copian a esta propuesta</span><button onclick="cerrarPicker()" title="Cerrar">×</button></div><div class="bpgrid">${cells}</div></div>`;
  ov.style.display='flex';
}
async function attachBiblio(i, el){
  const m=_pickItems[i]; if(!m||!modalId||el.classList.contains('bpadded')) return;
  el.classList.add('bpadded');
  try{ const d=await fetch('api/requerimientos/'+modalId+'/material-biblioteca',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({media_path:m.media_path,tipo:m.tipo,filename:m.nombre||m.codigo})}).then(r=>r.json());
    if(d.ok){ toast('Agregado: '+(m.codigo||'material')); loadMateriales(); }
    else { toast('No se pudo agregar'+(d.error?' ('+d.error+')':''),true); el.classList.remove('bpadded'); }
  }catch(e){ toast('Error de conexión',true); el.classList.remove('bpadded'); }
}
function cerrarPicker(){ const o=document.getElementById('bp-ov'); if(o) o.style.display='none'; }
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
// "Pedir nueva versión": manda tus comentarios y el creativo reescribe el concepto (loop de refinamiento, sin generar la pieza).
async function pedirNuevaVersion(){
  if(!modalId||acting) return;
  const coment=document.getElementById('rm-coment').value.trim();
  if(!coment){ toast('Escribí qué querés ajustar del concepto', true); return; }
  const id=modalId, btn=document.getElementById('rm-rev');
  acting=true; if(btn){btn.disabled=true; btn.textContent='Enviando…';}
  try{
    const d=await fetch('api/requerimientos/'+id+'/revisar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({comentarios:coment})}).then(r=>r.json());
    if(d.ok){ toast('El creativo está preparando una nueva versión'); modalId=null; document.getElementById('reqmodal').classList.add('hidden'); }
    else toast('No se pudo'+(d.error?' ('+d.error+')':''), true);
  }catch(e){ toast('Error de conexión', true); }
  if(btn){btn.disabled=false; btn.textContent='Pedir nueva versión';} acting=false; setTimeout(currentLoad,500);
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
  const propHtml = work.map(b =>
      (b.brief_estado==='revisar'||b.brief_estado==='revisando') ? revisandoCard(b)
      : (!b.pieza_id && (b.brief_estado==='pendiente'||b.brief_estado==='procesando')) ? generandoCard(b)
      : solicitudCard(b)).join('')
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
// --- Pauta: reporte (Meta, read-only) + propuestas de campaña del creativo ---
function money(v, cur){ try{ return new Intl.NumberFormat('es-AR',{style:'currency',currency:cur||'USD',maximumFractionDigits:2}).format(Number(v||0)); }catch(_){ return (cur||'')+' '+nf(v); } }
const pct = v => Number(v||0).toLocaleString('es-AR',{maximumFractionDigits:2})+'%';
function stClass(e){ if(e==='ACTIVE') return 'ok'; if(['PAUSED','ADSET_PAUSED','CAMPAIGN_PAUSED'].includes(e)) return 'pause'; if(['WITH_ISSUES','DISABLED','DELETED','ARCHIVED'].includes(e)) return 'warn'; return ''; }
const OBJ={OUTCOME_AWARENESS:'Reconocimiento',OUTCOME_TRAFFIC:'Tráfico',OUTCOME_ENGAGEMENT:'Interacción'};
const CAMP_EST={propuesta:['Propuesta','pause'],aprobada:['Creando en Meta…','pause'],activar:['Activando…','pause'],pausar:['Pausando…','pause'],descartar:['Descartando…','warn'],pausada:['Pausada en Meta','pause'],activa:['Activa','ok'],rechazada:['Rechazada','warn'],error:['Error','warn']};
let _CAMPS=[], _CAMPCUR='USD';
function audTxt(a){ a=a||{}; const p=[];
  if(a.ubicaciones&&a.ubicaciones.length) p.push(a.ubicaciones.map(u=>esc(u.nombre)+(u.radio_km?` (+${u.radio_km}km)`:'')).join(', '));
  if(a.edad_min||a.edad_max) p.push(`${a.edad_min||18}–${a.edad_max||65} años`);
  if(a.generos&&a.generos.length&&!a.generos.includes('todos')) p.push(a.generos.join('/'));
  if(a.intereses&&a.intereses.length) p.push(a.intereses.map(i=>esc(i.nombre||i)).join(', '));
  return p.join(' · ')||'—'; }
function presTxt(p,cur){ p=p||{}; if(!p.monto) return '—'; return money(p.monto,p.moneda||cur)+(p.tipo==='diario'?'/día':' total'); }
function campThumb(c){ const u=(c.pieza_tipo==='video'&&c.pieza_poster)?c.pieza_poster:c.pieza_url; return u?`<img class="camp-thumb" src="${esc(u)}" onerror="this.style.visibility='hidden'">`:'<span class="camp-thumb ph"></span>'; }
function campCard(c){
  const [lbl,cls]=CAMP_EST[c.estado]||[c.estado,''];
  return `<a class="camp cclick" href="#" onclick="openCamp('${c.id}');return false;">
    <div class="camp-top">${campThumb(c)}<div style="flex:1;min-width:0">
      <div class="camp-name">${esc(c.nombre)}</div>
      <div class="camp-m2">${OBJ[c.objetivo]||esc(c.objetivo)} · ${presTxt(c.presupuesto,_CAMPCUR)} · ${c.pieza_numero?'CF-'+pad4(c.pieza_numero):'sin creativo'}</div>
    </div><span class="st ${cls}">${lbl}</span></div>
    ${c.resumen?`<div class="camp-res">${esc(c.resumen)}</div>`:''}
  </a>`;
}
async function loadPauta(){
  try{
    const [rp,rc]=await Promise.all([fetch('api/pauta'),fetch('api/campanias')]);
    if(rp.status===401){ location.href='login'; return; }
    const d=await rp.json();
    const cc=rc.ok?await rc.json():{campanias:[],trabajando:0};
    const el=document.getElementById('pauta'); if(!el) return;
    if(!d || d.configurada===false){ el.innerHTML='<div class="pauta-off">Esta marca todavía no tiene cuenta publicitaria conectada.</div>'; setUpd(); return; }
    const cur=d.moneda||'USD', c=d.cuenta||{}, t=d.totales||{};
    _CAMPS=cc.campanias||[]; _CAMPCUR=cur;
    const acctSt = c.estado===1 ? 'ok' : (c.estado>=100 ? 'warn' : '');
    let h=`<div class="pauta-head">
      <div>
        <div class="pauta-acct">${esc(c.nombre||'Cuenta publicitaria')}</div>
        <div class="pauta-sub"><span class="st ${acctSt}">${esc(c.estado_txt||'—')}</span><span>${esc(cur)}</span>${d.capturado_en?`<span>· actualizado ${hace(d.capturado_en)}</span>`:''}</div>
      </div>
      <div class="pauta-spend"><div class="pv">${money(c.gastado_total,cur)}</div><div class="pl">Gastado histórico</div></div>
    </div>
    <div class="pauta-win">${esc(d.ventana||'Últimos 30 días')}</div>
    <div class="pauta-kpis">
      <div class="kpi"><span class="kv">${money(t.gasto,cur)}</span><span class="kl">Gasto</span></div>
      <div class="kpi"><span class="kv">${nf(t.impresiones)}</span><span class="kl">Impresiones</span></div>
      <div class="kpi"><span class="kv">${nf(t.alcance)}</span><span class="kl">Alcance</span></div>
      <div class="kpi"><span class="kv">${nf(t.clics)}</span><span class="kl">Clics</span></div>
      <div class="kpi"><span class="kv">${pct(t.ctr)}</span><span class="kl">CTR</span></div>
    </div>`;
    const drafts=_CAMPS, live=d.campanias||[];
    h+=`<div class="pauta-h3">Campañas <span class="n">${(drafts.length+live.length)||''}</span>
      <button class="picon" title="Pedir una campaña al creativo" onclick="askCampania()"><i data-lucide="plus" class="w-4 h-4"></i></button></div>`;
    if(cc.trabajando>0) h+=`<div class="camp-work"><span class="dotp"></span>El creativo está preparando una campaña…</div>`;
    if(drafts.length) h+=drafts.map(campCard).join('');
    if(live.length){
      h+=`<div class="pauta-win">Activas en Meta</div>`+live.map(k=>`<div class="camp">
        <div class="camp-top"><span class="st ${stClass(k.estado)}">${esc(k.estado_txt)}</span><span class="camp-name">${esc(k.nombre)}</span><span class="camp-obj">${esc(k.objetivo)}</span></div>
        <div class="camp-m"><span>Gasto <b>${money(k.gasto,cur)}</b></span><span>Alcance <b>${nf(k.alcance)}</b></span><span>Impresiones <b>${nf(k.impresiones)}</b></span><span>Clics <b>${nf(k.clics)}</b></span><span>CTR <b>${pct(k.ctr)}</b></span></div>
      </div>`).join('');
    }
    if(!drafts.length && !live.length && cc.trabajando===0){
      h+=`<div class="pauta-empty">Todavía no hay campañas. Pedile una al creativo con el botón <b>+</b>: propone objetivo, creativo, público y presupuesto, y vos la aprobás antes de que gaste un peso.</div>`;
    }
    el.innerHTML=h;
    if(window.lucide) lucide.createIcons();
    setUpd();
  }catch(e){ setUpd(); }
}
function openCamp(id){
  const c=_CAMPS.find(x=>x.id===id); if(!c) return;
  const cur=_CAMPCUR, [lbl,cls]=CAMP_EST[c.estado]||[c.estado,''];
  const fechas=(c.fecha_inicio||c.fecha_fin)?`${c.fecha_inicio||'—'} → ${c.fecha_fin||'—'}`:'—';
  const perm=c.pieza_permalink?` <a href="${esc(c.pieza_permalink)}" target="_blank" rel="noopener">ver post ↗</a>`:'';
  const media=(c.pieza_tipo==='video'&&c.pieza_poster)?c.pieza_poster:c.pieza_url;
  document.getElementById('camp-body').innerHTML=`
    <div class="cm-row"><span class="st ${cls}">${lbl}</span><span class="cm-obj">${OBJ[c.objetivo]||esc(c.objetivo)}</span></div>
    <h3 class="cm-name">${esc(c.nombre)}</h3>
    ${c.razon?`<p class="cm-razon">${esc(c.razon)}</p>`:''}
    ${media?`<img class="cm-media" src="${esc(media)}" onerror="this.style.display='none'">`:''}
    <div class="cm-grid">
      <div><span class="cm-k">Creativo</span><span class="cm-v">${c.pieza_numero?'CF-'+pad4(c.pieza_numero):'—'}${perm}</span></div>
      <div><span class="cm-k">Presupuesto</span><span class="cm-v">${presTxt(c.presupuesto,cur)}</span></div>
      <div><span class="cm-k">Fechas</span><span class="cm-v">${esc(fechas)}</span></div>
      <div><span class="cm-k">Audiencia</span><span class="cm-v">${audTxt(c.audiencia)}</span></div>
      ${c.url_destino?`<div><span class="cm-k">Destino</span><span class="cm-v">${esc(c.url_destino)}${c.cta?' · '+esc(c.cta):''}</span></div>`:''}
    </div>`;
  const acts=document.getElementById('camp-acts');
  if(c.estado==='propuesta') acts.innerHTML=`<button class="btn del" onclick="descartarCamp('${c.id}')">Descartar</button><button class="btn ok" onclick="aprobarCamp('${c.id}')">Aprobar</button>`;
  else if(['aprobada','activar','pausar','descartar'].includes(c.estado)) acts.innerHTML=`<span class="cm-note">El motor está aplicando el cambio en Meta… (se refresca solo)</span>`;
  else if(c.estado==='pausada') acts.innerHTML=`<span class="cm-note" style="flex:1">Creada <b>pausada</b> en Meta. No gasta hasta que la actives.</span><button class="btn ok" onclick="activarCamp('${c.id}')">Activar</button>`;
  else if(c.estado==='activa') acts.innerHTML=`<span class="cm-note" style="flex:1">Corriendo en Meta.</span><button class="btn no" onclick="pausarCamp('${c.id}')">Pausar</button>`;
  else if(c.estado==='error') acts.innerHTML=`<button class="btn del" onclick="descartarCamp('${c.id}')">Descartar</button>${c.meta_campaign_id?'':`<button class="btn ok" onclick="reintentarCamp('${c.id}')">Reintentar</button>`}`;
  else acts.innerHTML='';
  document.getElementById('campmodal').classList.remove('hidden');
}
function closeCamp(){ const m=document.getElementById('campmodal'); if(m) m.classList.add('hidden'); }
async function campAction(id, accion, body){
  try{ const r=await fetch('api/campanias/'+id+'/'+accion,{method:'POST',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
    const d=await r.json(); if(d.ok){ closeCamp(); loadPauta(); return true; } toast('No se pudo',true); return false;
  }catch(e){ toast('Error de conexión',true); return false; }
}
async function aprobarCamp(id){ if(await campAction(id,'aprobar')) toast('Aprobada — se crea pausada en Meta'); }
async function descartarCamp(id){ if(await campAction(id,'descartar')) toast('Descartada'); }
async function activarCamp(id){ if(!confirm('Vas a ACTIVAR la campaña en Meta: empieza a gastar según el presupuesto y las fechas. ¿Confirmás?')) return; if(await campAction(id,'activar')) toast('Activando en Meta…'); }
async function pausarCamp(id){ if(await campAction(id,'pausar')) toast('Pausando en Meta…'); }
async function reintentarCamp(id){ if(await campAction(id,'reintentar')) toast('Reintentando la creación…'); }
function askCampania(){ const m=document.getElementById('campask'); if(m){ const i=document.getElementById('camp-instr'); if(i) i.value=''; m.classList.remove('hidden'); } }
function closeAsk(){ const m=document.getElementById('campask'); if(m) m.classList.add('hidden'); }
async function pedirCampania(){
  const instruccion=(document.getElementById('camp-instr')||{}).value||'';
  try{ const r=await fetch('api/campanias/solicitar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instruccion})});
    const d=await r.json(); if(d.ok){ toast('Pedido al creativo — va a proponer una campaña'); closeAsk(); loadPauta(); } else toast('No se pudo pedir',true);
  }catch(e){ toast('Error de conexión',true); }
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
