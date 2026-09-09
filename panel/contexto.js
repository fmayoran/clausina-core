/* Responder con lo que el negocio ya publicó — ClaUsina.
 *
 * EL PROBLEMA. Las respuestas frecuentes son exactas pero cerradas: contestan la pregunta que
 * alguien previó y ninguna otra. Sobre las conversaciones reales, media docena de consultas por
 * semana estaban contestadas en material que la plataforma YA tiene —la carta online, las
 * publicaciones de Instagram— y terminaban en "ya le pasé tu mensaje al equipo".
 *
 * LA REGLA QUE LO HACE SEGURO. El modelo puede redactar, pero SÓLO con lo que está en el material
 * que se le pasa. No completa con lo que sabe del mundo, no deduce y no estima. Si el material no
 * lo dice, devuelve null y la consulta sigue su camino a una persona.
 *
 * Y SE DECLARA. Toda respuesta de acá sale rotulada ("Según la carta publicada…", "Según lo que
 * publicamos el 4/9…"). Es lo que pidió Fer y es lo correcto: quien lee sabe de dónde salió el
 * dato y puede desconfiar. Una respuesta sin fuente se lee como una promesa del negocio; con la
 * fuente, se lee como lo que es —lo que está publicado— y un error involuntario queda acotado.
 */
const ia = require('./ia');

const SISTEMA = `Sos el asistente de un negocio y te llega una consulta por WhatsApp. Te paso el
material que el negocio tiene publicado. Tu tarea es contestar SOLAMENTE con lo que está en ese
material.

Reglas, en orden de importancia:
- Si el material no contesta la consulta, devolvé respuesta en null. Es la respuesta correcta la
  mayoría de las veces y no cuesta nada: la consulta pasa a una persona.
- No completes con lo que sepas del mundo. No deduzcas, no estimes, no redondees, no supongas.
  Un precio que no está escrito no se calcula; un horario que no está escrito no se infiere.
- Nada de disponibilidad ni de reservas: si preguntan si hay lugar, es null. Eso lo maneja otro
  circuito que mira la agenda de verdad.
- Citá los datos como están. Si la carta dice "$20.000,00", el precio es ese.
- Si la consulta tiene dos partes y el material contesta una sola, contestá esa y decí que la otra
  la ve el equipo. Media respuesta declarada es útil; media respuesta disfrazada de completa, no.
- Escribí en español rioplatense, breve —dos o tres frases—, sin emojis, sin saludos ni
  presentaciones: la charla ya viene empezada.
- No prometas nada en nombre del negocio ("te lo reservamos", "te hacemos un descuento").
- fuente: de dónde sacaste la respuesta, en tres palabras y en minúscula, para poder decírselo a
  la persona. Usá "la carta publicada" o "lo que publicamos" según corresponda.`;

/**
 * Devuelve { respuesta, fuente } o null.
 * Nunca lanza: sin clave, sin material o ante cualquier error, la consulta sigue al inbox.
 */
async function responder(texto, material) {
  const t = String(texto || '').trim();
  if (!ia.disponible() || !t || !material || !material.trim()) return null;

  const r = await ia.pedirJson({
    sistema: SISTEMA,
    esquema: {
      type: 'object',
      properties: {
        respuesta: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        fuente: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['respuesta', 'fuente'],
      additionalProperties: false,
    },
    prompt: `Material publicado por el negocio:
${material.slice(0, 24000)}

Consulta que llegó:
"""
${t.slice(0, 1000)}
"""`,
  }).catch(() => null);

  if (!r || !r.respuesta) return null;
  const resp = String(r.respuesta).trim();
  // Una respuesta de dos palabras no es una respuesta, y una de mil no entra en un WhatsApp.
  if (resp.length < 15 || resp.length > 900) return null;
  const fuente = String(r.fuente || '').trim().slice(0, 40) || 'lo publicado';
  return { respuesta: resp, fuente };
}

/** El texto tal como sale por WhatsApp: la respuesta, precedida por de dónde salió. */
function conFuente({ respuesta, fuente }) {
  return `Según ${fuente}: ${respuesta}`;
}

module.exports = { responder, conFuente };
