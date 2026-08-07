// Panel de publicaciones de Cortafuego — backend Node/Express (read-only).
// Sirve la UI estática (public/) + una API JSON. La SQL vive en db.js.
// Se sirve detrás del proxy de la landing en cortafuego.ar/panel/ (Nginx → este servicio).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const archiver = require('archiver');
const db = require('./db');
const vnnox = require('./vnnox');

const app = express();
const PORT = Number(process.env.PORT || 3001);
// Base de los webhooks de n8n que disparan publicar/rechazar (mismos que usan mail y Telegram).
const N8N = (process.env.N8N_WEBHOOK_BASE || 'https://crm-n8n.dhmtev.easypanel.host/webhook').replace(/\/$/, '');
const BOT = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.PANEL_TG_CHAT || '811183062';
const IG_TOKEN = process.env.IG_TOKEN || '';
const IG_USER_ID = process.env.IG_USER_ID || '27632458043024661';
const IG_API = 'https://graph.instagram.com/v19.0';

// Captura menciones entrantes (media donde nos etiquetan, edge /tags) y las deja en la cola
// como propuesta (origen='mencion') para que Fer decida: generar publicación o descartar. Avisa por Telegram.
async function refreshMenciones() {
  try {
    // El token/cuenta de IG es de Cortafuego: las menciones entrantes se atribuyen a esa marca.
    // Token: del perfil (DB, cifrado) con fallback al env. (Cuando cada marca tenga el suyo, esto se vuelve por-marca.)
    const pid = await db.getProyectoId('cortafuego');
    const tok = (await db.getIgToken('cortafuego')) || IG_TOKEN;
    if (!tok) return;
    const d = await fetch(`${IG_API}/${IG_USER_ID}/tags?fields=id,username,permalink,timestamp&limit=25&access_token=${tok}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    if (!d || !d.data) return;
    for (const m of d.data) {
      const nueva = await db.insertMencion(m.id, m.username || 'alguien', m.permalink || '', pid);
      if (nueva && BOT) {
        const txt = `Te etiquetaron en Instagram: @${m.username}. Quedó en la cola del panel para que decidas (generar publicación o descartar).\n${m.permalink || ''}`;
        await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: txt, disable_web_page_preview: false }) }).catch(() => {});
      }
    }
  } catch (e) { console.error('menciones', e.message); }
}

// Refresca las métricas de IG de las piezas publicadas y las cachea en la base.
// Insights de NUESTRA propia cuenta (el token de publicación tiene permiso). Stories viejas expiran → se saltean.
async function refreshMetricas() {
  const tok = (await db.getIgToken('cortafuego')) || IG_TOKEN;
  if (!tok) return;
  const metric = 'views,reach,likes,comments,saved,shares,total_interactions';
  let ok = 0;
  for (const id of await db.getPostIdsPublicados()) {
    try {
      const d = await fetch(`${IG_API}/${id}/insights?metric=${metric}&access_token=${tok}`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
      if (!d || !d.data) continue;               // p.ej. story expirada o métrica no soportada
      const v = {}; d.data.forEach(x => { v[x.name] = x.values && x.values[0] ? x.values[0].value : 0; });
      await db.upsertMetricas(id, v); ok++;
    } catch (_) { /* seguir con el resto */ }
  }
  console.log(`métricas refrescadas: ${ok}`);
}

// --- Sesión: usuario + cookie firmada (HMAC). Ver panel/auth.js y planes/USUARIOS_Y_ROLES.md ---
const auth = require('./auth');
const mail = require('./mail');
const tel = require('./telefono');
const COOKIE_PATH = process.env.PANEL_COOKIE_PATH || '/panel';
const TTL_S = auth.TTL_S;

app.disable('x-powered-by');
// --- WhatsApp (públicos, ANTES de la sesión y del parser de JSON) -----------------
// La firma de Meta se calcula sobre el cuerpo CRUDO: si express.json lo parsea primero, ya no
// hay forma de reconstruir los bytes exactos y la validación queda inservible.
const wa = require('./whatsapp');
const reservaWa = require('./reserva_wa');   // asistente de reservas por WhatsApp (v2.0/F5e)
const faq = require('./faq');                 // respuestas frecuentes del canal (v2.0/F5h)

// Meta valida la URL con un GET antes de aceptarla. Sin esto no se puede completar el alta.
app.get('/webhook/whatsapp', (req, res) => {
  const q = req.query;
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === wa.VERIFY && wa.VERIFY) {
    return res.status(200).send(String(q['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});

app.post('/webhook/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  // Se parsea ANTES de validar, pero sólo para saber a qué número le escribieron y con eso elegir
  // con qué secreto verificar. No se confía en nada del cuerpo hasta que la firma da: quien miente
  // sobre el número sigue sin poder firmar como su dueño.
  let cuerpo;
  try { cuerpo = JSON.parse(crudo.toString('utf8') || '{}'); } catch { return res.sendStatus(400); }
  const destino = (((cuerpo.entry || [])[0] || {}).changes || [])
    .map(c => ((c.value || {}).metadata || {}).phone_number_id).find(Boolean) || null;

  let secreto = null;
  try { secreto = await db.secretoDeNumero(destino); } catch (e) { console.error('secreto wa', e.message); }
  if (!wa.firmaValida(crudo, req.headers['x-hub-signature-256'], secreto ? [secreto] : [])) {
    // Se registra el rechazo (sin el cuerpo). Un 403 acá significa que el mensaje SÍ llegó y que
    // el problema es la llave — distinguirlo de "no llegó nada" es la mitad de cualquier
    // diagnóstico de alta, y desde la interfaz de Meta no se ve.
    console.log(`webhook whatsapp RECHAZADO: destino=${destino || 'desconocido'} ` +
      `secreto=${secreto ? 'cargado' : 'sin cargar'} firma=${req.headers['x-hub-signature-256'] ? 'presente' : 'ausente'}`);
    return res.sendStatus(403);
  }
  // Contestamos YA: si tardamos, Meta reintenta y el mismo mensaje llega varias veces.
  res.sendStatus(200);

  for (const m of wa.leerMensajes(cuerpo)) {
    try {
      if (await db.whatsappYaVisto(m.mensaje_id)) continue;   // reintento de Meta

      // ¿A qué número escribieron? Si es el de un negocio, del otro lado hay un CLIENTE FINAL, no
      // un operador: contestarle con el mensaje del panel sería desconcertante. Por ahora se
      // registra y no se responde; interpretar lo que pide es un paso posterior.
      const negocio = m.phone_number_id ? await db.negocioPorPhoneId(m.phone_number_id) : null;
      if (negocio) {
        // La hora de RECEPCIÓN, tomada antes de contestar. El mensaje entrante se guarda después
        // de que el asistente respondió —hace falta saber si lo atendió para el estado— y sin
        // esto quedaba registrado DESPUÉS de su propia respuesta: el inbox mostraba la conversación
        // al revés, con cada contestación arriba de la pregunta que la provocó.
        const recibido = new Date();
        // Del otro lado hay un CLIENTE FINAL, no un operador. Si el negocio tiene las reservas
        // abiertas, el asistente lo atiende; si no, se registra y no se contesta — mejor callar
        // que ofrecer algo que después no se puede cumplir.
        const atendido = await reservaWa.atender(negocio, m).catch(e => {
          console.error('reserva wa', e.message); return false;
        });
        await db.logWhatsapp({
          direccion: 'entrante', wa_id: m.wa_id, usuario_id: null, negocio_id: negocio.id,
          mensaje_id: m.mensaje_id, tipo: m.tipo, texto: m.texto, crudo: m.crudo,
          media_id: m.media_id, creado_en: recibido,
          estado: atendido ? 'atendido_bot' : 'cliente_de_negocio',
        });
        // Nota de voz: la transcripción llega después, del worker del host. Se la espera SIN
        // await — bloquear acá dejaría al resto del lote de Meta esperando a whisper.
        if (atendido && m.tipo === 'audio' && m.media_id) {
          reservaWa.seguirVoz(negocio, m).catch(e => console.error('seguir voz', e.message));
        }
        if (!atendido) console.log(`whatsapp: mensaje para ${negocio.slug} de ${m.wa_id} — registrado, sin responder`);
        continue;
      }

      const u = await db.getUsuarioPorWhatsapp(m.wa_id);
      await db.logWhatsapp({
        direccion: 'entrante', wa_id: m.wa_id, usuario_id: u && u.id,
        mensaje_id: m.mensaje_id, tipo: m.tipo, texto: m.texto, crudo: m.crudo,
        estado: u ? 'recibido' : 'sin_usuario',
      });

      // El canal autentica; el acceso lo da contenido.usuario. Mismo criterio que el SSO.
      if (!u) {
        await wa.enviarTexto(m.wa_id,
          'Hola. Este número es del panel de ClaUsina y todavía no reconozco el tuyo. ' +
          'Si trabajás con nosotros, pedile a tu administrador que lo cargue en tu cuenta.');
        continue;
      }

      // Fase 1: confirmamos identidad y qué negocios maneja. La interpretación del pedido viene
      // después, cuando el circuito de ida y vuelta esté probado.
      const negocios = (u.negocios || []).map(n => n.slug).join(', ') || 'ningún negocio asignado';
      const r = await wa.enviarTexto(m.wa_id,
        `Hola ${u.nombre.split(' ')[0]}. Te reconocí: trabajás sobre ${negocios}.\n\n` +
        'Todavía estoy aprendiendo a tomar pedidos por acá; en breve vas a poder mandarme ' +
        'requerimientos y aprobar piezas desde este chat.');
      await db.logWhatsapp({
        direccion: 'saliente', wa_id: m.wa_id, usuario_id: u.id, mensaje_id: r.id,
        tipo: 'text', texto: 'respuesta de identificación',
        estado: r.ok ? 'enviado' : 'error',
      });
    } catch (e) { console.error('whatsapp', e.message); }
  }
});

app.use(express.json({ limit: '120mb' }));  // material/logo van como dataURL base64; un video sube ~33% -> holgura para archivos de ~85MB

// Públicos (sin sesión): health, pantalla de login y sus fuentes, login/logout.
app.get('/api/health', async (req, res) => { try { await db.health(); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); } });
app.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts'), { maxAge: '30d' }));
// Assets que necesitan las pantallas ANTERIORES a la sesión (login, definir contraseña).
// El static de public/ se monta al final, detrás de la compuerta: sin esto esas páginas se
// dibujaban sin hoja de estilos y sin logo. Sólo estáticos inertes — el HTML y el JS del panel
// siguen detrás de la sesión.
// ═══════════════════ SUPERFICIE PÚBLICA (v2.0 / F5) ═══════════════════════════════════════
// TODO lo de este bloque lo consume gente SIN sesión, así que va ANTES de la compuerta de auth.
// Reglas que no se negocian acá adentro:
//   · el negocio tiene que haber marcado `publico` en su config de reservas — el silencio es no;
//   · se expone identidad y disponibilidad, nunca clientes ni reservas ajenas;
//   · hay límite por IP: sin sesión, cualquiera puede intentar llenar la agenda de un negocio.
const RATE = new Map();
function limite(req, res, tope, ventanaMs) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'x';
  const ahora = Date.now();
  const k = req.path.split('/').slice(0, 4).join('/') + '|' + ip;
  const e = RATE.get(k);
  if (!e || ahora - e.desde > ventanaMs) { RATE.set(k, { desde: ahora, n: 1 }); return true; }
  if (e.n >= tope) { res.status(429).json({ error: 'demasiados_intentos' }); return false; }
  e.n++;
  return true;
}
// Poda: sin esto el Map crece para siempre, que es la misma lección del sqlite de n8n.
setInterval(() => {
  const corte = Date.now() - 3600e3;
  for (const [k, v] of RATE) if (v.desde < corte) RATE.delete(k);
}, 600e3).unref();

const ipHash = req => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  // Hash y no la IP: para contar visitas alcanza, y una IP es un dato personal que no necesitamos.
  return ip ? require('crypto').createHash('sha256').update(ip + '|clausina').digest('hex').slice(0, 32) : null;
};

// Enlace corto de una acción: registra la apertura y manda a la página del negocio.
app.get('/a/:token', async (req, res) => {
  if (!limite(req, res, 60, 60e3)) return;
  try {
    const r = await db.registrarApertura(String(req.params.token), ipHash(req), req.headers.referer);
    if (!r) return res.status(404).send('Enlace no válido o dado de baja.');
    res.redirect(`/r/${r.link.slug}?c=${r.clickId}`);
  } catch (e) { console.error('link', e.message); res.status(500).send('Error'); }
});

// El enlace de una invitación. Resuelve solo a qué negocio pertenece: por eso el código es único
// en toda la plataforma y no por negocio — quien lo abre no tiene por qué saberlo.
app.get('/i/:codigo', async (req, res) => {
  if (!limite(req, res, 60, 60e3)) return;
  try {
    const r = await db.consultarInvitacion(String(req.params.codigo));
    // Un código inválido no manda a un 404 seco: se abre igual la página de reservas del negocio
    // si se puede saber cuál es, y ahí se explica qué pasó. Perder una reserva porque el código
    // venció es peor que el descuento.
    if (!r.ok && !r.invitacion) return res.status(404).send('Ese código de invitación no existe.');
    const inv = r.invitacion;
    res.redirect(`/r/${inv.negocio_slug}?inv=${encodeURIComponent(inv.codigo)}`);
  } catch (e) { console.error('invitacion link', e.message); res.status(500).send('Error'); }
});

// El pase: la invitación en versión imprimible o para mandar por mail. Es pública a propósito —
// el código YA es el secreto, y quien lo tiene es su dueño. Pedir una sesión para ver la propia
// invitación no protegería nada y la haría inservible como algo que se reenvía.
app.get('/pase/:codigo', async (req, res) => {
  if (!limite(req, res, 60, 60e3)) return;
  res.sendFile(path.join(__dirname, 'public', 'publico', 'pase.html'));
});

// El pliego para imprenta: varias invitaciones en A6, frente y dorso. No genera el PDF acá —
// lo hace el navegador al imprimir, que además deja elegir impresora y márgenes. Meter un
// generador de PDF en la imagen del panel serían 700 MB para hacer lo mismo peor.
app.get('/pase/lote/:codigos', async (req, res) => {
  if (!limite(req, res, 20, 60e3)) return;
  res.sendFile(path.join(__dirname, 'public', 'publico', 'lote.html'));
});

// Piezas publicadas, para usarlas de frente del impreso.
app.get('/api/publico/:slug/piezas', async (req, res) => {
  if (!limite(req, res, 60, 60e3)) return;
  try {
    const n = await db.negocioPublico(String(req.params.slug));
    if (!n) return res.status(404).json({ error: 'no_disponible' });
    res.json({ piezas: await db.piezasPublicadas(n.id) });
  } catch (e) { console.error('piezas publicas', e.message); res.status(500).json({ error: 'error' }); }
});

app.get('/api/publico/pase/:codigo', async (req, res) => {
  if (!limite(req, res, 60, 60e3)) return;
  try {
    const r = await db.consultarInvitacion(String(req.params.codigo));
    const i = r.invitacion;
    if (!r.ok) {
      // Aunque no sirva, se dice de qué negocio es para poder ofrecer reservar igual.
      return res.json({ ok: false, mensaje: r.mensaje, negocio_slug: i ? i.negocio_slug : null });
    }
    const n = await db.negocioPublico(i.negocio_slug);
    res.json({
      ok: true, codigo: i.codigo, texto: r.texto, etiqueta: i.etiqueta,
      vence_en: i.vence_en, usos_max: i.usos_max,
      condiciones: await db.condicionesLegibles(i.negocio_id, i.condiciones),
      negocio: i.negocio_nombre, negocio_slug: i.negocio_slug,
      // La marca y el logo salen del negocio: el pase es suyo, no de ClaUsina.
      logo: n ? n.logo : null, marca: n ? n.marca : null,
      whatsapp: n ? n.whatsapp : null,
      // Para el pie: dónde queda, dónde encontrarlos. Sin esto, una invitación reenviada a
      // alguien que no conoce el lugar no le dice ni la dirección.
      web: n ? n.web : null, instagram: n ? n.instagram : null, sede: n ? n.sede : null,
      // El frente que el negocio indicó para esta campaña. El pliego lo usa por defecto.
      frente: i.frente_url || null,
      frente_codigo: i.frente_numero ? db.codigoPieza('grafica', i.frente_numero) : null,
    });
  } catch (e) { console.error('pase', e.message); res.status(500).json({ ok: false }); }
});

// La página pública de reservas de un negocio.
app.get('/r/:slug', async (req, res) => {
  if (!limite(req, res, 120, 60e3)) return;
  try {
    const n = await db.negocioPublico(String(req.params.slug));
    if (!n) return res.status(404).send('Este negocio no tiene reservas abiertas al público.');
    res.sendFile(path.join(__dirname, 'public', 'publico', 'reservar.html'));
  } catch (e) { console.error('publico', e.message); res.status(500).send('Error'); }
});

app.get('/api/publico/:slug', async (req, res) => {
  if (!limite(req, res, 120, 60e3)) return;
  try {
    const n = await db.negocioPublico(String(req.params.slug));
    if (!n) return res.status(404).json({ error: 'no_disponible' });
    const { id, ...publico } = n;          // el uuid interno no sale
    res.json(publico);
  } catch (e) { console.error('publico', e.message); res.status(500).json({ error: 'error' }); }
});

// Lo que consulta una LANDING (otro dominio) para saber si tiene que mostrar el botón.
// Con CORS abierto sólo para este endpoint: es información pública y la pide un origen distinto.
app.get('/api/publico/:slug/landing', async (req, res) => {
  if (!limite(req, res, 300, 60e3)) return;
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  try {
    const o = await db.ofertaLanding(String(req.params.slug));
    // req.protocol dice http detrás del proxy: hay que mirar el encabezado. Una landing en
    // https que incruste un enlace http lo ve bloqueado por contenido mixto.
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    if (o.reservas) o.reservas.url = `${proto}://${req.get('host')}${o.reservas.url}`;
    res.json(o);
  } catch (e) { console.error('landing', e.message); res.status(500).json({ error: 'error' }); }
});

// Qué da un código, para mostrarlo antes de pedir fecha, turno y datos. Validar recién al final,
// después de que la persona cargó todo, es la peor versión posible de esto.
app.get('/api/publico/:slug/invitacion/:codigo', async (req, res) => {
  if (!limite(req, res, 30, 60e3)) return;
  try {
    const n = await db.negocioPublico(String(req.params.slug));
    if (!n) return res.status(404).json({ error: 'no_disponible' });
    const r = await db.consultarInvitacion(String(req.params.codigo), n.id);
    // Hacia afuera va sólo lo que la persona necesita saber: qué le toca y hasta cuándo. Nada
    // de a quién más se le mandó, cuántos usos lleva ni de qué campaña es.
    if (!r.ok) return res.json({ ok: false, mensaje: r.mensaje });
    res.json({ ok: true, texto: r.texto, vence_en: r.invitacion.vence_en,
               condiciones: await db.condicionesLegibles(n.id, r.invitacion.condiciones) });
  } catch (e) { console.error('inv publica', e.message); res.status(500).json({ error: 'error' }); }
});

app.get('/api/publico/:slug/disponibilidad', async (req, res) => {
  if (!limite(req, res, 120, 60e3)) return;
  try {
    const n = await db.negocioPublico(String(req.params.slug));
    if (!n) return res.status(404).json({ error: 'no_disponible' });
    const { desde, hasta } = rango(req, Math.min(n.anticipacion_max_dias || 30, 60));
    res.json({ desde, hasta, turnos: await db.disponibilidadPublica(n.id, desde, hasta) });
  } catch (e) { console.error('disp publica', e.message); res.status(500).json({ error: 'error' }); }
});

app.post('/api/publico/:slug/reserva', async (req, res) => {
  // Más apretado que las lecturas: crear consume capacidad real del negocio.
  if (!limite(req, res, 6, 600e3)) return;
  try {
    const n = await db.negocioPublico(String(req.params.slug));
    if (!n) return res.status(404).json({ error: 'no_disponible' });
    const b = req.body || {};
    // Trampa para robots: un campo que una persona no ve y por lo tanto no completa.
    if (String(b.web || '').trim()) return res.status(400).json({ ok: false, error: 'invalido' });
    if (!String(b.cliente_nombre || '').trim() || !String(b.cliente_telefono || '').trim()) {
      return res.status(409).json({ ok: false, error: 'sin_cliente' });
    }
    const click = /^[0-9a-f-]{36}$/i.test(String(b.click || '')) ? b.click : null;
    const linkId = click ? await db.linkDeApertura(click, n.id) : null;
    const r = await db.crearReserva(n.id, {
      turno_id: b.turno_id, fecha: b.fecha, cantidad: b.cantidad,
      cliente_nombre: b.cliente_nombre, cliente_telefono: b.cliente_telefono,
      cliente_email: b.cliente_email, notas: b.notas,
      consentimiento: b.consentimiento === true,
      canal: 'landing', link_id: linkId,
      invitacion_codigo: String(b.invitacion || '').trim() || null,
    });
    if (click) await db.marcarCompletado(click, r.id);
    // Después de responder: el visitante no tiene que esperar a que Meta conteste.
    setImmediate(() => avisarReserva(r.id, 'negocio'));
    // Hacia afuera no se devuelve cuánto quedó libre: es información del negocio.
    res.json({ ok: true, estado: r.estado });
  } catch (e) {
    // NO se usa resError acá: adjunta `detalle`, que en varios errores es la config entera del
    // negocio (fuente de verdad, auto-confirmar). Hacia afuera va sólo el código.
    if (RES_ERR.has(e.code) || String(e.code || '').startsWith('inv_')) {
      return res.status(409).json({ ok: false, error: e.code });
    }
    console.error('reserva publica', e.message);
    res.status(500).json({ ok: false, error: 'error' });
  }
});
// ═══════════════════ FIN DE LA SUPERFICIE PÚBLICA ═════════════════════════════════════════

const ASSETS_PUBLICOS = /\.(css|svg|png|jpe?g|ico|webp|woff2?)$/i;
const estaticoPublico = express.static(path.join(__dirname, 'public'), { maxAge: '30d', index: false, dotfiles: 'ignore' });
app.use((req, res, next) => {
  // El filtro va acá, no en las opciones de express.static: `static` sirve todo lo que encuentre.
  // Dejamos pasar sólo estáticos inertes; el HTML y el JS del panel siguen detrás de la sesión.
  if (req.method !== 'GET' || !ASSETS_PUBLICOS.test(req.path)) return next();
  res.set('X-Content-Type-Options', 'nosniff');
  return estaticoPublico(req, res, next);
});
// Almacén de medios de la agencia (volumen persistente /app/media): imágenes para panel, IG, landings, creativo. Público.
// Almacén de medios. NO se puede cerrar entero: al publicar, Instagram descarga el archivo
// desde su propio servidor (sin cookie), y hoy 219 piezas apuntan a `ig/` y 6 a `biblioteca/`.
// Cerrarlas rompería la publicación. `manual/` queda abierta a propósito: el manual de marca
// está pensado para compartirse por link.
// Lo puramente interno sí se cierra: material de trabajo, referencias y assets de marca.
// PENDIENTE: URLs firmadas al publicar, para poder cerrar también ig/ y biblioteca/.
const MEDIA_PRIVADA = ['material', 'referencias', 'creativo', 'marca'];
app.use('/media', (req, res, next) => {
  const carpeta = req.path.split('/').filter(Boolean)[0] || '';
  if (!MEDIA_PRIVADA.includes(carpeta)) return next();
  const tok = auth.readToken(auth.readCookie(req));
  return tok && tok.uid ? next() : res.status(403).end();
}, express.static('/app/media', { maxAge: '30d' }));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
// Públicos para la PANTALLA: el reproductor (kiosco) y la playlist activa que poolea.
app.get('/play', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'pantalla-play.html')); });
// Player público: la pantalla viene por query param (?pantalla=<slug>); default = la pantalla activa.
app.get('/api/pantalla/activo', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Preview: el player puede pedir UN programa concreto (?programa=<id>), esté activo o no.
    // Sirve para ver cómo queda la pantalla antes de activar. No cambia nada de lo que se emite.
    if (req.query.programa) return res.json(await db.getProgramaPlaylist(String(req.query.programa)));
    const pa = req.query.pantalla ? await db.getPantallaPorSlug(String(req.query.pantalla)) : await db.getPantallaActiva();
    res.json(pa ? await db.getActivoPlaylist(pa.id) : { version: 'none', nombre: null, items: [] });
  } catch (e) { console.error('activo', e.message); res.status(500).json({ error: 'db', items: [] }); }
});
app.post('/api/login', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim();
    const pw = String((req.body && req.body.password) || '');
    if (!email || !pw) return res.status(401).json({ ok: false });
    const u = await db.getUsuarioPorEmail(email);
    if (!u || !auth.verifyPassword(pw, u.password_hash)) return res.status(401).json({ ok: false });
    db.tocarAcceso(u.id).catch(() => {});
    res.set('Set-Cookie', auth.cookieHeader(auth.issue(u.id), COOKIE_PATH, TTL_S));
    res.json({ ok: true, nombre: u.nombre, admin: auth.esAdmin(u) });
  } catch (e) { console.error('login', e.message); res.status(500).json({ ok: false }); }
});
app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', auth.cookieHeader('', COOKIE_PATH, 0));
  res.json({ ok: true });
});

// --- Entrar con Google (públicos) --------------------------------------------------
// El SSO autentica; el acceso lo sigue dando contenido.usuario. Si Google no está configurado,
// la pantalla de login no muestra el botón y todo sigue funcionando con contraseña.
const baseUrl = req => process.env.PANEL_URL ||
  `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const redirectUri = req => `${baseUrl(req)}/auth/google/callback`;

app.get('/api/auth/config', (req, res) => res.json({ google: auth.googleActivo() }));

// --- Definir contraseña sin haber entrado nunca (públicos) -------------------------
// Cierra el círculo: antes la contraseña sólo se podía definir DESDE ADENTRO, así que quien no
// quisiera usar Google no tenía forma de entrar la primera vez.

app.get('/clave', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clave.html')));

/** Valida el enlace antes de mostrar el formulario, para no hacer escribir en vano. */
app.get('/api/clave/estado', async (req, res) => {
  try {
    const u = await db.getUsuarioPorToken(auth.tokenHash(String(req.query.t || '')));
    res.json(u ? { ok: true, email: u.email, nombre: u.nombre } : { ok: false });
  } catch (e) { console.error('clave estado', e.message); res.status(500).json({ ok: false }); }
});

app.post('/api/clave/definir', async (req, res) => {
  try {
    const b = req.body || {};
    const nueva = String(b.nueva || '');
    if (nueva.length < 8) return res.status(400).json({ error: 'datos', mensaje: 'La contraseña necesita 8 caracteres o más.' });
    const u = await db.getUsuarioPorToken(auth.tokenHash(String(b.t || '')));
    if (!u) return res.status(400).json({ error: 'token', mensaje: 'El enlace venció o ya se usó. Pedí uno nuevo.' });
    await db.consumirToken(u.id, auth.hashPassword(nueva));   // un solo uso: el token se quema
    // Lo dejamos adentro directamente: ya probó que controla la casilla.
    db.tocarAcceso(u.id).catch(() => {});
    res.set('Set-Cookie', auth.cookieHeader(auth.issue(u.id), COOKIE_PATH, TTL_S));
    res.json({ ok: true });
  } catch (e) { console.error('clave definir', e.message); res.status(500).json({ error: 'db' }); }
});

/** Olvidé mi contraseña. Responde siempre igual: si dijera "ese mail no existe", cualquiera
 *  podría averiguar quién tiene cuenta. */
app.post('/api/clave/olvide', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim();
    if (email) {
      const u = await db.getUsuarioPorEmail(email);
      if (u) {
        const t = auth.tokenNuevo();
        await db.guardarToken(u.id, auth.tokenHash(t), 1);   // 1 hora: es un reseteo, no una invitación
        const msg = mail.recuperacion({ nombre: u.nombre, url: `${baseUrl(req)}/clave?t=${t}` });
        await mail.enviar(u.email, msg.subject, msg.text, msg.html);
      }
    }
    res.json({ ok: true });
  } catch (e) { console.error('clave olvide', e.message); res.json({ ok: true }); }
});

app.get('/auth/google', (req, res) => {
  // Absoluto: un relativo desde /auth/google resuelve a /auth/login, que no existe.
  if (!auth.googleActivo()) return res.redirect('/login?e=nogoogle');
  const st = auth.estadoNuevo();
  // El estado va en cookie de vida corta: sin esto, un tercero podría plantar un callback.
  res.set('Set-Cookie', `${auth.STATE_COOKIE}=${st}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.redirect(auth.urlDeGoogle(redirectUri(req), st));
});

app.get('/auth/google/callback', async (req, res) => {
  const limpiarEstado = () => res.append('Set-Cookie', `${auth.STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  try {
    if (!auth.googleActivo()) return res.redirect('/login?e=nogoogle');
    const enviado = String(req.query.state || '');
    const guardado = (req.headers.cookie || '').split(';').map(x => x.trim())
      .find(x => x.startsWith(auth.STATE_COOKIE + '='));
    const esperado = guardado ? decodeURIComponent(guardado.slice(auth.STATE_COOKIE.length + 1)) : '';
    if (!enviado || enviado !== esperado || !auth.estadoValido(enviado)) { limpiarEstado(); return res.redirect('/login?e=estado'); }
    if (!req.query.code) { limpiarEstado(); return res.redirect('/login?e=cancelado'); }

    const perfil = await auth.canjearCodigo(String(req.query.code), redirectUri(req));
    limpiarEstado();
    if (!perfil) return res.redirect('/login?e=google');

    const u = await db.getUsuarioPorEmail(perfil.email);
    // Acá está la diferencia con un alta libre: si el mail no fue dado de alta, no entra.
    if (!u) return res.redirect('/login?e=sinacceso&m=' + encodeURIComponent(perfil.email));

    db.tocarAcceso(u.id).catch(() => {});
    res.append('Set-Cookie', auth.cookieHeader(auth.issue(u.id), COOKIE_PATH, TTL_S));
    res.redirect('/');
  } catch (e) { console.error('google', e.message); limpiarEstado(); res.redirect('/login?e=google'); }
});

// Compuerta: todo lo demás (datos, acciones, board) requiere sesión válida Y un usuario vivo.
// La cookie lleva el uid, así que a partir de acá cada request sabe quién pide — que es la
// condición para poder validar el negocio activo contra sus permisos.
app.use(async (req, res, next) => {
  const tok = auth.readToken(auth.readCookie(req));
  if (tok && tok.uid) {
    try {
      const u = await db.getUsuario(tok.uid);
      // Un usuario desactivado o borrado pierde la sesión aunque la cookie siga firmada.
      if (u) { req.usuario = u; return next(); }
    } catch (e) { console.error('sesion', e.message); return res.status(500).json({ error: 'db' }); }
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth' });
  return res.redirect('login');
});

// Quién soy: lo usa el front para saber qué mostrar y qué esconder.
app.get('/api/yo', (req, res) => {
  const u = req.usuario;
  res.json({
    id: u.id, nombre: u.nombre, email: u.email,
    whatsapp: u.whatsapp || '', cargo: u.cargo || '',
    // No devolvemos el hash, sólo si existe: la pantalla necesita saber si pedir la actual.
    tiene_password: !!u.password_hash,
    admin: auth.esAdmin(u),
    // El front lo usa para mandar al onboarding antes de dejar entrar al panel.
    perfil_completo: !!u.perfil_completado_en,
    negocios: auth.esAdmin(u) ? 'todos' : (u.negocios || []).map(n => ({ slug: n.slug, rol: n.rol })),
  });
});

/** Eco de cómo se va a interpretar el número. La salvaguarda real contra un mal parseo es que
 *  la persona lo vea antes de guardar. */
app.get('/api/telefono/eco', async (req, res) => {
  try {
    const v = String(req.query.v || '');
    const ok = !!tel.clave(v);
    // Avisar acá es mejor que fallar al guardar: lo ve mientras escribe.
    const enUso = ok ? await db.whatsappEnUso(v, req.usuario && req.usuario.id) : null;
    res.json({ lindo: tel.lindo(v), norm: tel.normalizar(v), ok, en_uso: !!enUso });
  } catch (e) { console.error('eco tel', e.message); res.status(500).json({ ok: false }); }
});

// Mi cuenta: lo completa la propia persona, no el admin. El WhatsApp lo tipea el dueño del
// número, que es quien lo sabe bien.
app.put('/api/mi-cuenta', async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    const whatsapp = String(b.whatsapp || '').trim();
    if (!nombre) return res.status(400).json({ error: 'datos', mensaje: 'Poné tu nombre.' });
    if (!whatsapp) return res.status(400).json({ error: 'datos', mensaje: 'Poné tu WhatsApp: por ahí te vamos a avisar.' });
    if (!tel.clave(whatsapp)) return res.status(400).json({ error: 'datos', mensaje: 'Ese número no parece válido. Revisalo.' });
    // Un número, un usuario: si estuviera en dos, un mensaje entrante sería de dueño desconocido.
    if (await db.whatsappEnUso(whatsapp, req.usuario.id)) {
      return res.status(409).json({ error: 'duplicado', mensaje: 'Ese número ya está cargado en otra cuenta. Si es tuyo, pedile al administrador que lo libere.' });
    }
    await db.completarPerfil(req.usuario.id, { nombre, whatsapp, cargo: String(b.cargo || '').trim() });
    res.json({ ok: true });
  } catch (e) { console.error('mi-cuenta', e.message); res.status(500).json({ error: 'db' }); }
});

// Contraseña propia: entrar con Google es cómodo, pero no todos lo quieren. El que prefiera
// una contraseña se la define acá, y a partir de ahí tiene las dos puertas.
app.put('/api/mi-cuenta/password', async (req, res) => {
  try {
    const b = req.body || {};
    const nueva = String(b.nueva || '');
    if (nueva.length < 8) {
      return res.status(400).json({ error: 'datos', mensaje: 'La contraseña necesita 8 caracteres o más.' });
    }
    // Si YA tiene una, hay que probar que la sabe: una sesión robada no debería alcanzar para
    // cambiarla. Si no tiene (entró con Google), la define directo.
    const u = await db.getUsuarioPorEmail(req.usuario.email);
    if (u && u.password_hash && !auth.verifyPassword(String(b.actual || ''), u.password_hash)) {
      return res.status(400).json({ error: 'actual', mensaje: 'La contraseña actual no coincide.' });
    }
    await db.actualizarUsuario(req.usuario.id, { password_hash: auth.hashPassword(nueva) });
    res.json({ ok: true });
  } catch (e) { console.error('mi-password', e.message); res.status(500).json({ error: 'db' }); }
});


// --- Marca activa (multi-tenant): cookie cf_marca -> negocio_id en req. Default cortafuego. ---
const MARCA_COOKIE = 'cf_marca';
function readMarca(req) {
  const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(MARCA_COOKIE + '='));
  return c ? decodeURIComponent(c.slice(MARCA_COOKIE.length + 1)) : '';
}
app.use(async (req, res, next) => {
  try {
    // ESTE es el punto que cerraba el agujero: antes se tomaba el slug de la cookie tal cual,
    // así que editarla en el navegador daba acceso al negocio de otro. Ahora se valida contra
    // los permisos del usuario. Al resolverse acá, las 67 rutas que usan req.negocioId quedan
    // cubiertas sin tocarlas una por una.
    const u = req.usuario;
    const admin = auth.esAdmin(u);
    const propios = (u.negocios || []).map(n => n.slug);
    const pedido = readMarca(req);

    let slug;
    if (admin) {
      slug = pedido || 'cortafuego';
    } else if (pedido && propios.includes(pedido)) {
      slug = pedido;
    } else if (propios.length) {
      slug = propios[0];               // pidió uno que no es suyo (o ninguno): cae en el primero propio
    } else {
      return res.status(403).json({ error: 'sin_negocio', mensaje: 'Tu usuario no tiene ningún negocio asignado.' });
    }

    let pid = await db.getProyectoId(slug);
    if (!pid && admin) { slug = 'cortafuego'; pid = await db.getProyectoId('cortafuego'); }
    if (!pid) return res.status(403).json({ error: 'sin_negocio' });

    req.negocio = slug; req.negocioId = pid;
    req.rol = auth.rolEn(u, pid);
    next();
  } catch (e) { console.error('marca', e.message); res.status(500).json({ error: 'marca' }); }
});

// Compuertas reutilizables.
const soloAdmin = (req, res, next) =>
  auth.esAdmin(req.usuario) ? next() : res.status(403).json({ error: 'solo_admin' });
// Aprobar / rechazar / publicar: la compuerta humana de la plataforma.
const soloAprobador = (req, res, next) =>
  auth.puedeAprobar(req.usuario, req.negocioId) ? next() : res.status(403).json({ error: 'sin_permiso' });

// Lista de marcas (para el selector) + cuál está activa en esta sesión.
// --- Usuarios (solo admin) --------------------------------------------------------
app.get('/api/usuarios', soloAdmin, async (req, res) => {
  try { res.json({ usuarios: await db.getUsuarios() }); }
  catch (e) { console.error('usuarios', e.message); res.status(500).json({ error: 'db' }); }
});

app.post('/api/usuarios', soloAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim();
    const nombre = String(b.nombre || '').trim();
    const pw = String(b.password || '');
    if (!email || !nombre) {
      return res.status(400).json({ error: 'datos', mensaje: 'Hacen falta el nombre y el email.' });
    }
    // La contraseña es OPCIONAL: con el SSO andando, un usuario de negocio entra con Google y
    // nunca elige una. Sin hash, verifyPassword() devuelve false y esa vía simplemente no existe
    // para él. El admin puede ponerle una después si hace falta.
    if (pw && pw.length < 8) {
      return res.status(400).json({ error: 'datos', mensaje: 'La contraseña necesita 8 caracteres o más.' });
    }
    if (b.whatsapp && await db.whatsappEnUso(b.whatsapp, null)) {
      return res.status(409).json({ error: 'duplicado', mensaje: 'Ese WhatsApp ya está cargado en otra cuenta.' });
    }
    const id = await db.crearUsuario({
      email, nombre,
      password_hash: pw ? auth.hashPassword(pw) : null,
      rol_plataforma: b.rol_plataforma === 'admin' ? 'admin' : 'usuario',
      telegram_chat_id: b.telegram_chat_id, whatsapp: b.whatsapp,
    });
    if (Array.isArray(b.negocios)) await db.setNegociosDeUsuario(id, b.negocios);

    // Invitación: best-effort. Si el mail falla, el usuario YA quedó creado y con acceso —
    // lo que no puede pasar es que un problema de correo haga fracasar el alta.
    let invitacion = { ok: false, motivo: 'no_solicitada' };
    if (b.invitar !== false) {
      const slugs = (await db.getNegocios())
        .filter(n => (b.negocios || []).some(x => x.negocio_id === n.id))
        .map(n => n.nombre);
      // 7 días para la invitación: es un alta, no una urgencia.
      const t = auth.tokenNuevo();
      await db.guardarToken(id, auth.tokenHash(t), 24 * 7);
      const msg = mail.invitacion({ nombre, negocios: slugs, urlClave: `${baseUrl(req)}/clave?t=${t}` });
      invitacion = await mail.enviar(email, msg.subject, msg.text, msg.html);
      if (invitacion.ok) await db.marcarInvitado(id);
    }
    res.json({ ok: true, id, invitacion });
  } catch (e) {
    if (String(e.message).includes('idx_usuario_email')) {
      return res.status(409).json({ error: 'duplicado', mensaje: 'Ya existe un usuario con ese email.' });
    }
    console.error('crear usuario', e.message); res.status(500).json({ error: 'db' });
  }
});

// Reenviar la invitación: para el que nunca entró, o si el mail se perdió.
// OJO: tiene que quedar DESPUÉS de la declaración de soloAdmin — `const` no se hoistea y el
// proceso muere al arrancar. `node --check` no lo detecta: es error de ejecución, no de sintaxis.
app.post('/api/usuarios/:id/invitar', soloAdmin, async (req, res) => {
  try {
    const u = await db.getUsuario(String(req.params.id));
    if (!u) return res.status(404).json({ error: 'no_existe' });
    const t = auth.tokenNuevo();
    await db.guardarToken(u.id, auth.tokenHash(t), 24 * 7);   // reenviar invalida el enlace anterior
    const msg = mail.invitacion({ nombre: u.nombre, negocios: (u.negocios || []).map(n => n.slug),
                                  urlClave: `${baseUrl(req)}/clave?t=${t}` });
    const r = await mail.enviar(u.email, msg.subject, msg.text, msg.html);
    if (r.ok) await db.marcarInvitado(u.id);
    res.json(r.ok ? { ok: true } : { error: 'mail', mensaje: 'No se pudo enviar: ' + r.motivo });
  } catch (e) { console.error('invitar', e.message); res.status(500).json({ error: 'db' }); }
});

app.put('/api/usuarios/:id', soloAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(req.params.id);
    // Un admin no puede quitarse a sí mismo el rol ni desactivarse: sería quedarse afuera.
    if (id === req.usuario.id && (b.rol_plataforma === 'usuario' || b.activo === false)) {
      return res.status(400).json({ error: 'auto', mensaje: 'No podés quitarte a vos mismo el acceso de administrador.' });
    }
    const pw = String(b.password || '');
    if (pw && pw.length < 8) return res.status(400).json({ error: 'datos', mensaje: 'La contraseña necesita 8 caracteres o más.' });
    if (b.whatsapp && await db.whatsappEnUso(b.whatsapp, id)) {
      return res.status(409).json({ error: 'duplicado', mensaje: 'Ese WhatsApp ya está cargado en otra cuenta.' });
    }
    await db.actualizarUsuario(id, {
      nombre: b.nombre, rol_plataforma: b.rol_plataforma,
      telegram_chat_id: b.telegram_chat_id, whatsapp: b.whatsapp, activo: b.activo,
      password_hash: pw ? auth.hashPassword(pw) : undefined,
    });
    if (Array.isArray(b.negocios)) await db.setNegociosDeUsuario(id, b.negocios);
    res.json({ ok: true });
  } catch (e) { console.error('editar usuario', e.message); res.status(500).json({ error: 'db' }); }
});

app.get('/api/negocios', async (req, res) => {
  try {
    // Un usuario de negocio sólo ve los suyos en el selector.
    const admin = auth.esAdmin(req.usuario);
    const propios = new Set((req.usuario.negocios || []).map(n => n.slug));
    const negocios = (await db.getNegocios())
      .filter(m => admin || propios.has(m.slug))
      // `id` lo necesita la pantalla de usuarios para asignar negocios. Es aditivo: los demás
      // consumidores siguen leyendo por slug.
      .map(m => ({ id: m.id, slug: m.slug, nombre: m.nombre, activo: m.activo, logo: m.logo, prefijo: m.prefijo }));
    res.json({ negocios, activa: req.negocio });
  } catch (e) { console.error('marcas', e.message); res.status(500).json({ error: 'db' }); }
});

// Dashboard de la Agencia: todos los proyectos con descripción + indicadores (no scopeado a una marca).
app.get('/api/agencia', soloAdmin, async (req, res) => {
  try { res.json(await db.getResumenAgencia()); }
  catch (e) { console.error('agencia', e.message); res.status(500).json({ error: 'db' }); }
});

// Cambia la marca activa de la sesión (valida contra las marcas conocidas).
app.post('/api/negocio', async (req, res) => {
  const slug = String((req.body && req.body.slug) || '');
  const ok = (await db.getNegocios()).some(m => m.slug === slug);
  if (!ok) return res.status(400).json({ ok: false, error: 'negocio_invalido' });
  res.set('Set-Cookie', `${MARCA_COOKIE}=${encodeURIComponent(slug)}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_S}`);
  res.json({ ok: true });
});

// Llama al webhook de n8n y devuelve el status HTTP. Timeout amplio: el publish sube media y poolea.
// Reintenta ante fallo de RED/DNS (el hostname de n8n resuelve intermitentemente desde el
// contenedor -> EAI_AGAIN / "fetch failed"). No reintenta si n8n responde un status HTTP
// (eso no lanza): un rechazo real se respeta. Sólo los errores de conexión se reintentan.
async function callWebhook(url, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
      return r.status;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

app.get('/api/piezas', async (req, res) => {
  try {
    const canal = ['instagram', 'aviso'].includes(req.query.canal) ? req.query.canal : undefined;
    res.json(await db.getPiezas(canal, req.negocioId));
  } catch (e) { console.error('piezas', e.message); res.status(500).json({ error: 'db' }); }
});

app.get('/api/requerimientos', async (req, res) => {
  try { res.json(await db.getRequerimientos(req.negocioId)); }
  catch (e) { console.error('requerimientos', e.message); res.status(500).json({ error: 'db' }); }
});

app.get('/api/status', async (req, res) => {
  try { res.json(await db.getStatus(req.negocioId)); }
  catch (e) { console.error('status', e.message); res.status(500).json({ error: 'db' }); }
});

// Sala de máquinas: pulso del motor (pipeline agregado + latido de procesos). No scopeado a una marca.
app.get('/api/maquinas', soloAdmin, async (req, res) => {
  try { res.json(await db.getMaquinas()); }
  catch (e) { console.error('maquinas', e.message); res.status(500).json({ error: 'db' }); }
});

// Perfil del proyecto (registro de marca, por marca activa). Lo consume el creativo.
// Capacidades de la marca activa: qué funcionalidades usa (habilitada) y si están configuradas.
app.get('/api/capacidades', async (req, res) => {
  try { res.json(await db.getCapacidades(req.negocioId)); }
  catch (e) { console.error('capacidades', e.message); res.status(500).json({ error: 'db' }); }
});
// Generar/regenerar el estilo, y el manual de marca (jobs del creativo).
app.post('/api/estilo/generar', async (req, res) => {
  try {
    const r = await db.pedirGeneracion(req.negocioId, 'estilo');
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { console.error('estilo-gen', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
app.post('/api/manual/generar', async (req, res) => {
  try {
    const r = await db.pedirGeneracion(req.negocioId, 'manual');
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { console.error('manual-gen', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
app.get('/api/generacion', async (req, res) => {
  try { res.json(await db.getGeneracion(req.negocioId)); }
  catch (e) { console.error('generacion', e.message); res.status(500).json({ error: 'db' }); }
});

// --- Gráfica: material promocional (folletos, afiches, vía pública) ---
app.get('/api/grafica/formatos', (req, res) => res.json(db.FORMATOS));
app.get('/api/grafica', async (req, res) => {
  try { res.json(await db.getGraficas(req.negocioId)); }
  catch (e) { console.error('grafica', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/grafica/:id', async (req, res) => {
  try {
    const g = await db.getGrafica(req.negocioId, req.params.id);
    if (!g) return res.status(404).json({ error: 'no_existe' });
    res.json(g);
  } catch (e) { console.error('grafica-get', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/grafica', async (req, res) => {
  try {
    const r = await db.crearGrafica(req.negocioId, req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { console.error('grafica-crear', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
// Iterar: nueva versión con la instrucción de cambio (parte del diseño anterior).
app.post('/api/grafica/:id/iterar', async (req, res) => {
  try {
    const r = await db.iterarGrafica(req.negocioId, req.params.id, req.body || {});
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { console.error('grafica-iterar', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
app.post('/api/grafica/:id/estado', soloAprobador, async (req, res) => {
  try { res.json(await db.estadoGrafica(req.negocioId, req.params.id, (req.body || {}).estado)); }
  catch (e) { console.error('grafica-estado', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
// Fondo subido desde disco para una pieza.
app.post('/api/grafica/fondo', async (req, res) => {
  try {
    const { mediaPath } = await guardarMaterialDisco(req.body, path.posix.join('grafica', req.negocio));
    res.json({ ok: true, url: `https://${req.get('host')}/media/` + mediaPath.split('/').map(encodeURIComponent).join('/') });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});

// Salud del sistema: última verificación de integridad (cron cada 30 min).
app.get('/api/verificacion', soloAdmin, async (req, res) => {
  try { res.json(await db.getVerificacion() || { chequeos: [], cuando: null }); }
  catch (e) { console.error('verificacion', e.message); res.status(500).json({ error: 'db' }); }
});

// Lente de Instagram: config de PLATAFORMA (la agencia, no una marca). El token se guarda
// cifrado y es write-only: nunca vuelve al navegador (solo decimos si está cargado).
app.get('/api/plataforma/lente', soloAdmin, async (req, res) => {
  try { res.json(await db.getLente()); }
  catch (e) { console.error('lente', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/plataforma/lente', soloAdmin, async (req, res) => {
  try {
    const r = await db.guardarLente(req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { console.error('lente-set', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
// Probar la lente contra Instagram: confirma que el token anda ANTES de que falle un alta.
app.post('/api/plataforma/lente/probar', soloAdmin, async (req, res) => {
  try {
    const { ig_lente_id } = await db.getLente();
    const tok = await db.getLenteToken();
    if (!ig_lente_id || !tok) return res.json({ ok: false, error: 'Falta la cuenta o el token' });
    const r = await fetch(`https://graph.facebook.com/v21.0/${ig_lente_id}` +
      `?fields=username,followers_count&access_token=${encodeURIComponent(tok)}`).then(x => x.json());
    if (r.error) return res.json({ ok: false, error: String(r.error.message).slice(0, 140) });
    res.json({ ok: true, username: r.username, followers: r.followers_count });
  } catch (e) { res.json({ ok: false, error: 'No se pudo consultar a Instagram' }); }
});

// Descubrimiento: analizar la presencia digital pública de una marca que todavía no existe,
// para pre-cargar el wizard. El análisis lo hace un job (worker); acá solo encolamos y consultamos.
app.post('/api/negocios/descubrir', soloAdmin, async (req, res) => {
  try {
    const r = await db.crearDescubrimiento(req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { console.error('descubrir', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
app.get('/api/negocios/descubrir/:id', soloAdmin, async (req, res) => {
  try {
    const d = await db.getDescubrimiento(req.params.id);
    if (!d) return res.status(404).json({ error: 'no_existe' });
    res.json(d);
  } catch (e) { console.error('descubrir-get', e.message); res.status(500).json({ error: 'db' }); }
});

// Alta de marca (wizard "Sumá una marca").
app.post('/api/negocios/crear', soloAdmin, async (req, res) => {
  try {
    const r = await db.crearNegocio(req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { console.error('crear-marca', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Grilla de agencia: todas las marcas y qué tiene configurada cada una (cross-marca).
app.get('/api/capacidades/todas', soloAdmin, async (req, res) => {
  try { res.json(await db.getCapacidadesTodas()); }
  catch (e) { console.error('capacidades-todas', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/capacidades/:cap', soloAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await db.setCapacidad(req.negocioId, req.params.cap, { habilitada: !!b.habilitada, config: b.config });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { console.error('capacidad-set', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// --- WhatsApp del negocio (v2.0 / F5d) ----------------------------------------------------
app.get('/api/whatsapp/config', async (req, res) => {
  try { res.json(await db.getWhatsappNegocio(req.negocioId) || {}); }
  catch (e) { console.error('wa config', e.message); res.status(500).json({ error: 'db' }); }
});
app.put('/api/whatsapp/config', async (req, res) => {
  try { res.json(await db.guardarWhatsappNegocio(req.negocioId, req.body || {})); }
  catch (e) {
    if (e.code === 'no_enc_key') return res.status(409).json({ ok: false, error: e.code });
    console.error('wa guardar', e.message); res.status(500).json({ ok: false, error: 'db' });
  }
});
app.post('/api/whatsapp/verificar', async (req, res) => {
  try { res.json(await db.verificarWhatsappNegocio(req.negocioId)); }
  catch (e) { console.error('wa verificar', e.message); res.status(500).json({ error: 'db' }); }
});

// --- Canal de WhatsApp: configurador e inbox (v2.0 / F5f) ---------------------------------
app.get('/api/whatsapp/canal', async (req, res) => {
  try {
    res.json({ config: await db.getCanalWhatsapp(req.negocioId), disponibles: db.CAPS_BOT });
  } catch (e) { console.error('wa canal', e.message); res.status(500).json({ error: 'db' }); }
});
app.put('/api/whatsapp/canal', async (req, res) => {
  try { res.json(await db.guardarCanalWhatsapp(req.negocioId, req.body || {})); }
  catch (e) { console.error('wa canal guardar', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Borradores de respuestas frecuentes. El modelo pone las PREGUNTAS (las conoce del rubro) y sólo
// contesta las que puede fundar en datos del negocio; el resto las deja vacías, que es la forma de
// mostrarle a Fer qué falta cargar. No se guarda nada acá: eso lo decide una persona en la pantalla.
app.post('/api/whatsapp/faq/sugerir', async (req, res) => {
  try {
    if (!faq.disponible()) return res.status(503).json({ error: 'sin_clave' });
    res.json({ entradas: await faq.sugerir(await db.fichaNegocio(req.negocioId)) || [] });
  } catch (e) { console.error('faq sugerir', e.message); res.status(500).json({ error: 'ia' }); }
});

// --- Invitaciones (v2.0 / F6) --------------------------------------------------------------
app.get('/api/invitaciones/beneficios', async (req, res) => {
  try {
    const bs = await db.getBeneficios(req.negocioId);
    res.json({
      // El texto se arma en el servidor y no en la pantalla: el mismo beneficio se muestra igual
      // en el panel, en la página pública y en WhatsApp, y hay una sola versión de esa frase.
      beneficios: bs.map(b => ({ ...b, texto: db.textoBeneficio(b) })),
      tipos: db.TIPOS_BENEFICIO,
      turnos: (await db.getTurnos(req.negocioId)).filter(t => t.activo),
    });
  } catch (e) { console.error('beneficios', e.message); res.status(500).json({ error: 'db' }); }
});

const guardarBen = async (req, res) => {
  try {
    const b = await db.guardarBeneficio(req.negocioId, req.params.id || null, req.body || {});
    res.json({ ok: true, beneficio: b });
  } catch (e) {
    // El motivo va al frente: "no se pudo guardar" obliga a adivinar cuál de los campos falló.
    const msg = { falta_nombre: 'Poné un nombre.', tipo_invalido: 'Elegí un tipo.',
                  valor_invalido: 'El valor no es válido (el porcentaje no puede pasar de 100).',
                  no_encontrado: 'Ese beneficio no existe.' }[e.code];
    if (msg) return res.status(400).json({ ok: false, mensaje: msg });
    console.error('beneficio guardar', e.message); res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
};
app.post('/api/invitaciones/beneficios', guardarBen);
app.put('/api/invitaciones/beneficios/:id', guardarBen);

// Ver cómo va a quedar la invitación ANTES de emitir códigos e imprimirlos. Devuelve lo mismo
// que el pase real, armado desde el beneficio, con un código de mentira bien marcado: descubrir
// que el frente o las condiciones estaban mal después de la tirada sale caro.
app.get('/api/invitaciones/beneficios/:id/muestra', async (req, res) => {
  try {
    const m = await db.muestraBeneficio(req.negocioId, String(req.params.id));
    if (!m) return res.status(404).json({ ok: false, mensaje: 'Ese beneficio no existe.' });
    res.json(m);
  } catch (e) { console.error('muestra beneficio', e.message); res.status(500).json({ ok: false }); }
});
app.get('/pase/muestra/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'publico', 'pase.html'));
});

app.get('/api/invitaciones/piezas', async (req, res) => {
  try { res.json({ piezas: await db.piezasPublicadas(req.negocioId) }); }
  catch (e) { console.error('piezas', e.message); res.status(500).json({ error: 'db' }); }
});

app.get('/api/invitaciones', async (req, res) => {
  try {
    const is = await db.getInvitaciones(req.negocioId, { beneficio_id: req.query.beneficio_id });
    res.json({ invitaciones: is.map(i => ({ ...i, texto: db.textoBeneficio(i) })) });
  } catch (e) { console.error('invitaciones', e.message); res.status(500).json({ error: 'db' }); }
});

app.post('/api/invitaciones/emitir', async (req, res) => {
  try {
    res.json({ ok: true, invitaciones: await db.emitirInvitaciones(req.negocioId, req.body || {}) });
  } catch (e) {
    if (e.code === 'beneficio_invalido') return res.status(400).json({ ok: false, mensaje: 'Elegí un beneficio.' });
    if (e.code === 'vence_pasado') return res.status(400).json({ ok: false,
      mensaje: 'Esa fecha de vencimiento ya pasó: los códigos nacerían vencidos.' });
    console.error('emitir', e.message); res.status(500).json({ ok: false, mensaje: 'Error del servidor.' });
  }
});

app.post('/api/invitaciones/:id/anular', async (req, res) => {
  try { res.json(await db.anularInvitacion(req.negocioId, req.params.id)); }
  catch (e) { console.error('anular', e.message); res.status(500).json({ ok: false }); }
});

app.get('/api/whatsapp/inbox', async (req, res) => {
  try { res.json({ conversaciones: await db.getInbox(req.negocioId) }); }
  catch (e) { console.error('wa inbox', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/whatsapp/inbox/:waId', async (req, res) => {
  try { res.json({ mensajes: await db.getConversacionInbox(req.negocioId, req.params.waId) }); }
  catch (e) { console.error('wa conversacion', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/whatsapp/inbox/:waId/atendido', async (req, res) => {
  try { res.json(await db.marcarAtendido(req.negocioId, req.params.waId)); }
  catch (e) { console.error('wa atendido', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
// Responder a mano. Sólo funciona DENTRO de la ventana de 24 h; fuera de ella Meta exige
// plantilla, y devolvemos el motivo para que la pantalla lo pueda decir.
app.post('/api/whatsapp/inbox/:waId/responder', async (req, res) => {
  try {
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ ok: false, error: 'sin_texto' });
    const cfgWa = await db.getWhatsappNegocio(req.negocioId, true);
    if (!cfgWa || !cfgWa.wa_phone_id || !cfgWa.token) {
      return res.status(409).json({ ok: false, error: 'sin_numero' });
    }
    const r = await wa.enviarTexto(req.params.waId, texto,
      { phone_id: cfgWa.wa_phone_id, token: cfgWa.token });
    await db.logWhatsapp({
      direccion: 'saliente', wa_id: req.params.waId, usuario_id: req.usuario.id,
      negocio_id: req.negocioId, mensaje_id: r.id, tipo: 'text', texto,
      estado: r.ok ? 'enviado' : 'error',
    });
    if (r.ok) await db.marcarAtendido(req.negocioId, req.params.waId);
    res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true } : { ok: false, error: 'envio', detalle: r.motivo });
  } catch (e) { console.error('wa responder', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// --- Avisos de reserva por WhatsApp (v2.0 / F5c) ------------------------------------------
// NUNCA en el camino crítico: la reserva ya está tomada cuando esto corre. Si WhatsApp falla, se
// registra y se sigue — perder el aviso es molesto, perder la reserva es grave.
const DIAS_SEM = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function cuandoLegible(fecha, turno, hora) {
  const d = new Date(fecha + 'T12:00:00');
  return `${DIAS_SEM[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}, ${turno} ${hora}`;
}
const UNI_PLUR = { personas:'personas', cubiertos:'cubiertos', canchas:'canchas',
                   mesas:'mesas', lugares:'lugares', cupos:'cupos' };

async function avisarReserva(reservaId, quien) {
  try {
    const r = await db.datosParaAviso(reservaId);
    if (!r) return;
    const cuando = cuandoLegible(r.fecha, r.turno, r.hora_desde);
    const cantidad = `${r.cantidad} ${UNI_PLUR[r.unidad] || 'personas'}`;
    let envios = [];
    if (quien === 'negocio') {
      const dest = await db.destinatariosAviso(r.negocio_id);
      envios = dest.map(u => wa.enviarPlantilla(u.whatsapp, 'reserva_nueva',
        [r.negocio, r.cliente || 'sin nombre', cuando, cantidad]));
    } else if (quien === 'cliente' && r.cliente_telefono) {
      // Al cliente final se le escribe desde el número DEL NEGOCIO: tiene que ver el nombre del
      // lugar donde reservó. Si el negocio todavía no tiene el suyo, no se le escribe — mandarle
      // un mensaje de "ClaUsina" a un comensal es la forma más rápida de que lo reporte.
      const cfg = await db.getWhatsappNegocio(r.negocio_id, true);
      if (!cfg || !cfg.wa_phone_id || !cfg.token) {
        console.log(`aviso cliente reserva ${reservaId}: el negocio no tiene WhatsApp propio`);
        return;
      }
      envios = [wa.enviarPlantilla(r.cliente_telefono, 'reserva_confirmada',
        [r.negocio, cuando, cantidad], 'es_AR', { phone_id: cfg.wa_phone_id, token: cfg.token })];
    }
    if (!envios.length) { console.log(`aviso ${quien} reserva ${reservaId}: sin destinatarios`); return; }
    const res = await Promise.all(envios);
    const fallas = res.filter(x => !x.ok).map(x => x.motivo);
    console.log(`aviso ${quien} reserva ${reservaId}: ${res.filter(x => x.ok).length}/${res.length} enviados` +
      (fallas.length ? ` — fallas: ${fallas.join(' | ')}` : ''));
  } catch (e) { console.error('avisarReserva', e.message); }
}

// --- Reservas (v2.0 / F4) ---------------------------------------------------------------
const RES_ERR = new Set(['cantidad_fuera','fecha_invalida','turno_invalido',
  'turno_no_aplica','muy_pronto','muy_lejos','bloqueado','sin_lugar','sin_cliente',
  'cliente_invalido','sin_nombre','sin_dias','horario_invalido','ya_bloqueado','con_reservas',
  'estado_invalido']);
const resError = (res, e, donde) => {
  if (RES_ERR.has(e.code)) return res.status(409).json({ ok: false, error: e.code, detalle: e.detalle });
  console.error(donde, e.message);
  return res.status(500).json({ ok: false, error: 'db' });
};
const hoyISO = () => new Date().toISOString().slice(0, 10);
const masDias = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// Ventana pedida, acotada: una consulta de dos años se convierte en un cálculo enorme por gusto.
function rango(req, porDefecto = 42) {
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : hoyISO();
  let hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : masDias(desde, porDefecto);
  if (hasta > masDias(desde, 366)) hasta = masDias(desde, 366);
  if (hasta < desde) hasta = desde;
  return { desde, hasta };
}

app.get('/api/reservas/config', async (req, res) => {
  try {
    const [cfg, turnos] = await Promise.all([db.getConfigReservas(req.negocioId), db.getTurnos(req.negocioId)]);
    res.json({ config: cfg, turnos, unidades: db.UNIDADES });
  } catch (e) { console.error('reservas-config', e.message); res.status(500).json({ error: 'db' }); }
});
app.put('/api/reservas/config', async (req, res) => {
  try { res.json(await db.guardarConfigReservas(req.negocioId, req.body || {}, auth.esAdmin(req.usuario))); }
  catch (e) { resError(res, e, 'guardar config reservas'); }
});
app.post('/api/reservas/turnos', async (req, res) => {
  try { res.json(await db.guardarTurno(req.negocioId, null, req.body || {})); }
  catch (e) { resError(res, e, 'crear turno'); }
});
app.put('/api/reservas/turnos/:id', async (req, res) => {
  try {
    const r = await db.guardarTurno(req.negocioId, req.params.id, req.body || {});
    res.status(r.ok ? 200 : 404).json(r);
  } catch (e) { resError(res, e, 'editar turno'); }
});
app.delete('/api/reservas/turnos/:id', async (req, res) => {
  try {
    const r = await db.borrarTurno(req.negocioId, req.params.id);
    res.status(r.ok ? 200 : 404).json(r);
  } catch (e) { resError(res, e, 'borrar turno'); }
});

app.put('/api/landing/expone', async (req, res) => {
  try { res.json(await db.guardarQueExponeLanding(req.negocioId, req.body || {})); }
  catch (e) {
    if (e.code === 'sin_landing') return res.status(409).json({ ok: false, error: e.code });
    console.error('landing expone', e.message); res.status(500).json({ ok: false, error: 'db' });
  }
});

// --- Enlaces de acción (v2.0 / F5) -------------------------------------------------------
app.get('/api/acciones', async (req, res) => {
  try { res.json({ links: await db.getLinks(req.negocioId), piezas: await db.getPiezasParaAccion(req.negocioId) }); }
  catch (e) { console.error('acciones', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/acciones', async (req, res) => {
  try { res.json(await db.crearLink(req.negocioId, req.body || {})); }
  catch (e) { resError(res, e, 'crear accion'); }
});
app.post('/api/acciones/:id/activo', async (req, res) => {
  try {
    const r = await db.setLinkActivo(req.negocioId, req.params.id, (req.body || {}).activo);
    res.status(r.ok ? 200 : 404).json(r);
  } catch (e) { resError(res, e, 'activo accion'); }
});

app.get('/api/reservas/bloqueos', async (req, res) => {
  try { const { desde, hasta } = rango(req, 120); res.json({ bloqueos: await db.getBloqueos(req.negocioId, desde, hasta) }); }
  catch (e) { console.error('bloqueos', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/reservas/bloqueos', async (req, res) => {
  try { res.json(await db.crearBloqueo(req.negocioId, req.body || {})); }
  catch (e) { resError(res, e, 'crear bloqueo'); }
});
app.delete('/api/reservas/bloqueos/:id', async (req, res) => {
  try {
    const r = await db.borrarBloqueo(req.negocioId, req.params.id);
    res.status(r.ok ? 200 : 404).json(r);
  } catch (e) { resError(res, e, 'borrar bloqueo'); }
});

app.get('/api/reservas/disponibilidad', async (req, res) => {
  try { const { desde, hasta } = rango(req); res.json({ desde, hasta, dias: await db.getDisponibilidad(req.negocioId, desde, hasta) }); }
  catch (e) { console.error('disponibilidad', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/reservas', async (req, res) => {
  try {
    const { desde, hasta } = rango(req);
    res.json({ reservas: await db.getReservas(req.negocioId, { desde, hasta, estado: req.query.estado }) });
  } catch (e) { console.error('reservas', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/reservas', async (req, res) => {
  try { res.json(await db.crearReserva(req.negocioId, req.body || {})); }
  catch (e) { resError(res, e, 'crear reserva'); }
});
// Marcar que la invitación se aplicó de verdad. Lo hace una persona del salón: es el segundo
// momento —el de la cuenta— que ClaUsina no puede ver y por eso alguien tiene que confirmarlo.
app.post('/api/reservas/:id/invitacion', async (req, res) => {
  try {
    const u = await db.invitacionDeReserva(req.params.id);
    if (!u) return res.status(404).json({ ok: false, mensaje: 'Esa reserva no tiene invitación.' });
    res.json(await db.cerrarUso(req.negocioId, u.uso_id, (req.body || {}).estado, (req.body || {}).notas));
  } catch (e) {
    if (e.code === 'estado_invalido') return res.status(400).json({ ok: false });
    console.error('uso invitacion', e.message); res.status(500).json({ ok: false });
  }
});

// La tarjeta de la reserva: una imagen que cierra el circuito por WhatsApp. La dibuja el
// navegador y la fotografía el host (scripts/tarjeta_job.sh); acá sólo viven la página y sus
// datos, para que el diseño se pueda mirar y corregir en el panel como cualquier otra pantalla.
app.get('/tarjeta/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'publico', 'tarjeta.html'));
});
app.get('/api/reservas/:id/tarjeta', async (req, res) => {
  try {
    const t = await db.reservaTarjeta(req.negocioId, String(req.params.id));
    if (!t) return res.status(404).json({ ok: false, error: 'no existe esa reserva' });
    res.json(t);
  } catch (e) { console.error('tarjeta', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

app.post('/api/reservas/:id/estado', async (req, res) => {
  try {
    const estado = (req.body || {}).estado;
    const r = await db.cambiarEstadoReserva(req.negocioId, req.params.id, estado);
    // Al cliente se le avisa sólo cuando su pedido pasa a confirmado: es la respuesta que
    // está esperando. Los otros cambios de estado son internos del negocio.
    if (r.ok && estado === 'confirmada') setImmediate(() => avisarReserva(req.params.id, 'cliente'));
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { resError(res, e, 'estado reserva'); }
});

// --- Clientes (v2.0 / F3) ---------------------------------------------------------------
// Todo pasa por req.negocioId, que el middleware ya validó contra los permisos del usuario:
// no hay forma de leer ni tocar la base de otro negocio desde acá.
app.get('/api/clientes', async (req, res) => {
  try { res.json(await db.getClientes(req.negocioId, { q: req.query.q, limit: req.query.limit, offset: req.query.offset })); }
  catch (e) { console.error('clientes', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/clientes', async (req, res) => {
  try { res.json(await db.crearCliente(req.negocioId, req.body || {})); }
  catch (e) {
    if (e.code === 'tel_repetido' || e.code === 'sin_datos') return res.status(409).json({ ok: false, error: e.code });
    console.error('crear cliente', e.message); res.status(500).json({ ok: false, error: 'db' });
  }
});
app.put('/api/clientes/:id', async (req, res) => {
  try {
    const r = await db.actualizarCliente(req.negocioId, req.params.id, req.body || {});
    res.status(r.ok ? 200 : 404).json(r);
  } catch (e) {
    if (e.code === 'tel_repetido' || e.code === 'sin_datos') return res.status(409).json({ ok: false, error: e.code });
    console.error('actualizar cliente', e.message); res.status(500).json({ ok: false, error: 'db' });
  }
});
app.delete('/api/clientes/:id', async (req, res) => {
  try {
    const r = await db.borrarCliente(req.negocioId, req.params.id, req.query.con_reservas === '1');
    res.status(r.ok ? 200 : 404).json(r);
  } catch (e) {
    // Tiene reservas: no es un error del sistema, es una decisión que le toca a quien borra.
    if (e.code === 'con_reservas') return res.status(409).json({ ok: false, error: e.code, detalle: e.detalle });
    console.error('borrar cliente', e.message); res.status(500).json({ ok: false, error: 'db' });
  }
});
// Exportar: contracara de "los datos son del negocio". Cualquiera que vea el negocio puede
// llevarse su base; no es una operación privilegiada, es un derecho del dueño del dato.
app.get('/api/clientes/exportar', async (req, res) => {
  try {
    const csv = await db.exportarClientes(req.negocioId);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="clientes-${req.negocio || 'negocio'}.csv"`);
    res.send(csv);
  } catch (e) { console.error('exportar clientes', e.message); res.status(500).json({ error: 'db' }); }
});
// Borrado en bloque (el negocio se va). Solo admin y con confirmación explícita del slug:
// un borrado de toda la base de un cliente no puede depender de un solo clic.
app.post('/api/clientes/borrar-todo', soloAdmin, async (req, res) => {
  try {
    if (String((req.body || {}).confirmar || '') !== req.negocio) {
      return res.status(400).json({ ok: false, error: 'confirmacion_invalida' });
    }
    res.json(await db.borrarTodosLosClientes(req.negocioId));
  } catch (e) { console.error('borrar todos los clientes', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Perfil se absorbió dentro de Identidad (v2.0 / F2). El archivo perfil.html sigue en disco pero
// ya no se navega: esto evita que un enlace viejo o un favorito caigan en una página huérfana.
app.get('/perfil', (req, res) => res.redirect(301, '/identidad'));

// Identidad estructurada (v2.0 / F1). Los catálogos son públicos dentro del panel; la ficha va
// scopeada por negocio como todo el resto (el middleware ya resolvió req.negocioId).
app.get('/api/identidad/catalogos', async (req, res) => {
  try { res.json(await db.getCatalogosIdentidad()); }
  catch (e) { console.error('identidad-catalogos', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/identidad', async (req, res) => {
  try { res.json(await db.getIdentidad(req.negocioId)); }
  catch (e) { console.error('identidad', e.message); res.status(500).json({ error: 'db' }); }
});
app.put('/api/identidad', async (req, res) => {
  try { res.json(await db.guardarIdentidad(req.negocioId, req.body || {}, req.usuario && req.usuario.id)); }
  catch (e) { console.error('guardar identidad', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});
// Qué atributos se le ofrecen a cada rubro. Config de plataforma, no de un negocio.
app.put('/api/identidad/atributo-mapeo', soloAdmin, async (req, res) => {
  try {
    const { codigo, actividades } = req.body || {};
    if (!codigo) return res.status(400).json({ ok: false, error: 'falta_codigo' });
    res.json(await db.setMapeoAtributo(String(codigo), actividades));
  } catch (e) {
    console.error('atributo-mapeo', e.message);
    res.status(e.code === 'no_existe' ? 404 : 500).json({ ok: false, error: e.code || 'db' });
  }
});

// Geocodificación de sedes contra Nominatim (OpenStreetMap): sin clave y sin costo. Su política
// pide User-Agent identificable y un pedido por segundo — se cumple porque lo dispara una persona
// apretando un botón, de a una sede. El resultado NO se guarda solo: se propone y alguien confirma.
let _geoUltimo = 0;

// Muchas direcciones reales son ESQUINAS ("Av. Valentín Vergara 3200 y Calle 32", "Robles 6414
// esq. Las Flores") y Nominatim no las parsea: devuelve cero resultados. En vez de rendirse, se
// prueban variantes cada vez menos precisas y se etiqueta cada resultado con la que lo encontró,
// para que quien elige sepa si está mirando el número exacto o sólo la cuadra.
function variantesGeo(q) {
  const partes = q.split(',').map(s => s.trim()).filter(Boolean);
  const calle = partes[0] || '';
  const resto = partes.slice(1);
  const vs = [{ q, precision: 'exacta' }];
  const sinEsquina = calle.replace(/\s+(y|esq\.?|esquina)\s+.*$/i, '').trim();
  if (sinEsquina && sinEsquina !== calle) {
    vs.push({ q: [sinEsquina, ...resto].join(', '), precision: 'sin la esquina' });
  }
  const sinNumero = sinEsquina.replace(/\s*\d[\d/.-]*\s*$/, '').trim();
  if (sinNumero && sinNumero !== sinEsquina) {
    vs.push({ q: [sinNumero, ...resto].join(', '), precision: 'calle, sin altura' });
  }
  if (resto.length) vs.push({ q: resto.join(', '), precision: 'solo la localidad' });
  return vs;
}

async function pedirNominatim(q) {
  const espera = 1100 - (Date.now() - _geoUltimo);
  if (espera > 0) await new Promise(r => setTimeout(r, espera));
  _geoUltimo = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ar&q='
    + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': 'ClaUsina/1.0 (panel.clausina.ar)' } });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  return await r.json();
}

app.get('/api/geocodificar', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 5) return res.status(400).json({ error: 'consulta_corta' });
  try {
    for (const v of variantesGeo(q)) {
      const datos = await pedirNominatim(v.q);
      if (datos && datos.length) {
        return res.json({
          consulta: v.q, precision: v.precision,
          resultados: datos.map(d => ({
            nombre: d.display_name, lat: Number(d.lat), lon: Number(d.lon),
            tipo: d.type, precision: v.precision,
          })),
        });
      }
    }
    res.json({ resultados: [] });
  } catch (e) { console.error('geocodificar', e.message); res.status(502).json({ error: 'geocodificador' }); }
});

app.get('/api/perfil', async (req, res) => {
  try { res.json(await db.getPerfil(req.negocioId)); }
  catch (e) { console.error('perfil', e.message); res.status(500).json({ error: 'db' }); }
});
app.put('/api/perfil', async (req, res) => {
  try { res.json({ ok: await db.guardarPerfil(req.negocioId, req.body || {}) }); }
  catch (e) { console.error('guardar perfil', e.message); res.status(500).json({ ok: false, error: e.code || 'db' }); }
});

// Subir/actualizar el logo de la marca activa: imagen (dataUrl base64) -> media store -> setea el campo logo.
const LOGO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' };
app.post('/api/perfil/logo', async (req, res) => {
  try {
    const dataUrl = String((req.body && req.body.dataUrl) || '');
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m || !LOGO_EXT[m[1]]) return res.status(400).json({ ok: false, error: 'imagen_invalida' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'muy_grande' });
    const dir = path.join('/app/media', 'marca', req.negocio);
    await fs.promises.mkdir(dir, { recursive: true });
    const fname = `logo-${Date.now()}.${LOGO_EXT[m[1]]}`;
    await fs.promises.writeFile(path.join(dir, fname), buf);
    const url = `https://${req.get('host')}/media/marca/${req.negocio}/${fname}`;
    await db.setLogo(req.negocioId, url);
    res.json({ ok: true, url });
  } catch (e) { console.error('logo upload', e.message); res.status(500).json({ ok: false, error: 'upload' }); }
});

// --- Landing del proyecto (cambios con borrador -> preview -> aprobación -> producción) ---
app.get('/api/landing', async (req, res) => {
  try { res.json(await db.getLandingCambios(req.negocioId)); }
  catch (e) { console.error('landing list', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/landing', async (req, res) => {
  try { const id = await db.crearLandingCambio(req.negocioId, (req.body || {}).requerimiento);
    res.json(id ? { ok: true, id } : { ok: false, error: 'requerimiento vacío' }); }
  catch (e) { console.error('landing crear', e.message); res.status(500).json({ ok: false }); }
});
app.post('/api/landing/:id/aprobar', soloAprobador, async (req, res) => {
  try { res.json({ ok: await db.aprobarLanding(req.negocioId, req.params.id) }); }
  catch (e) { console.error('landing aprobar', e.message); res.status(500).json({ ok: false }); }
});
app.post('/api/landing/:id/rechazar', soloAprobador, async (req, res) => {
  try { res.json({ ok: await db.rechazarLanding(req.negocioId, req.params.id, (req.body || {}).motivo) }); }
  catch (e) { console.error('landing rechazar', e.message); res.status(500).json({ ok: false }); }
});

// --- Auditoría de presencia digital del proyecto ---
app.get('/api/auditoria', soloAdmin, async (req, res) => {
  try { res.json(await db.getAuditoria(req.negocioId, req.query.canal)); }
  catch (e) { console.error('auditoria', e.message); res.status(500).json({ error: 'db' }); }
});

// Pauta (Meta Marketing API, read-only): último snapshot sincronizado por cf-pauta-sync.
app.get('/api/pauta', async (req, res) => {
  try { res.json(await db.getPauta(req.negocioId)); }
  catch (e) { console.error('pauta', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/pauta/evolucion', async (req, res) => {
  try { res.json(await db.getPautaEvolucion(req.negocioId)); }
  catch (e) { console.error('pauta-evol', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/pauta/refrescar', async (req, res) => {
  try { res.json({ ok: await db.pedirRefrescoPauta() }); }
  catch (e) { console.error('pauta-refrescar', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Campañas de pauta: propuestas del creativo + su ciclo de aprobación.
app.get('/api/campanias', async (req, res) => {
  try { res.json(await db.getCampanias(req.negocioId)); }
  catch (e) { console.error('campanias', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/solicitar', async (req, res) => {
  try { res.json({ ok: true, id: await db.crearSolicitudCampania(req.negocioId, (req.body || {}).instruccion) }); }
  catch (e) { console.error('campania-solicitar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/aprobar', soloAprobador, async (req, res) => {
  try { res.json({ ok: await db.aprobarCampania(req.negocioId, req.params.id) }); }
  catch (e) { console.error('campania-aprobar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/rechazar', soloAprobador, async (req, res) => {
  try { res.json({ ok: await db.rechazarCampania(req.negocioId, req.params.id, (req.body || {}).motivo) }); }
  catch (e) { console.error('campania-rechazar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/descartar', soloAprobador, async (req, res) => {
  try { res.json({ ok: await db.descartarCampania(req.negocioId, req.params.id) }); }
  catch (e) { console.error('campania-descartar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/activar', soloAprobador, async (req, res) => {
  try { res.json({ ok: await db.activarCampania(req.negocioId, req.params.id) }); }
  catch (e) { console.error('campania-activar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/pausar', soloAprobador, async (req, res) => {
  try { res.json({ ok: await db.pausarCampania(req.negocioId, req.params.id) }); }
  catch (e) { console.error('campania-pausar', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/reintentar', async (req, res) => {
  try { res.json({ ok: await db.reintentarCampania(req.negocioId, req.params.id) }); }
  catch (e) { console.error('campania-reintentar', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/campanias/creativos', async (req, res) => {
  try { res.json(await db.getCreativosDisponibles(req.negocioId)); }
  catch (e) { console.error('campania-creativos', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/campanias/:id/creativo', async (req, res) => {
  try { res.json({ ok: await db.setCreativoCampania(req.negocioId, req.params.id, (req.body || {}).pieza_id) }); }
  catch (e) { console.error('campania-creativo', e.message); res.status(500).json({ error: 'db' }); }
});

// Stremea una foto de Telegram (resuelve file_id -> file_path -> bytes, con el token server-side).
async function proxyTelegramPhoto(res, fileId) {
  if (!fileId) return res.status(404).end();
  if (!BOT) return res.status(503).end();
  const gf = await fetch(`https://api.telegram.org/bot${BOT}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
  const fp = gf && gf.result && gf.result.file_path;
  if (!fp) return res.status(404).end();
  const img = await fetch(`https://api.telegram.org/file/bot${BOT}/${fp}`, { signal: AbortSignal.timeout(8000) });
  if (!img.ok) return res.status(502).end();
  const ct = img.headers.get('content-type');
  res.set('Content-Type', (ct && ct.startsWith('image/')) ? ct : 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(await img.arrayBuffer()));
}

// Proxy de la miniatura de un requerimiento (foto que mandó Fer por Telegram, media_file_id legacy).
app.get('/api/brief/:id/media', async (req, res) => {
  try {
    const m = await db.getBriefMedia(req.params.id);
    if (!m || m.media_type !== 'photo') return res.status(404).end();
    await proxyTelegramPhoto(res, m.media_file_id);
  } catch (e) { console.error('brief media', e.message); res.status(500).end(); }
});

// Proxy de la miniatura de un material puntual de la galería (preview en el modal).
app.get('/api/material/:mid/media', async (req, res) => {
  try {
    const m = await db.getMaterialFile(req.params.mid);
    if (!m) return res.status(404).end();
    if (m.media_path) return res.redirect('/media/' + m.media_path.split('/').map(encodeURIComponent).join('/'));  // media store en disco
    if (m.media_type !== 'photo') return res.status(404).end();
    await proxyTelegramPhoto(res, m.media_file_id);   // legacy: material viejo en Telegram
  } catch (e) { console.error('material media', e.message); res.status(500).end(); }
});

// --- Acciones sobre pendientes (protegidas por la sesión del panel) ---
// El navegador manda solo el id de la pieza; el server resuelve el token y llama a n8n.
// Acciones canal-aware: Instagram → webhooks n8n (Graph API); Aviso → estado directo en la base.
app.post('/api/piezas/:id/aprobar', soloAprobador, async (req, res) => {
  try {
    const p = await db.getPiezaCanal(req.params.id);
    if (!p || p.estado !== 'pendiente_aprobacion') return res.status(409).json({ ok: false, error: 'no_pendiente' });
    if (p.canal === 'aviso') return res.json({ ok: await db.avisoEstado(req.params.id, 'publicada') });
    if (req.body && Array.isArray(req.body.colaboradores)) await db.setColaboradores(req.params.id, req.body.colaboradores);
    let status;
    try {
      status = await callWebhook(`${N8N}/cf-pub-publish?token=${encodeURIComponent(p.token)}`);
    } catch (netErr) {
      // No se pudo ni contactar al publicador (n8n): DNS/red. Es reintentar, no un error de la pieza.
      console.error('aprobar sin conexión a n8n', netErr.message);
      return res.status(503).json({ ok: false, error: 'sin_conexion' });
    }
    res.json({ ok: status >= 200 && status < 300, status });
  } catch (e) { console.error('aprobar', e.message); res.status(500).json({ ok: false, error: 'webhook' }); }
});

// Estado de una pieza (para confirmar que la publicación async de n8n efectivamente ocurrió).
app.get('/api/piezas/:id/estado', async (req, res) => {
  try {
    const p = await db.getPiezaCanal(req.params.id);
    if (!p) return res.status(404).json({ error: 'no_existe' });
    res.json({ estado: p.estado });
  } catch (e) { console.error('pieza-estado', e.message); res.status(500).json({ error: 'db' }); }
});

app.post('/api/piezas/:id/rechazar', soloAprobador, async (req, res) => {
  try {
    const motivo = String((req.body && req.body.motivo) || '').trim().slice(0, 500);
    if (!motivo) return res.status(400).json({ ok: false, error: 'motivo_requerido' });
    const p = await db.getPiezaCanal(req.params.id);
    if (!p || p.estado !== 'pendiente_aprobacion') return res.status(409).json({ ok: false, error: 'no_pendiente' });
    if (p.canal === 'aviso') return res.json({ ok: await db.avisoEstado(req.params.id, 'rechazada', motivo) });
    const url = `${N8N}/cf-pub-decide?token=${encodeURIComponent(p.token)}&accion=rechazar&motivo=${encodeURIComponent(motivo)}`;
    const status = await callWebhook(url);
    res.json({ ok: status >= 200 && status < 300, status });
  } catch (e) { console.error('rechazar', e.message); res.status(500).json({ ok: false, error: 'webhook' }); }
});

app.post('/api/piezas/:id/descartar', soloAprobador, async (req, res) => {
  try {
    const p = await db.getPiezaCanal(req.params.id);
    if (!p || p.estado !== 'pendiente_aprobacion') return res.status(409).json({ ok: false, error: 'no_pendiente' });
    if (p.canal === 'aviso') return res.json({ ok: await db.avisoEstado(req.params.id, 'descartada') });
    const status = await callWebhook(`${N8N}/cf-pub-decide?token=${encodeURIComponent(p.token)}&accion=descartar`);
    res.json({ ok: status >= 200 && status < 300, status });
  } catch (e) { console.error('descartar', e.message); res.status(500).json({ ok: false, error: 'webhook' }); }
});

// --- Propuestas del creativo + gestión de la cola de requerimientos ---
app.post('/api/proponer', async (req, res) => {
  try {
    const enfasis = String((req.body && req.body.enfasis) || '').trim().slice(0, 1000);
    const canal = req.body && req.body.canal === 'aviso' ? 'aviso' : 'instagram';
    const cantidad = Math.min(8, Math.max(1, parseInt(req.body && req.body.cantidad, 10) || 5));
    const material = Array.isArray(req.body && req.body.material) ? req.body.material : [];
    await db.pedirPropuestas(enfasis, canal, cantidad, req.negocioId, material);
    res.json({ ok: true });
  } catch (e) { console.error('proponer', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Staging de material para un pedido de propuestas (aún sin solicitud): guarda a disco y
// devuelve el media_path; /api/proponer lo vincula. Imagen por base64; video por streaming+ffmpeg.
app.post('/api/proponer/material', async (req, res) => {
  try {
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('material/prop', req.negocio));
    res.json({ ok: true, media_path: mediaPath, media_type: mediaType, filename });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});
// Adjuntar material ELIGIÉNDOLO de la biblioteca: copia el archivo al staging del pedido.
app.post('/api/proponer/material-biblioteca', async (req, res) => {
  try {
    const srcRel = String((req.body && req.body.media_path) || '').replace(/^\/+/, '').replace(/^media\//, '');
    if (!srcRel || srcRel.includes('..')) return res.status(400).json({ ok: false, error: 'ruta' });
    const src = path.join('/app/media', srcRel);
    const ext = ((srcRel.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('material/prop', req.negocio, crypto.randomUUID() + '.' + ext);
    const dst = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    const mediaType = (req.body && req.body.tipo === 'video') ? 'video' : 'photo';
    res.json({ ok: true, media_path: rel, media_type: mediaType, filename: (req.body && req.body.filename) || null });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'copy' }); }
});
app.post('/api/proponer/material-video', async (req, res) => {
  const tmp = path.join('/tmp', 'up_' + crypto.randomUUID() + '.src');
  try {
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'video.mp4')).slice(0, 120);
    const MAX = 600 * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > MAX) { const e = new Error('El video supera los 600MB'); e.http = 413; throw e; }
    await recibirStream(req, tmp, MAX);
    const rel = path.posix.join('material/prop', req.negocio, crypto.randomUUID() + '.mp4');
    const abs = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await comprimirVideo(tmp, abs);
    res.json({ ok: true, media_path: rel, media_type: 'video', filename: filename.replace(/\.[^.]+$/, '') });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
  finally { fs.promises.unlink(tmp).catch(() => {}); }
});

app.post('/api/requerimientos/:id/activar', async (req, res) => {
  try { res.json({ ok: await db.activarReq(req.params.id) }); }
  catch (e) { console.error('activar', e.message); res.status(500).json({ ok: false }); }
});

app.post('/api/requerimientos/:id/descartar', async (req, res) => {
  try { res.json({ ok: await db.descartarReq(req.params.id) }); }
  catch (e) { console.error('descartar req', e.message); res.status(500).json({ ok: false }); }
});

// "Generar publicación": guarda los comentarios y manda el requerimiento al circuito -> 'pendiente'.
app.post('/api/requerimientos/:id/generar', async (req, res) => {
  try {
    const comentarios = String((req.body && req.body.comentarios) || '').trim();
    res.json({ ok: await db.generarReq(req.params.id, comentarios) });
  } catch (e) { console.error('generar req', e.message); res.status(500).json({ ok: false }); }
});

// "Pedir nueva versión": guarda comentarios y manda la propuesta a que el creativo reescriba el concepto -> 'revisar'.
app.post('/api/requerimientos/:id/revisar', async (req, res) => {
  try {
    const comentarios = String((req.body && req.body.comentarios) || '').trim();
    if (!comentarios) return res.status(400).json({ ok: false, error: 'comentarios_requerido' });
    res.json({ ok: await db.revisarReq(req.params.id, comentarios) });
  } catch (e) { console.error('revisar req', e.message); res.status(500).json({ ok: false }); }
});

// Biblioteca de medios de la marca activa: piezas + material aportado + assets de marca (logos).
app.get('/api/biblioteca', async (req, res) => {
  try {
    await db.ensureCarpetasBiblioteca(req.negocioId);
    const data = await db.getBiblioteca(req.negocioId);
    // Logo actual del perfil (puede ser URL del media store o de la landing; distinto del archivo en disco).
    const logoUrl = (data.logo && /^(https?:\/\/|\/media\/)/.test(data.logo)) ? data.logo : null;
    const logoBase = logoUrl ? decodeURIComponent(logoUrl.split('?')[0].split('/').pop() || '') : null;
    let marca = [];
    try {
      const dir = path.join('/app/media', 'marca', req.negocio);
      const files = await fs.promises.readdir(dir);
      const items = await Promise.all(files.filter(f => !f.startsWith('.')).map(async f => {
        const st = await fs.promises.stat(path.join(dir, f)).catch(() => null);
        const tipo = /\.(mp4|webm|mov)$/i.test(f) ? 'video' : 'image';
        return { url: '/media/marca/' + encodeURIComponent(req.negocio) + '/' + encodeURIComponent(f), filename: f, tipo, fecha: st ? st.mtime : null };
      }));
      marca = items.filter(it => it.filename !== logoBase).sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
    } catch (_) { /* sin carpeta de marca todavía */ }
    // El logo del perfil va primero (sea del store o de la landing).
    if (logoUrl) marca.unshift({ url: logoUrl, filename: logoBase || 'logo de marca', tipo: /\.(mp4|webm|mov)$/i.test(logoUrl) ? 'video' : 'image', fecha: null });
    // Espacio por carpeta (stat de los archivos en disco; Piezas es externa -> sin tamaño).
    const fbytes = async rel => { try { const st = await fs.promises.stat(path.join('/app/media', String(rel).replace(/^\/?(media\/)?/, ''))); return st.size; } catch { return 0; } };
    const sumB = async arr => (await Promise.all(arr.map(fbytes))).reduce((a, b) => a + b, 0);
    const [bEnProcI, bTerm, bMat, bMarca] = await Promise.all([
      sumB(data.items.filter(i => i.carpeta === 'En proceso').map(i => i.media_path)),
      sumB(data.items.filter(i => i.carpeta === 'Terminado').map(i => i.media_path)),
      sumB(data.material.map(m => m.media_path)),
      sumB(marca.filter(m => /^\/media\//.test(m.url)).map(m => m.url)),
    ]);
    const folderSizes = { 'En proceso': bEnProcI + bMat, 'Terminado': bTerm, 'Marca': bMarca };
    res.json({ piezas: data.piezas, material: data.material, marca, items: data.items || [], carpetas: data.carpetas || [], trabajando: data.trabajando || [], folderSizes });
  } catch (e) { console.error('biblioteca', e.message); res.status(500).json({ error: 'db' }); }
});

// Subir un archivo nuevo al taller (a una carpeta).
app.post('/api/biblioteca/subir', async (req, res) => {
  try {
    const carpeta = String((req.body && req.body.carpeta) || 'En proceso').slice(0, 60);
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('biblioteca', req.negocio));
    const id = await db.crearItemBiblioteca(req.negocioId, mediaPath, mediaType, filename, carpeta);
    res.json({ ok: true, id });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});

// Subida de VIDEO por streaming crudo + compresión ffmpeg (para archivos grandes que no
// caben en el límite de base64). El cuerpo es el video tal cual; metadatos en headers.
app.post('/api/biblioteca/subir-video', async (req, res) => {
  const tmp = path.join('/tmp', 'up_' + crypto.randomUUID() + '.src');
  try {
    const carpeta = String(req.headers['x-carpeta'] || 'En proceso').slice(0, 60);
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'video.mp4')).slice(0, 120);
    const MAX = 600 * 1024 * 1024;  // 600MB de entrada (se comprime a mucho menos)
    if (Number(req.headers['content-length'] || 0) > MAX) { const e = new Error('El video supera los 600MB'); e.http = 413; throw e; }
    await recibirStream(req, tmp, MAX);
    const rel = path.posix.join('biblioteca', req.negocio, crypto.randomUUID() + '.mp4');
    const abs = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await comprimirVideo(tmp, abs);
    const nombre = filename.replace(/\.[^.]+$/, '');
    const id = await db.crearItemBiblioteca(req.negocioId, rel, 'video', nombre, carpeta);
    res.json({ ok: true, id });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
  finally { fs.promises.unlink(tmp).catch(() => {}); }
});
// Descargar material de la biblioteca: 1 ítem = el archivo tal cual; varios = un .zip.
// Seguridad: solo se sirve lo que pertenece al negocio activo (path del media store con su slug,
// o una URL que exista como media de una pieza suya). Nada de rutas arbitrarias.
app.post('/api/biblioteca/descargar', async (req, res) => {
  try {
    const pedidos = ((req.body || {}).items || []).slice(0, 200);
    if (!pedidos.length) return res.status(400).json({ error: 'sin_items' });

    // Prefijos del media store que son de este negocio.
    const okPrefijos = ['biblioteca/', 'material/prop/', 'avisos/', 'marca/'].map(p => p + req.negocio + '/');
    const local = u => {
      let s = String(u || '').trim()
        .replace(/^https?:\/\/[^/]+\/media\//, '').replace(/^\/?media\//, '');
      if (!s || s.includes('..')) return null;
      return okPrefijos.some(p => s.startsWith(p)) ? s : null;
    };
    // URLs externas (piezas publicadas): validarlas contra la DB de este negocio.
    const externas = pedidos.map(i => String(i.url || '')).filter(u => /^https?:/.test(u) && !local(u));
    const validas = externas.length ? await db.urlsDeMediaDelNegocio(req.negocioId, externas) : new Set();

    const arch = [];
    for (const it of pedidos) {
      const rel = local(it.url);
      const nombre = String(it.nombre || 'archivo').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80);
      if (rel) arch.push({ tipo: 'disco', ruta: path.join('/app/media', rel), nombre, ext: (rel.match(/\.[a-z0-9]+$/i) || [''])[0] });
      else if (validas.has(String(it.url))) arch.push({ tipo: 'url', url: String(it.url), nombre, ext: (String(it.url).match(/\.[a-z0-9]+(?=($|\?))/i) || [''])[0] });
    }
    if (!arch.length) return res.status(403).json({ error: 'sin_acceso' });

    const nombreCon = a => a.nombre.toLowerCase().endsWith(a.ext.toLowerCase()) ? a.nombre : (a.nombre + a.ext);

    if (arch.length === 1) {                       // uno solo: el archivo, sin zip
      const a = arch[0];
      res.set('Content-Disposition', `attachment; filename="${nombreCon(a)}"`);
      if (a.tipo === 'disco') {
        if (!fs.existsSync(a.ruta)) return res.status(404).json({ error: 'no_existe' });
        return fs.createReadStream(a.ruta).pipe(res);
      }
      const r = await fetch(a.url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return res.status(502).json({ error: 'origen' });
      res.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
      return res.end(Buffer.from(await r.arrayBuffer()));
    }

    const hoy = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="biblioteca-${req.negocio}-${hoy}.zip"`);
    const archive = archiver('zip', { store: true });   // imágenes/videos ya vienen comprimidos
    archive.on('error', e => { console.error('zip bib', e.message); if (!res.headersSent) res.status(500).end(); });
    archive.pipe(res);
    const usados = new Set();
    for (const a of arch) {
      let n = nombreCon(a), i = 1;
      while (usados.has(n)) { n = nombreCon(a).replace(/(\.[^.]+)?$/, `-${++i}$1`); }   // sin pisar nombres repetidos
      usados.add(n);
      try {
        if (a.tipo === 'disco') { if (fs.existsSync(a.ruta)) archive.file(a.ruta, { name: n }); }
        else {
          const r = await fetch(a.url, { signal: AbortSignal.timeout(30000) });
          if (r.ok) archive.append(Buffer.from(await r.arrayBuffer()), { name: n });
        }
      } catch (e) { console.error('zip bib item', a.nombre, e.message); }
    }
    await archive.finalize();
  } catch (e) { console.error('descargar bib', e.message); if (!res.headersSent) res.status(500).json({ error: 'zip' }); }
});

// Preservar un asset (p.ej. material aportado, que se depura) copiándolo a la base "Terminado".
app.post('/api/biblioteca/preservar', async (req, res) => {
  try {
    const srcRel = String((req.body && req.body.media_path) || '').replace(/^\/+/, '').replace(/^media\//, '');
    if (!srcRel || srcRel.includes('..')) return res.status(400).json({ ok: false });
    const src = path.join('/app/media', srcRel);
    const ext = ((srcRel.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('biblioteca', req.negocio, crypto.randomUUID() + '.' + ext);
    const dst = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    const tipo = (req.body && req.body.tipo === 'video') ? 'video' : 'image';
    const id = await db.crearItemBiblioteca(req.negocioId, rel, tipo, (req.body && req.body.nombre) || null, 'Terminado', 'aportado');
    res.json({ ok: true, id });
  } catch (e) { console.error('preservar', e.message); res.status(500).json({ ok: false }); }
});
// Crear / borrar carpeta del taller.
app.post('/api/biblioteca/carpeta', async (req, res) => {
  try {
    const nombre = String((req.body && req.body.nombre) || '').trim();
    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });
    res.json({ ok: await db.crearCarpetaBiblioteca(req.negocioId, nombre) });
  } catch (e) { console.error('biblio carpeta', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/biblioteca/carpeta/:nombre', async (req, res) => {
  try { res.json({ ok: await db.delCarpetaBiblioteca(req.negocioId, decodeURIComponent(req.params.nombre)) }); }
  catch (e) { console.error('biblio del carpeta', e.message); res.status(500).json({ ok: false }); }
});
// Mover / borrar un ítem del taller.
app.post('/api/biblioteca/item/:id/mover', async (req, res) => {
  try {
    const carpeta = String((req.body && req.body.carpeta) || '').trim();
    if (!carpeta) return res.status(400).json({ ok: false, error: 'carpeta_requerida' });
    res.json({ ok: await db.moverItemBiblioteca(req.negocioId, req.params.id, carpeta) });
  } catch (e) { console.error('biblio mover', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/biblioteca/item/:id', async (req, res) => {
  try {
    const row = await db.delItemBiblioteca(req.negocioId, req.params.id);
    if (row && row.media_path) borrarMediaFile(row.media_path);
    res.json({ ok: !!row });
  } catch (e) { console.error('biblio del item', e.message); res.status(500).json({ ok: false }); }
});

// Pedido al bibliotecario: crear/editar un asset (instruccion + fuente opcional). Lo procesa el worker.
app.post('/api/biblioteca/solicitar', async (req, res) => {
  try {
    const instruccion = String((req.body && req.body.instruccion) || '').trim();
    if (!instruccion) return res.status(400).json({ ok: false, error: 'instruccion_requerida' });
    const origenUrl = (req.body && req.body.origen_url) ? String(req.body.origen_url).slice(0, 1000) : null;
    const origenTipo = (req.body && req.body.origen_tipo === 'video') ? 'video' : (origenUrl ? 'image' : null);
    const id = await db.crearSolicitudBiblioteca(req.negocioId, instruccion, origenUrl, origenTipo);
    res.json({ ok: true, id });
  } catch (e) { console.error('biblio solicitar', e.message); res.status(500).json({ ok: false }); }
});

// Borrar un asset/solicitud del bibliotecario (y su archivo).
app.delete('/api/biblioteca/generado/:id', async (req, res) => {
  try {
    const row = await db.delSolicitudBiblioteca(req.negocioId, req.params.id);
    if (row && row.resultado_path) borrarMediaFile(row.resultado_path);
    res.json({ ok: !!row });
  } catch (e) { console.error('biblio del', e.message); res.status(500).json({ ok: false }); }
});

// Bitácora de generación de una pieza (cómo la armó el creativo: lógica + herramientas).
app.get('/api/piezas/:id/bitacora', async (req, res) => {
  try { const b = await db.getBitacora(req.params.id); b ? res.json(b) : res.status(404).json({ error: 'no_existe' }); }
  catch (e) { console.error('bitacora', e.message); res.status(500).json({ error: 'db' }); }
});

// Galería de materiales aportados a un requerimiento (para el modal de interacción).
app.get('/api/requerimientos/:id/materiales', async (req, res) => {
  try { res.json(await db.getMateriales(req.params.id)); }
  catch (e) { console.error('materiales', e.message); res.status(500).json({ error: 'db' }); }
});

// Quitar un material de la galería (antes de generar).
// Borra del media store un archivo relativo (guard contra path traversal; media_path viene de nuestra DB).
function borrarMediaFile(rel) {
  if (!rel || rel.includes('..') || rel.startsWith('/')) return;
  fs.promises.unlink(path.join('/app/media', rel)).catch(() => {});
}
app.delete('/api/requerimientos/:id/material/:mid', async (req, res) => {
  try { const row = await db.delMaterial(req.params.id, req.params.mid); if (row) borrarMediaFile(row.media_path); res.json({ ok: !!row }); }
  catch (e) { console.error('del material', e.message); res.status(500).json({ ok: false }); }
});

// Guarda un archivo (dataURL base64) en el media store en disco (/app/media/<subdir>/<uuid>.<ext>)
// y devuelve {mediaPath, mediaType, filename}. Reemplaza a Telegram: el Bot API descarga hasta 20MB,
// insuficiente para videos. El volumen es el mismo que lee el creativo (host) — sin límite de tamaño.
// Comprime un video a calidad apta para Instagram (H.264, máx 1080px de ancho, faststart).
// Reduce mucho el peso de videos de celular (4K) sin pérdida visible en feed/reels.
function comprimirVideo(src, dst) {
  return new Promise((resolve, reject) => {
    const args = ['-i', src, '-vf', "scale='min(1080,iw)':-2", '-c:v', 'libx264', '-crf', '26',
      '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', dst];
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    ff.on('error', e => reject(new Error('ffmpeg no disponible: ' + e.message)));
    ff.on('close', code => code === 0 ? resolve() : reject(new Error('No se pudo comprimir el video')));
  });
}

// Duración real del video (ffprobe): así el aviso no depende de que el usuario la adivine.
function duracionVideo(src) {
  return new Promise(resolve => {
    const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', src]);
    let out = '';
    ff.stdout.on('data', d => { out += d; });
    ff.on('error', () => resolve(null));
    ff.on('close', () => { const s = Math.round(parseFloat(out)); resolve(Number.isFinite(s) && s > 0 ? s : null); });
  });
}

// Cuadro de portada del video: sin esto la tarjeta del aviso se ve como un rectángulo negro.
function posterVideo(src, dst) {
  return new Promise(resolve => {
    const ff = spawn('ffmpeg', ['-ss', '1', '-i', src, '-vframes', '1', '-q:v', '3', '-y', dst]);
    ff.on('error', () => resolve(false));
    ff.on('close', code => resolve(code === 0 && fs.existsSync(dst)));
  });
}

// Recibe el video crudo por streaming (sin base64) a un archivo temporal. Devuelve la ruta temp.
function recibirStream(req, tmp, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const ws = fs.createWriteStream(tmp);
    const fail = (e) => { try { ws.destroy(); } catch {} fs.promises.unlink(tmp).catch(() => {}); reject(e); };
    req.on('data', c => { size += c.length; if (size > max) { try { req.destroy(); } catch {} fail(Object.assign(new Error('El video es demasiado grande'), { http: 413 })); } });
    ws.on('error', fail); req.on('error', fail);
    ws.on('finish', () => resolve(size));
    req.pipe(ws);
  });
}

async function guardarMaterialDisco(body, subdir) {
  const dataUrl = String((body && body.dataUrl) || '');
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) { const e = new Error('archivo_invalido'); e.http = 400; throw e; }
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const mediaType = mime.startsWith('video/') ? 'video' : 'photo';
  const filename = String((body && body.filename) || (mediaType === 'video' ? 'material.mp4' : 'material.jpg'));
  const ext = ((filename.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || (mediaType === 'video' ? 'mp4' : 'jpg')).toLowerCase();
  const rel = path.posix.join(subdir, `${crypto.randomUUID()}.${ext}`);
  const abs = path.join('/app/media', rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, buf);
  return { mediaPath: rel, mediaType, filename };
}

// Sube un archivo (base64) al bot como documento (preserva calidad) y devuelve {fileId, mediaType, filename}.
// Lanza un Error con .http para que el handler responda el status correcto.
async function subirMaterialTg(body, caption) {
  if (!BOT) { const e = new Error('sin_bot'); e.http = 503; throw e; }
  const dataUrl = String((body && body.dataUrl) || '');
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) { const e = new Error('archivo_invalido'); e.http = 400; throw e; }
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const mediaType = mime.startsWith('video/') ? 'video' : 'photo';
  const filename = String((body && body.filename) || (mediaType === 'video' ? 'material.mp4' : 'material.jpg'));
  const fd = new FormData();
  fd.append('chat_id', CHAT);
  fd.append('caption', caption);
  fd.append('document', new Blob([buf], { type: mime }), filename);
  const tg = await fetch(`https://api.telegram.org/bot${BOT}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) }).then(r => r.json());
  const fileId = tg && tg.result && tg.result.document && tg.result.document.file_id;
  if (!fileId) { const e = new Error('telegram'); e.http = 502; throw e; }
  return { fileId, mediaType, filename };
}

// Aportar material desde el panel: el archivo se suma a la galería del requerimiento. NO dispara la
// generación (eso lo hace el botón "Generar publicación").
app.post('/api/requerimientos/:id/material', async (req, res) => {
  try {
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('material/req', req.params.id));
    const mat = await db.addMaterial(req.params.id, mediaPath, mediaType, filename);
    if (!mat) return res.status(409).json({ ok: false, error: 'estado' });
    res.json({ ok: true, material: mat });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});

// Agregar material a una propuesta ELIGIÉNDOLO de la biblioteca: se copia el archivo a la propuesta.
app.post('/api/requerimientos/:id/material-biblioteca', async (req, res) => {
  try {
    const srcRel = String((req.body && req.body.media_path) || '').replace(/^\/+/, '').replace(/^media\//, '');
    if (!srcRel || srcRel.includes('..')) return res.status(400).json({ ok: false, error: 'ruta' });
    const src = path.join('/app/media', srcRel);
    const ext = ((srcRel.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('material/req', req.params.id, crypto.randomUUID() + '.' + ext);
    const dst = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    const tipo = (req.body && req.body.tipo === 'video') ? 'video' : 'image';
    const mat = await db.addMaterial(req.params.id, rel, tipo, (req.body && req.body.filename) || null);
    if (!mat) { await fs.promises.unlink(dst).catch(() => {}); return res.status(409).json({ ok: false, error: 'estado' }); }
    res.json({ ok: true, material: mat });
  } catch (e) { console.error('material-biblioteca', e.message); res.status(500).json({ ok: false }); }
});

// --- Material aportado al RECHAZAR una pieza (se adjunta al brief que la generó, para la corrección) ---
app.get('/api/piezas/:id/materiales', async (req, res) => {
  try { res.json(await db.getMaterialesPorPieza(req.params.id)); }
  catch (e) { console.error('materiales pieza', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/piezas/:id/material', async (req, res) => {
  try {
    const { mediaPath, mediaType, filename } = await guardarMaterialDisco(req.body, path.posix.join('material/pieza', req.params.id));
    const mat = await db.addMaterialPorPieza(req.params.id, mediaPath, mediaType, filename);
    if (!mat) return res.status(409).json({ ok: false, error: 'no_pendiente' });
    res.json({ ok: true, material: mat });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});
app.delete('/api/piezas/:id/material/:mid', async (req, res) => {
  try { const row = await db.delMaterialPorPieza(req.params.id, req.params.mid); if (row) borrarMediaFile(row.media_path); res.json({ ok: !!row }); }
  catch (e) { console.error('del material pieza', e.message); res.status(500).json({ ok: false }); }
});

// --- Programación de pantalla (privado) — a nivel PANTALLA, cross-proyecto (no usa la marca activa) ---
// Resuelve la pantalla destino: ?pantalla=<slug> o la pantalla activa por defecto.
async function resolvePantalla(req) {
  return req.query.pantalla ? db.getPantallaPorSlug(String(req.query.pantalla)) : db.getPantallaActiva();
}
// --- Avisos cargados A MANO (material ya listo: no lo hizo el creativo) ---
// Entran por la misma puerta que los del creativo: nacen 'pendiente_aprobacion'.
const urlMedia = (req, rel) => `https://${req.get('host')}/media/` +
  rel.split('/').map(encodeURIComponent).join('/');

// 1) Desde la BIBLIOTECA: el archivo ya está en el media store, solo lo apuntamos.
app.post('/api/avisos/manual', async (req, res) => {
  try {
    const b = req.body || {};
    const rel = String(b.media_path || '').replace(/^\/+/, '').replace(/^media\//, '');
    if (!rel || rel.includes('..')) return res.status(400).json({ ok: false, error: 'media_requerida' });

    // Un video SIEMPRE necesita póster: sin él la tarjeta se ve negra y la vista de programación
    // intenta meter un .mp4 dentro de un <img> (no se ve nada). Si vino de la biblioteca no lo
    // trae, así que lo sacamos acá del archivo que ya está en disco.
    let poster = b.poster_url || null;
    if (b.tipo === 'video' && !poster) poster = await asegurarPoster(req, rel);

    const r = await db.crearAvisoManual(req.negocioId, {
      titulo: b.titulo, duracion_s: b.duracion_s, momento: b.momento,
      tipo: b.tipo, url: urlMedia(req, rel), poster_url: poster,
    });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { console.error('aviso-manual', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

// Póster de un video que ya vive en el media store. Reusa el .jpg si ya lo generamos antes.
async function asegurarPoster(req, rel) {
  try {
    const abs = path.join('/app/media', rel);
    if (!fs.existsSync(abs)) return null;
    const relPost = rel.replace(/\.[^.]+$/, '') + '.jpg';
    const absPost = path.join('/app/media', relPost);
    if (!fs.existsSync(absPost) && !(await posterVideo(abs, absPost))) return null;
    return urlMedia(req, relPost);
  } catch (_) { return null; }
}

// 2) Desde DISCO (imagen, dataURL). Guarda en el media store bajo avisos/<marca>/.
app.post('/api/avisos/subir', async (req, res) => {
  try {
    const { mediaPath, mediaType } = await guardarMaterialDisco(req.body, path.posix.join('avisos', req.negocio));
    res.json({ ok: true, media_path: mediaPath, tipo: mediaType });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
});

// 3) Desde DISCO (video, streaming + compresión). Devuelve además la duración real y el póster,
//    para que el usuario no tenga que adivinar ni vea una tarjeta negra.
app.post('/api/avisos/subir-video', async (req, res) => {
  const tmp = path.join('/tmp', 'av_' + crypto.randomUUID() + '.src');
  try {
    const MAX = 600 * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > MAX) { const e = new Error('El video supera los 600MB'); e.http = 413; throw e; }
    await recibirStream(req, tmp, MAX);
    const base = crypto.randomUUID();
    const rel = path.posix.join('avisos', req.negocio, base + '.mp4');
    const abs = path.join('/app/media', rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await comprimirVideo(tmp, abs);
    const relPost = path.posix.join('avisos', req.negocio, base + '.jpg');
    const okPost = await posterVideo(abs, path.join('/app/media', relPost));
    res.json({
      ok: true, media_path: rel, tipo: 'video',
      duracion_s: await duracionVideo(abs),
      poster_url: okPost ? urlMedia(req, relPost) : null,
    });
  } catch (e) { res.status(e.http || 500).json({ ok: false, error: e.message || 'upload' }); }
  finally { fs.promises.unlink(tmp).catch(() => {}); }
});

// --- Contactos de la marca (dueño, community manager, pauta…) ---
app.get('/api/contactos', async (req, res) => {
  try { res.json(await db.getContactos(req.negocioId)); }
  catch (e) { console.error('contactos', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/contactos', async (req, res) => {
  try { res.json(await db.guardarContactos(req.negocioId, (req.body || {}).contactos)); }
  catch (e) { console.error('contactos-set', e.message); res.status(500).json({ ok: false, error: 'db' }); }
});

app.get('/api/avisos-aprobados', async (req, res) => {
  try { res.json(await db.getAvisosAprobados()); }   // de TODOS los proyectos (mix)
  catch (e) { console.error('avisos-aprob', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/programas', async (req, res) => {
  try { const pa = await resolvePantalla(req); res.json(pa ? await db.getProgramas(pa.id) : []); }
  catch (e) { console.error('programas', e.message); res.status(500).json({ error: 'db' }); }
});
app.get('/api/programas/:id', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(404).json({ error: 'sin_pantalla' });
    const p = await db.getPrograma(req.params.id, pa.id); p ? res.json(p) : res.status(404).json({ error: 'no_existe' });
  } catch (e) { console.error('programa', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/programas', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(409).json({ ok: false, error: 'sin_pantalla' });
    res.json({ ok: true, id: await db.crearPrograma(String((req.body && req.body.nombre) || 'Programa').slice(0, 120), pa.id) });
  } catch (e) { console.error('crear prog', e.message); res.status(500).json({ ok: false }); }
});
app.put('/api/programas/:id', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(409).json({ ok: false, error: 'sin_pantalla' });
    const nombre = req.body && req.body.nombre != null ? String(req.body.nombre).slice(0, 120) : null;
    const piezas = Array.isArray(req.body && req.body.piezas) ? req.body.piezas : [];
    res.json({ ok: await db.guardarPrograma(req.params.id, nombre, piezas, pa.id) });
  } catch (e) { console.error('guardar prog', e.message); res.status(500).json({ ok: false }); }
});
app.post('/api/programas/:id/activar', soloAprobador, async (req, res) => {
  try { const pa = await resolvePantalla(req); res.json({ ok: pa ? await db.activarPrograma(req.params.id, pa.id) : false }); }
  catch (e) { console.error('activar prog', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/programas/:id', async (req, res) => {
  try { const pa = await resolvePantalla(req); res.json({ ok: pa ? await db.eliminarPrograma(req.params.id, pa.id) : false }); }
  catch (e) { console.error('del prog', e.message); res.status(500).json({ ok: false }); }
});

// Descarga del programa como .zip autocontenido: los mp4 en orden + manifest.json (para reproducir offline en la pantalla).
app.get('/api/programas/:id/download', async (req, res) => {
  try {
    const pa = await resolvePantalla(req); if (!pa) return res.status(404).json({ error: 'sin_pantalla' });
    const prog = await db.getPrograma(req.params.id, pa.id);
    if (!prog) return res.status(404).json({ error: 'no_existe' });
    const items = (prog.items || []).filter(it => it.media && it.media.url);
    if (!items.length) return res.status(409).json({ error: 'programa_vacio' });
    const slug = (prog.nombre || 'programa').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'programa';
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="programa-${slug}.zip"`);
    const archive = archiver('zip', { store: true });   // store: el mp4 ya está comprimido, no recomprimir
    archive.on('error', e => { console.error('zip', e.message); if (!res.headersSent) res.status(500).end(); });
    archive.pipe(res);
    const manifest = { programa: prog.nombre, generado: new Date().toISOString(), reproduccion: 'loop, en orden', items: [] };
    let idx = 0;
    for (const it of items) {
      idx++;
      const label = (it.marca_slug || 'aviso') + '-' + String(it.numero).padStart(4, '0');
      const fname = `${String(idx).padStart(2, '0')}_${label}.mp4`;
      try {
        const r = await fetch(it.media.url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) { console.error('zip fetch', it.media.url, r.status); continue; }
        archive.append(Buffer.from(await r.arrayBuffer()), { name: fname });
        manifest.items.push({ orden: idx, archivo: fname, marca: it.marca_slug, numero: it.numero, titulo: it.titulo_interno, duracion_s: it.duracion_s || 10 });
      } catch (e) { console.error('zip item', it.numero, e.message); }
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    await archive.finalize();
  } catch (e) { console.error('download prog', e.message); if (!res.headersSent) res.status(500).json({ error: 'zip' }); }
});

// --- VNNOX: entrega del programa a la pantalla DOOH (nube de Novastar) ---
// Estado/diagnóstico: si está configurado + lista de players y su estado online.
app.get('/api/pantalla/vnnox', async (req, res) => {
  try {
    if (!vnnox.configured()) return res.json({ configurado: false });
    const r = await vnnox.listPlayers();
    const players = (r.json && r.json.rows) ? r.json.rows.map(p => ({
      playerId: p.playerId, name: p.name, sn: p.sn, online: p.onlineStatus === 1, width: p.width, height: p.height,
    })) : [];
    res.json({ configurado: true, status: r.status, players, targets: vnnox.PLAYER_IDS });
  } catch (e) { console.error('vnnox status', e.message); res.status(500).json({ configurado: true, error: 'vnnox' }); }
});

// Publica un programa a la pantalla: calcula md5+size de cada video y llama a /v2/player/program/normal.
app.post('/api/programas/:id/enviar-pantalla', soloAprobador, async (req, res) => {
  try {
    if (!vnnox.configured()) return res.status(503).json({ ok: false, error: 'vnnox_no_configurado' });
    const pa = await resolvePantalla(req); if (!pa) return res.status(404).json({ ok: false, error: 'sin_pantalla' });
    const prog = await db.getPrograma(req.params.id, pa.id);
    if (!prog) return res.status(404).json({ ok: false, error: 'no_existe' });
    const items = (prog.items || []).filter(it => it.media && it.media.url);
    if (!items.length) return res.status(409).json({ ok: false, error: 'programa_vacio' });
    const vids = [];
    for (const it of items) {
      const r = await fetch(it.media.url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'media_inaccesible', url: it.media.url, status: r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      vids.push({
        url: it.media.url,
        md5: crypto.createHash('md5').update(buf).digest('hex'),
        size: buf.length,
        durMs: (it.duracion_s || 10) * 1000,
        label: (it.marca_slug || 'aviso') + '-' + String(it.numero).padStart(4, '0'),
      });
    }
    const fecha = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const playerIds = (pa.vnnox_player_ids && pa.vnnox_player_ids.length) ? pa.vnnox_player_ids : null;
    const out = await vnnox.publishProgram(vids, playerIds, `${prog.nombre} · ${fecha}`);
    const ok = out.status >= 200 && out.status < 300;
    res.json({ ok, status: out.status, resp: out.json });
  } catch (e) { console.error('enviar-pantalla', e.message); res.status(500).json({ ok: false, error: 'vnnox' }); }
});

// --- Pantallas (gestión multi-pantalla, nivel plataforma) ---
const slugify = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pantalla';
const toIds = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean)
  : String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const pantallaBody = b => ({
  nombre: String((b && b.nombre) || '').slice(0, 120) || 'Pantalla',
  ubicacion: b && b.ubicacion != null ? String(b.ubicacion).slice(0, 200) : null,
  ancho: b && b.ancho ? (parseInt(b.ancho, 10) || null) : null,
  alto: b && b.alto ? (parseInt(b.alto, 10) || null) : null,
  vnnox_player_ids: toIds(b && b.vnnox_player_ids),
  activo: !(b && b.activo === false),
});

app.get('/api/pantallas', async (req, res) => {
  try {
    const rows = await db.getPantallas();
    let onMap = null;                                   // estado online por player (best-effort vía VNNOX)
    if (vnnox.configured()) {
      try { const r = await vnnox.listPlayers(); onMap = {}; ((r.json && r.json.rows) || []).forEach(p => { onMap[p.playerId] = p.onlineStatus === 1; }); }
      catch (_) { onMap = null; }
    }
    const out = [];
    for (const p of rows) out.push({
      ...p,
      online: onMap ? (p.vnnox_player_ids || []).some(id => onMap[id]) : null,
      programa: await db.getProgramaActivo(p.id),   // programa activo + sus avisos (para el tablero)
    });
    res.json(out);
  } catch (e) { console.error('pantallas', e.message); res.status(500).json({ error: 'db' }); }
});
app.post('/api/pantallas', async (req, res) => {
  try {
    const d = pantallaBody(req.body);
    d.slug = slugify((req.body && req.body.slug) || d.nombre);
    const id = await db.crearPantalla(d);
    res.json({ ok: true, id, slug: d.slug });
  } catch (e) {
    if (String(e.message).includes('duplicate')) return res.status(409).json({ ok: false, error: 'slug_duplicado' });
    console.error('crear pantalla', e.message); res.status(500).json({ ok: false });
  }
});
app.put('/api/pantallas/:id', async (req, res) => {
  try { res.json({ ok: await db.actualizarPantalla(req.params.id, pantallaBody(req.body)) }); }
  catch (e) { console.error('upd pantalla', e.message); res.status(500).json({ ok: false }); }
});
app.delete('/api/pantallas/:id', async (req, res) => {
  try { const r = await db.eliminarPantalla(req.params.id); r.ok ? res.json({ ok: true }) : res.status(409).json(r); }
  catch (e) { console.error('del pantalla', e.message); res.status(500).json({ ok: false }); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, p) => { if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); }
}));

app.listen(PORT, () => console.log(`cortafuego-panel escuchando en :${PORT}`));

// Métricas y menciones: refresco al arrancar y cada 30 min.
setTimeout(refreshMetricas, 10000);
setInterval(refreshMetricas, 30 * 60 * 1000);
setTimeout(refreshMenciones, 16000);
setInterval(refreshMenciones, 30 * 60 * 1000);
