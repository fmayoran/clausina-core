/* Interpretar un mensaje del cliente: qué quiere y, si quiere reservar, con qué datos.
 *
 * Nació para las notas de voz (la transcripción la hace el host con whisper.cpp) pero el texto es
 * texto: hoy lo usan los dos caminos. Del mensaje salen la INTENCIÓN y, cuando es una reserva, sus
 * cuatro datos: día, turno, cantidad y nombre.
 *
 * POR QUÉ TAMBIÉN PARA EL TEXTO. La intención escrita se detectaba con una expresión regular y una
 * lista corta de verbos. "Necesito" entraba y "necesitaría" no; "podría" entraba y "podrías" no.
 * Sobre las conversaciones reales eso dejaba afuera "Tenés lugar para las 10:15", "Te reservo para
 * dos personas para hoy a la noche" y "Ahora me podrías reservar 4 cubiertos para las 14:00": gente
 * pidiendo exactamente lo que el bot sabe hacer, derivada a una persona.
 *
 * DOS DECISIONES QUE IMPORTAN
 *
 * 1. No se interpretan fechas en abstracto. "El próximo sábado" resuelto por aritmética de
 *    calendario da una fecha que después puede no existir en la agenda del negocio: día bloqueado,
 *    turno lleno, fuera de la ventana de anticipación. Al modelo se le pasa la MISMA lista de
 *    disponibilidad que ve el cliente en la página, y sólo puede elegir de ahí — el esquema lo
 *    restringe a esos valores. Lo que devuelve se vuelve a validar contra la lista igual: un id
 *    que sale de un modelo no entra a una consulta sin verificarse.
 *
 * 2. Fallar acá no rompe nada. Si no hay clave, si la API tarda, si el audio no se entiende o si
 *    lo que pide no es una reserva, la conversación cae al flujo guiado de siempre — listas y
 *    botones. La voz ahorra preguntas cuando funciona; cuando no, no cuesta nada.
 */
const ia = require('./ia');

const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const SISTEMA = `Sos el asistente de un negocio que toma reservas por WhatsApp. Te llega un mensaje de
un cliente —escrito, o la transcripción de una nota de voz— y tenés que decidir qué quiere y, si
quiere reservar, extraer los datos de la reserva.

Reglas:
- Elegí fecha y turno SOLAMENTE de la lista de opciones disponibles que te paso. Si el cliente
  pide un día que no está en la lista, dejá fecha en null; no elijas "el más parecido".
- Resolvé las referencias relativas ("mañana", "el sábado que viene", "el finde") contra la fecha
  de hoy y contra la lista, que ya viene ordenada de la más cercana a la más lejana.
- Si menciona un momento del día ("al mediodía", "a la noche", "temprano"), elegí el turno de esa
  fecha cuyo horario corresponda. Si hay varios posibles y no queda claro, dejá turno_id en null.
- fecha_pedida: el día que pidió, tal como lo dijo ("el próximo sábado", "el 25 de diciembre"),
  AUNQUE no esté en la lista. Va en null sólo si no mencionó ningún día. Sirve para poder
  decirle que ese día no hay, en vez de mostrarle otros sin explicar por qué.
- fecha_iso: ESE MISMO día en formato AAAA-MM-DD, resuelto contra la fecha de hoy, aunque no esté
  en la lista de disponibles. Sirve para saber si ese día está cerrado y decirlo. Null si no
  mencionó un día concreto o si no se puede resolver a una fecha exacta.
- La cantidad es cuánta gente va, no cuántas mesas ni la hora. "Somos cuatro" es 4.
- El nombre es el del cliente si lo dice. No lo inventes ni lo deduzcas del audio.
- Todo dato que no esté dicho con claridad va en null. Preguntar es barato; asumir mal, no.
- intencion clasifica QUÉ quiere la persona, y sirve para decidir a dónde va la conversación:
  - "reserva": está pidiendo reservar. Pedir una mesa, un lugar o un horario es reserva, con o sin
    la palabra "reservar". Preguntar SI se puede reservar, o cómo, no lo es: eso es "consulta".
  - "consulta": pregunta algo del negocio (carta, precios, horarios, si hay algo sin gluten).
  - "saludo": sólo saluda o abre la charla, sin pedir nada todavía.
  - "cortesia": agradece, confirma que le respondiste o cierra la charla. No espera respuesta.
  - "humano": pide hablar con una persona o con el local.
  - "otra": cualquier otra cosa (ofrecerse a trabajar, vender algo, un reclamo).
  Ante la duda entre "consulta" y otra cosa, elegí "consulta": que la pregunta siga su camino
  normal es inofensivo, mandarla a un flujo que no pidió no lo es.`;

/** El esquema restringe fecha y turno a lo que realmente hay: el modelo no puede inventar un día. */
function esquema(opciones) {
  const fechas = [...new Set(opciones.map(o => o.fecha))];
  const turnos = [...new Set(opciones.map(o => o.turno_id))];
  return {
    type: 'object',
    properties: {
      intencion: { type: 'string', enum: ['reserva', 'consulta', 'saludo', 'cortesia', 'humano', 'otra'] },
      fecha:     { anyOf: [{ type: 'string', enum: fechas }, { type: 'null' }] },
      turno_id:  { anyOf: [{ type: 'string', enum: turnos }, { type: 'null' }] },
      // Libre a propósito: es lo que la persona dijo, no un valor de la agenda. Es el único
      // campo que puede describir un día que NO existe, y para eso está.
      fecha_pedida: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      // La fecha pedida en formato de calendario, esté o no disponible: con ella se puede mirar
      // si ese día está bloqueado y contestar lo que corresponde en vez de "no hay lugar".
      fecha_iso: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      cantidad:  { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      nombre:    { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['intencion', 'fecha', 'turno_id', 'fecha_pedida', 'fecha_iso', 'cantidad', 'nombre'],
    additionalProperties: false,
  };
}

function prompt(texto, opciones, hoy, unidad) {
  const h = new Date(hoy + 'T12:00:00');
  const lista = opciones.map(o => {
    const d = new Date(o.fecha + 'T12:00:00');
    return `- fecha=${o.fecha} (${DOW[d.getDay()]}) turno_id=${o.turno_id} "${o.nombre}" ${o.hora_desde} a ${o.hora_hasta}`;
  }).join('\n');
  return `Hoy es ${DOW[h.getDay()]} ${hoy}.
La cantidad se mide en ${unidad}.

Opciones disponibles:
${lista}

Mensaje del cliente:
"""
${texto}
"""`;
}

/**
 * Devuelve { intencion, fecha, turno_id, cantidad, nombre } ya VALIDADO contra `opciones`,
 * o null si no se pudo interpretar (sin clave, error de API, sin disponibilidad).
 */
async function interpretar(texto, { opciones, hoy, unidad, cantidadMin, cantidadMax }) {
  if (!ia.disponible() || !texto || !opciones || !opciones.length) return null;

  const cruda = await ia.pedirJson({
    sistema: SISTEMA,
    prompt: prompt(texto, opciones, hoy, unidad),
    esquema: esquema(opciones),
  });
  if (!cruda) return null;

  return validar(cruda, { opciones, cantidadMin, cantidadMax });
}

/**
 * Nada de lo que devuelve el modelo se usa sin verificar. El esquema ya restringe los valores,
 * pero un id de turno termina en una consulta a la base y en una reserva real: se comprueba que
 * exista, que sea de esa fecha y que la cantidad entre en lo que queda libre.
 */
function validar(c, { opciones, cantidadMin, cantidadMax }) {
  if (!c || typeof c !== 'object') return null;
  const INTENCIONES = ['reserva', 'consulta', 'saludo', 'cortesia', 'humano', 'otra'];
  const r = { intencion: INTENCIONES.includes(c.intencion) ? c.intencion : 'otra',
              fecha: null, turno_id: null, fecha_pedida: null, fecha_iso: null,
              cantidad: null, nombre: null };
  // Los datos de reserva sólo se leen si la intención es reservar. Quien llama distingue por
  // `intencion`, y los caminos viejos que preguntaban `!== 'reserva'` siguen andando igual.
  if (r.intencion !== 'reserva') return r;

  // No se valida contra nada: es texto de la persona y sólo se usa para repetírselo.
  const ped = String(c.fecha_pedida || '').trim();
  if (ped && ped.length <= 60) r.fecha_pedida = ped;

  // Una fecha que sale de un modelo y va a consultarse contra la base: se comprueba la forma y
  // que caiga en un rango razonable. Un "2026-13-45" no llega a ninguna consulta.
  const iso = String(c.fecha_iso || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !isNaN(Date.parse(iso + 'T12:00:00'))) {
    const dias = (Date.parse(iso + 'T12:00:00') - Date.now()) / 864e5;
    if (dias > -2 && dias < 400) r.fecha_iso = iso;
  }

  const delDia = opciones.filter(o => o.fecha === c.fecha);
  if (delDia.length) r.fecha = c.fecha;

  const t = r.fecha ? delDia.find(o => o.turno_id === c.turno_id) : null;
  if (t) r.turno_id = t.turno_id;

  const n = Number.isInteger(c.cantidad) ? c.cantidad : null;
  // El tope del turno elegido sólo aplica si se eligió turno; si no, alcanza con el rango general.
  const tope = Math.min(cantidadMax || Infinity, t ? t.tope : Infinity);
  if (n && n >= (cantidadMin || 1) && n <= tope) r.cantidad = n;

  // Un nombre de una sola letra o una frase entera no son un nombre: mejor preguntarlo.
  const nom = String(c.nombre || '').trim();
  if (nom.length >= 3 && nom.length <= 80 && nom.split(/\s+/).length <= 5) r.nombre = nom;

  return r;
}

module.exports = { disponible: ia.disponible, interpretar };
