/* Respuestas frecuentes del canal de WhatsApp — ClaUsina v2.0.
 *
 * El problema que resuelve: hoy toda pregunta que no es una operación del bot cae al inbox y se
 * queda ahí hasta que una persona la lee. La mayoría son las mismas cinco preguntas — horarios,
 * dirección, estacionamiento, si aceptan tarjeta — y contestarlas solo baja el ruido a lo que de
 * verdad necesita a alguien.
 *
 * LA REGLA QUE HACE QUE ESTO SEA SEGURO: el modelo NO redacta la respuesta. Elige cuál de las
 * respuestas que escribió el negocio contesta la pregunta, y si ninguna contesta, elige ninguna.
 * Lo que sale por WhatsApp es el texto del negocio palabra por palabra. Un modelo redactando
 * horarios o precios sobre la marcha inventa, y acá un dato inventado es un cliente que llega a
 * un local cerrado.
 *
 * Elegir en vez de buscar por palabras clave es a propósito: "¿abren los domingos?", "trabajan
 * finde?" y "el domingo están?" son la misma pregunta y ningún conjunto de palabras clave las
 * junta sin juntar también las que no.
 */
const ia = require('./ia');

const SISTEMA_ELEGIR = `Te paso las preguntas frecuentes que un negocio ya respondió y un mensaje
que le acaba de llegar por WhatsApp. Tu única tarea es decidir cuál de esas respuestas contesta el
mensaje.

Reglas:
- Devolvé el índice de la entrada que responde el mensaje, o null si ninguna lo responde.
- Que hablen del mismo tema no alcanza: la respuesta guardada tiene que contestar lo que la
  persona preguntó. Si pregunta por el precio del estacionamiento y la entrada guardada dice
  dónde estacionar, eso es null.
- Si la persona pregunta dos cosas y la entrada contesta sólo una, es null: contestar la mitad
  hace creer que se contestó todo.
- Ante la duda, null. Que la pregunta pase a una persona cuesta una demora; que se conteste mal
  cuesta un cliente.
- No redactes nada. Sólo elegís un número.`;

/**
 * Devuelve el índice de la respuesta que aplica, o null.
 * Nunca lanza: si no se puede decidir, la pregunta sigue su camino al inbox.
 */
async function responder(texto, faq) {
  const t = String(texto || '').trim();
  if (!ia.disponible() || !t || !Array.isArray(faq) || !faq.length) return null;

  const r = await ia.pedirJson({
    sistema: SISTEMA_ELEGIR,
    esquema: {
      type: 'object',
      properties: {
        indice: { anyOf: [{ type: 'integer', enum: faq.map((_, i) => i) }, { type: 'null' }] },
      },
      required: ['indice'],
      additionalProperties: false,
    },
    prompt: `Preguntas frecuentes ya respondidas por el negocio:
${faq.map((f, i) => `[${i}] P: ${f.p}\n    R: ${f.r}`).join('\n')}

Mensaje que llegó:
"""
${t.slice(0, 1000)}
"""`,
  });

  const i = r && Number.isInteger(r.indice) ? r.indice : null;
  return (i != null && i >= 0 && i < faq.length) ? i : null;
}

const SISTEMA_SUGERIR = `Ayudás a un negocio a armar las respuestas frecuentes de su WhatsApp.

Te paso lo que la plataforma sabe del negocio. Devolvés una lista de preguntas que sus clientes
realmente le hacen a un negocio de ese rubro, cada una con su respuesta.

Reglas:
- Las PREGUNTAS las ponés vos: son las que la gente le hace a un negocio de este rubro, escritas
  como las escribiría un cliente por WhatsApp.
- Las RESPUESTAS salen ÚNICAMENTE de los datos que te paso. No completes con lo que sería
  razonable, ni con lo habitual del rubro, ni con lo que suene bien.
- Si el dato para responder no está, dejá la respuesta vacía y marcá origen="falta". Eso no es un
  fracaso: le está mostrando al negocio qué le falta cargar, que es la mitad del valor.
- Cuando la respuesta sí sale de los datos, marcá origen="datos" y escribila como la escribiría el
  negocio hablándole a un cliente: corta, concreta, sin saludo y sin firma.
- Entre 8 y 14 entradas, ordenadas de la más preguntada a la menos.
- No inventes horarios, precios, formas de pago, promociones ni políticas.`;

const ESQUEMA_SUGERIR = {
  type: 'object',
  properties: {
    entradas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          p: { type: 'string' },
          r: { type: 'string' },
          origen: { type: 'string', enum: ['datos', 'falta'] },
        },
        required: ['p', 'r', 'origen'],
        additionalProperties: false,
      },
    },
  },
  required: ['entradas'],
  additionalProperties: false,
};

/** Borradores para que el negocio edite. No se guarda nada acá: eso lo decide una persona. */
async function sugerir(ficha) {
  const r = await ia.pedirJson({
    sistema: SISTEMA_SUGERIR,
    esquema: ESQUEMA_SUGERIR,
    prompt: `Datos del negocio:\n${ficha}`,
    // Más margen que una extracción: son varias entradas redactadas.
    effort: 'medium', maxTokens: 8000,
  });
  if (!r || !Array.isArray(r.entradas)) return null;
  return r.entradas
    .map(e => ({ p: String(e.p || '').trim().slice(0, 200),
                 r: String(e.r || '').trim().slice(0, 700),
                 falta: e.origen !== 'datos' || !String(e.r || '').trim() }))
    .filter(e => e.p)
    .slice(0, 20);
}

module.exports = { disponible: ia.disponible, responder, sugerir };
