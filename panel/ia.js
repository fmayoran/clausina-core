/* Una sola puerta hacia Claude desde el panel — ClaUsina v2.0.
 *
 * Todo lo que el panel le pregunta al modelo pasa por acá y devuelve JSON con forma fija. El
 * esquema no es decoración: es lo que hace que la respuesta se pueda usar sin adivinar, y lo que
 * permite restringir un campo a una lista cerrada de valores válidos.
 *
 * Centralizado a propósito. El manejo de un rechazo, de un corte por longitud y del bloque de
 * texto entre los de pensamiento es fácil de escribir mal, y escrito mal falla en silencio: se
 * lee `content[0].text` de una respuesta que empieza con un bloque de pensamiento y sale
 * undefined. Una sola copia, probada, en vez de una por consumidor.
 */
const Anthropic = require('@anthropic-ai/sdk');

let _cliente = null;
const disponible = () => !!process.env.ANTHROPIC_API_KEY;

function cliente() {
  // 25 s: del otro lado suele haber alguien esperando en WhatsApp. Si tarda más, la respuesta
  // que sirve ya no es esta — es la pregunta guiada.
  if (!_cliente) _cliente = new Anthropic({ timeout: 25000, maxRetries: 1 });
  return _cliente;
}

/**
 * Pide una respuesta con forma de `esquema`. Devuelve el objeto parseado, o null si no se pudo
 * (sin clave, error de red, rechazo, corte). Nunca lanza: quien llama tiene que poder seguir.
 */
async function pedirJson({ sistema, prompt, esquema, effort = 'low', maxTokens = 2000 }) {
  if (!disponible()) return null;
  try {
    const r = await cliente().beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: maxTokens,
      system: sistema,
      // El pensamiento viene activado por defecto y cuenta contra max_tokens; con effort bajo
      // alcanza de sobra para extraer o clasificar, y es lo que menos hace esperar.
      output_config: { effort, format: { type: 'json_schema', schema: esquema } },
      // Si los clasificadores rechazan el pedido, la API lo reintenta sola en otro modelo dentro
      // de la misma llamada. No debería pasar nunca acá, pero sin esto un rechazo deja al cliente
      // sin respuesta y sin explicación.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    // stop_reason se mira ANTES del contenido: en un rechazo viene vacío y en un corte por
    // longitud viene un JSON a medias que no parsea.
    if (r.stop_reason === 'refusal' || r.stop_reason === 'max_tokens') {
      console.log('ia: sin respuesta usable (stop_reason=' + r.stop_reason + ')');
      return null;
    }
    // El primer bloque puede ser de pensamiento: se busca el de texto, no se asume el índice 0.
    const bloque = (r.content || []).find(b => b.type === 'text');
    return bloque ? JSON.parse(bloque.text) : null;
  } catch (e) {
    console.error('ia', e.message);
    return null;
  }
}

module.exports = { disponible, pedirJson };
