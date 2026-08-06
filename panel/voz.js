/* Interpretar una nota de voz como una reserva — ClaUsina v2.0 / F5g, paso 2.
 *
 * La transcripción la hace el host (whisper.cpp). Acá sólo se lee ese texto y se lo convierte en
 * los cuatro datos de una reserva: día, turno, cantidad y nombre.
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
const Anthropic = require('@anthropic-ai/sdk');

const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

let _cliente = null;
const disponible = () => !!process.env.ANTHROPIC_API_KEY;

function cliente() {
  // 25 s: el cliente está esperando del otro lado. Si tarda más que eso, preguntarle es más
  // rápido que seguir esperando.
  if (!_cliente) _cliente = new Anthropic({ timeout: 25000, maxRetries: 1 });
  return _cliente;
}

const SISTEMA = `Sos el asistente de un negocio que toma reservas por WhatsApp. Te llega la
transcripción de una nota de voz de un cliente y tenés que extraer los datos de la reserva.

Reglas:
- Elegí fecha y turno SOLAMENTE de la lista de opciones disponibles que te paso. Si el cliente
  pide un día que no está en la lista, dejá fecha en null; no elijas "el más parecido".
- Resolvé las referencias relativas ("mañana", "el sábado que viene", "el finde") contra la fecha
  de hoy y contra la lista, que ya viene ordenada de la más cercana a la más lejana.
- Si menciona un momento del día ("al mediodía", "a la noche", "temprano"), elegí el turno de esa
  fecha cuyo horario corresponda. Si hay varios posibles y no queda claro, dejá turno_id en null.
- La cantidad es cuánta gente va, no cuántas mesas ni la hora. "Somos cuatro" es 4.
- El nombre es el del cliente si lo dice. No lo inventes ni lo deduzcas del audio.
- Todo dato que no esté dicho con claridad va en null. Preguntar es barato; asumir mal, no.
- intencion es "reserva" sólo si está pidiendo reservar. Una consulta, un reclamo, un saludo o
  cualquier otra cosa es "otra".`;

/** El esquema restringe fecha y turno a lo que realmente hay: el modelo no puede inventar un día. */
function esquema(opciones) {
  const fechas = [...new Set(opciones.map(o => o.fecha))];
  const turnos = [...new Set(opciones.map(o => o.turno_id))];
  return {
    type: 'object',
    properties: {
      intencion: { type: 'string', enum: ['reserva', 'otra'] },
      fecha:     { anyOf: [{ type: 'string', enum: fechas }, { type: 'null' }] },
      turno_id:  { anyOf: [{ type: 'string', enum: turnos }, { type: 'null' }] },
      cantidad:  { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      nombre:    { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['intencion', 'fecha', 'turno_id', 'cantidad', 'nombre'],
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

Transcripción de la nota de voz:
"""
${texto}
"""`;
}

/**
 * Devuelve { intencion, fecha, turno_id, cantidad, nombre } ya VALIDADO contra `opciones`,
 * o null si no se pudo interpretar (sin clave, error de API, sin disponibilidad).
 */
async function interpretar(texto, { opciones, hoy, unidad, cantidadMin, cantidadMax }) {
  if (!disponible() || !texto || !opciones || !opciones.length) return null;

  let cruda;
  try {
    const r = await cliente().beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      system: SISTEMA,
      // El pensamiento viene activado por defecto y cuenta contra max_tokens; con effort bajo
      // alcanza y de sobra para una extracción, y es lo que menos hace esperar al cliente.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: esquema(opciones) } },
      // Si los clasificadores rechazan el pedido, la API lo reintenta sola en otro modelo en la
      // misma llamada. Un audio de reserva no debería activarlos nunca, pero sin esto un rechazo
      // deja al cliente sin respuesta.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt(texto, opciones, hoy, unidad) }],
    });
    // stop_reason se mira ANTES del contenido: en un rechazo viene vacío, y en un corte por
    // longitud viene un JSON a medias que no parsea.
    if (r.stop_reason === 'refusal' || r.stop_reason === 'max_tokens') {
      console.log('voz: sin interpretación (stop_reason=' + r.stop_reason + ')');
      return null;
    }
    const bloque = (r.content || []).find(b => b.type === 'text');
    if (!bloque) return null;
    cruda = JSON.parse(bloque.text);
  } catch (e) {
    console.error('voz interpretar', e.message);
    return null;
  }

  return validar(cruda, { opciones, cantidadMin, cantidadMax });
}

/**
 * Nada de lo que devuelve el modelo se usa sin verificar. El esquema ya restringe los valores,
 * pero un id de turno termina en una consulta a la base y en una reserva real: se comprueba que
 * exista, que sea de esa fecha y que la cantidad entre en lo que queda libre.
 */
function validar(c, { opciones, cantidadMin, cantidadMax }) {
  if (!c || typeof c !== 'object') return null;
  const r = { intencion: c.intencion === 'reserva' ? 'reserva' : 'otra',
              fecha: null, turno_id: null, cantidad: null, nombre: null };
  if (r.intencion === 'otra') return r;

  const delDia = opciones.filter(o => o.fecha === c.fecha);
  if (delDia.length) r.fecha = c.fecha;

  const t = r.fecha ? delDia.find(o => o.turno_id === c.turno_id) : null;
  if (t) r.turno_id = t.turno_id;

  const n = Number.isInteger(c.cantidad) ? c.cantidad : null;
  // El tope del turno elegido sólo aplica si se eligió turno; si no, alcanza con el rango general.
  const tope = Math.min(cantidadMax || Infinity, t ? t.libre : Infinity);
  if (n && n >= (cantidadMin || 1) && n <= tope) r.cantidad = n;

  // Un nombre de una sola letra o una frase entera no son un nombre: mejor preguntarlo.
  const nom = String(c.nombre || '').trim();
  if (nom.length >= 3 && nom.length <= 80 && nom.split(/\s+/).length <= 5) r.nombre = nom;

  return r;
}

module.exports = { disponible, interpretar };
