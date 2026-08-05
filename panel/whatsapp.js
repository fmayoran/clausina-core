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
function firmaValida(rawBody, header) {
  if (!APP_SECRET) return true;
  const esperado = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Aplana el webhook de Meta, que viene con tres niveles de anidamiento. */
function leerMensajes(cuerpo) {
  const out = [];
  for (const entrada of cuerpo.entry || []) {
    for (const c of entrada.changes || []) {
      const v = c.value || {};
      for (const m of v.messages || []) {
        out.push({
          mensaje_id: m.id,
          wa_id: m.from,
          tipo: m.type,
          // El texto puede venir de un mensaje suelto o del botón que tocaron.
          texto: (m.text && m.text.body)
            || (m.button && m.button.text)
            || (m.interactive && m.interactive.button_reply && m.interactive.button_reply.title)
            || '',
          // Los botones traen un id propio: es lo que usamos para saber QUÉ acción pidió.
          accion: (m.interactive && m.interactive.button_reply && m.interactive.button_reply.id)
            || (m.button && m.button.payload) || '',
          crudo: m,
        });
      }
    }
  }
  return out;
}

async function enviarTexto(a, texto) {
  if (!configurado()) return { ok: false, motivo: 'sin_configurar' };
  try {
    const r = await fetch(`${API}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
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
async function enviarPlantilla(a, nombre, params, idioma = 'es_AR') {
  if (!configurado()) return { ok: false, motivo: 'sin_configurar' };
  try {
    const r = await fetch(`${API}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(a).replace(/\D+/g, ''),
        type: 'template',
        template: {
          name: nombre,
          language: { code: idioma },
          components: (params && params.length)
            ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).slice(0, 200) })) }]
            : [],
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

module.exports = { configurado, firmaValida, leerMensajes, enviarTexto, enviarPlantilla, VERIFY };
