'use strict';
/**
 * Normalización de números para WhatsApp.
 *
 * El problema, visto en datos reales del panel: la misma línea cargada de tres formas distintas
 * —`+5491150466474`, `+541150466474`, `5491161735082`—. WhatsApp entrega el remitente en UN solo
 * formato canónico, así que una búsqueda literal le diría "no tenés acceso" a alguien que sí lo
 * tiene, sin explicación visible.
 *
 * Estrategia en dos capas:
 *  1. `normalizar()` canoniza lo que puede (saca el 0 de larga distancia, el 15 de celular,
 *     agrega el 9 que Argentina necesita en internacional).
 *  2. `clave()` se queda con los últimos 10 dígitos y ESA es la que se compara. Así el con-9,
 *     el sin-9, el con-+ y el sin-país caen todos en el mismo casillero sin depender de que la
 *     canonización haya sido perfecta.
 */

const soloDigitos = s => String(s == null ? '' : s).replace(/\D+/g, '');

/**
 * Devuelve el número en formato internacional sin símbolos, o '' si no parece un teléfono.
 * Pensado para Argentina, tolerante con el resto: si ya viene con otro país, no lo toca.
 */
function normalizar(entrada) {
  let d = soloDigitos(entrada);
  if (!d) return '';

  if (d.startsWith('00')) d = d.slice(2);          // prefijo internacional a la vieja usanza
  if (d.startsWith('0')) d = d.slice(1);           // 0 de larga distancia nacional

  if (d.startsWith('54')) {
    let r = d.slice(2);
    if (r.startsWith('0')) r = r.slice(1);
    // El 15 es prefijo LOCAL de celular: no va en internacional. Vive pegado al código de área,
    // que en Argentina mide 2, 3 o 4 dígitos.
    if (r.length === 12) {
      for (const pos of [2, 3, 4]) {
        if (r.slice(pos, pos + 2) === '15') { r = r.slice(0, pos) + r.slice(pos + 2); break; }
      }
    }
    // WhatsApp usa 54 + 9 + área + abonado para celulares.
    if (r.length === 10 && !r.startsWith('9')) r = '9' + r;
    return '54' + r;
  }

  // Sin código de país: si mide 10 u 11, asumimos Argentina (es el caso real del panel).
  if (d.length === 11 && d.startsWith('9')) return '54' + d;
  if (d.length === 10) return '549' + d;
  if (d.length === 12 && d.slice(2, 4) === '15') return '549' + d.slice(0, 2) + d.slice(4);

  return d;   // otro país o algo que no sabemos leer: lo dejamos como vino
}

/** Clave de comparación: los últimos 10 dígitos (área + abonado). '' si no alcanza. */
function clave(entrada) {
  const d = soloDigitos(normalizar(entrada));
  return d.length >= 10 ? d.slice(-10) : '';
}

/** Para mostrar: +54 9 11 5046-6474. Si no lo reconoce, devuelve lo normalizado con +. */
function lindo(entrada) {
  const n = normalizar(entrada);
  if (!n) return '';
  const m = n.match(/^54(9?)(\d{2,4})(\d{4})(\d{4})$/);
  return m ? `+54 ${m[1] ? '9 ' : ''}${m[2]} ${m[3]}-${m[4]}` : '+' + n;
}

module.exports = { normalizar, clave, lindo, soloDigitos };
