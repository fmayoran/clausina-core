'use strict';
/**
 * Canal de WhatsApp (Meta Cloud API).
 *
 * Diseño acordado con Fer: UN número de ClaUsina que habla con el WhatsApp del usuario que
 * gestiona el negocio. El usuario escribe primero — eso abre una ventana de 24 h en la que se
 * puede responder libre y sin costo, sin plantillas. Las plantillas (pagas, revisadas por Meta)
 * sólo hacen falta cuando ClaUsina inicia la conversación.
 *
 * El SSO nos enseñó la forma: el canal AUTENTICA (Meta garantiza de qué número viene), pero el
 * acceso lo sigue dando contenido.usuario. Número que no está en la tabla, no opera.
 */
const crypto = require('crypto');

const TOKEN = process.env.WHATSAPP_TOKEN || '';            // token de acceso a la Graph API
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';      // id del número emisor
const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || '';    // el que se pacta con Meta al dar de alta
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';  // para validar la firma de los webhooks
const API = 'https://graph.facebook.com/v21.0';

const configurado = () => !!(TOKEN && PHONE_ID);

/**
 * Valida que el webhook venga de Meta y no de cualquiera que conozca la URL.
 * Meta firma el cuerpo con el secreto de la app.
 *
 * Sin APP_SECRET configurado devuelve `true`: durante el alta el secreto todavía no existe y
 * bloquear todo dejaría imposible completar la configuración. Apenas se carga, empieza a exigir.
 */
function firmaValida(rawBody, header, secretos = null) {
  // Cada app de Meta firma con SU secreto. El del panel sirve para el número de ClaUsina; los
  // números propios de los negocios cuelgan de otras apps, así que se prueba contra todos los
  // secretos conocidos. Son unos pocos HMAC y sólo corre una vez por mensaje entrante.
  const candidatos = [APP_SECRET, ...(secretos || [])].filter(Boolean);
  if (!candidatos.length) return true;   // durante el alta el secreto todavía no existe
  if (!header) return false;
  const esperado = Buffer.from(String(header));
  for (const sec of candidatos) {
    const calc = Buffer.from('sha256=' + crypto.createHmac('sha256', sec).update(rawBody).digest('hex'));
    if (calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado)) return true;
  }
  return false;
}


/** Aplana el webhook de Meta, que viene con tres niveles de anidamiento. */
function leerMensajes(cuerpo) {
  const out = [];
  for (const entrada of cuerpo.entry || []) {
    for (const c of entrada.changes || []) {
      const v = c.value || {};
      // Meta manda el nombre del perfil de WhatsApp junto con los mensajes. Sirve para saludar
      // por el nombre; NO para registrar al cliente, porque suele ser un apodo o estar incompleto.
      const perfiles = {};
      for (const c2 of v.contacts || []) {
        if (c2.wa_id) perfiles[c2.wa_id] = (c2.profile || {}).name || null;
      }
      for (const m of v.messages || []) {
        out.push({
          mensaje_id: m.id,
          wa_id: m.from,
          // A QUÉ número le escribieron. Con un solo número no hacía falta; con uno por negocio
          // es lo que distingue al operador que le habla a ClaUsina del cliente que le habla a
          // su restaurante.
          phone_number_id: (v.metadata || {}).phone_number_id || null,
          perfil: perfiles[m.from] || null,
          tipo: m.type,
          // Audio y voz llegan como un id de media: el archivo se baja aparte, con el token.
          media_id: (m.audio && m.audio.id) || (m.voice && m.voice.id) || null,
          // El texto puede venir de un mensaje suelto o del botón que tocaron.
          texto: (m.text && m.text.body)
            || (m.button && m.button.text)
            || (m.interactive && m.interactive.button_reply && m.interactive.button_reply.title)
            || (m.interactive && m.interactive.list_reply && m.interactive.list_reply.title)
            || '',
          // Los botones y las listas traen un id propio: es lo que usamos para saber QUÉ eligió,
          // sin depender de cómo esté escrito el rótulo.
          accion: (m.interactive && m.interactive.button_reply && m.interactive.button_reply.id)
            || (m.interactive && m.interactive.list_reply && m.interactive.list_reply.id)
            || (m.button && m.button.payload) || '',
          crudo: m,
        });
      }
    }
  }
  return out;
}

// `cfg` manda desde el número DEL NEGOCIO. Sin cfg sale por el de ClaUsina, que es el canal con
// el operador. Escribirle a un cliente final desde el número equivocado es el error que hay que
// evitar: recibe un mensaje de una empresa que no conoce y lo reporta.
async function enviarTexto(a, texto, cfg = null) {
  const phone = (cfg && cfg.phone_id) || PHONE_ID;
  const token = (cfg && cfg.token) || TOKEN;
  if (!phone || !token) return { ok: false, motivo: 'sin_configurar' };
  try {
    const r = await fetch(`${API}/${phone}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(a).replace(/\D+/g, ''),
        type: 'text',
        text: { preview_url: false, body: String(texto).slice(0, 4000) },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, motivo: (d.error && d.error.message) || `HTTP ${r.status}` };
    return { ok: true, id: d.messages && d.messages[0] && d.messages[0].id };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

// Plantilla: es la ÚNICA forma de escribirle a alguien fuera de la ventana de 24 h, y es el caso
// de todo aviso que inicia la plataforma. Meta las revisa una por una; si todavía no aprobó la
// que se pide, la API devuelve el error y acá se informa sin romper nada.
// `cfg` permite mandar desde el número DEL NEGOCIO en vez del de la plataforma. Se usa para
// escribirle al cliente final: el comensal tiene que ver el nombre del lugar donde reservó, no
// el de ClaUsina. Sin cfg sale por el número de ClaUsina, que es el canal con el operador.
/**
 * Manda una imagen por su URL. Meta la busca sola, así que la URL tiene que ser pública — por eso
 * las tarjetas van a una carpeta de media que no exige sesión. Subir el archivo a Meta y mandar
 * el id sería la alternativa, pero agrega un paso y un id que caduca a los 30 días.
 */
async function enviarImagen(a, url, caption, cfg = null) {
  const phone = (cfg && cfg.phone_id) || PHONE_ID;
  const token = (cfg && cfg.token) || TOKEN;
  if (!phone || !token) return { ok: false, motivo: 'sin_configurar' };
  try {
    const r = await fetch(`${API}/${phone}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(a).replace(/\D+/g, ''),
        type: 'image',
        image: { link: url, caption: String(caption || '').slice(0, 1024) },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, motivo: (j.error && j.error.message) || `http ${r.status}` };
    return { ok: true, id: ((j.messages || [])[0] || {}).id || null };
  } catch (e) { return { ok: false, motivo: e.message }; }
}

/**
 * Manda una plantilla aprobada. `cfg.imagen` agrega una cabecera con foto: es la única forma de
 * hacerle llegar una imagen a alguien que NO escribió en las últimas 24 h —fuera de esa ventana
 * Meta sólo deja pasar plantillas—, y es el caso de quien reservó por la web y nunca abrió un
 * chat. La plantilla tiene que estar declarada con HEADER de tipo IMAGE o Meta la rechaza.
 */
async function enviarPlantilla(a, nombre, params, idioma = 'es_AR', cfg = null) {
  const phone = (cfg && cfg.phone_id) || PHONE_ID;
  const token = (cfg && cfg.token) || TOKEN;
  if (!phone || !token) return { ok: false, motivo: 'sin_configurar' };
  try {
    const r = await fetch(`${API}/${phone}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(a).replace(/\D+/g, ''),
        type: 'template',
        template: {
          name: nombre,
          language: { code: idioma },
          components: [
            ...((cfg && cfg.imagen)
              ? [{ type: 'header', parameters: [{ type: 'image', image: { link: cfg.imagen } }] }]
              : []),
            ...((params && params.length)
              ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).slice(0, 200) })) }]
              : []),
          ],
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, motivo: (d.error && d.error.message) || `HTTP ${r.status}` };
    return { ok: true, id: d.messages && d.messages[0] && d.messages[0].id };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

// Mensajes interactivos. Sólo se pueden mandar DENTRO de la ventana de 24 h —o sea, cuando el
// cliente escribió primero—, que es exactamente el caso de una reserva por WhatsApp.
// Límites de Meta que hay que respetar o la API rechaza el mensaje entero:
//   · botones: hasta 3, y el título de cada uno hasta 20 caracteres;
//   · listas: hasta 10 filas, título de fila hasta 24 caracteres.
async function _enviarInteractivo(a, interactive, cfg) {
  const phone = (cfg && cfg.phone_id) || PHONE_ID;
  const token = (cfg && cfg.token) || TOKEN;
  if (!phone || !token) return { ok: false, motivo: 'sin_configurar' };
  try {
    const r = await fetch(`${API}/${phone}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(a).replace(/\D+/g, ''),
        type: 'interactive',
        interactive,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, motivo: (d.error && d.error.message) || `HTTP ${r.status}` };
    return { ok: true, id: d.messages && d.messages[0] && d.messages[0].id };
  } catch (e) { return { ok: false, motivo: e.message }; }
}

const _corte = (s, n) => String(s == null ? '' : s).slice(0, n);

async function enviarBotones(a, texto, botones, cfg = null) {
  return _enviarInteractivo(a, {
    type: 'button',
    body: { text: _corte(texto, 1024) },
    action: { buttons: botones.slice(0, 3).map(b => ({
      type: 'reply', reply: { id: _corte(b.id, 256), title: _corte(b.titulo, 20) } })) },
  }, cfg);
}

/**
 * Mensaje con un botón que ABRE UN LINK. Un texto con la URL adentro también es tocable, pero se
 * lee como un mensaje más y hay que apuntarle al renglón; esto es un botón, que es lo que la
 * persona espera cuando pidió "ver la carta".
 * WhatsApp admite un solo botón de este tipo por mensaje, y sólo con http/https.
 */
async function enviarBotonUrl(a, texto, rotulo, url, cfg = null) {
  return _enviarInteractivo(a, {
    type: 'cta_url',
    body: { text: _corte(texto, 1024) },
    action: { name: 'cta_url', parameters: { display_text: _corte(rotulo, 20), url: String(url) } },
  }, cfg);
}

async function enviarLista(a, texto, rotuloBoton, filas, cfg = null) {
  return _enviarInteractivo(a, {
    type: 'list',
    body: { text: _corte(texto, 1024) },
    action: {
      button: _corte(rotuloBoton, 20),
      sections: [{ rows: filas.slice(0, 10).map(f => ({
        id: _corte(f.id, 200), title: _corte(f.titulo, 24),
        ...(f.detalle ? { description: _corte(f.detalle, 72) } : {}) })) }],
    },
  }, cfg);
}

module.exports = { configurado, firmaValida, leerMensajes, enviarTexto, enviarImagen, enviarPlantilla, enviarBotonUrl,
                   enviarBotones, enviarLista, VERIFY };
