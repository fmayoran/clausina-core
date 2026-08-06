/* Códigos de invitación — ClaUsina v2.0 / F6.
 *
 * Un código que se manda por WhatsApp y que alguien va a tipear a mano o dictar por teléfono.
 * Eso manda todas las decisiones de acá.
 */

const { randomInt } = require('crypto');

// Sin 0/O, sin 1/I/L: son los pares que se confunden leyendo una pantalla y dictando por
// teléfono, y cada confusión es una persona convencida de que el código no anda.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LARGO = 5;   // 5 al azar + 1 verificador = 6 visibles

/**
 * Dígito verificador. No es seguridad —el código igual se busca en la base— es diagnóstico:
 * un código mal tipeado se puede rechazar en el acto como "código inválido" en vez de "no
 * existe". La diferencia importa: ante "no existe" la gente insiste con el mismo error.
 */
function verificador(cuerpo) {
  let suma = 0;
  for (let i = 0; i < cuerpo.length; i++) {
    // El peso por posición hace que dos caracteres intercambiados den distinto, que es el otro
    // error de tipeo frecuente además de confundir una letra.
    suma += (ALFABETO.indexOf(cuerpo[i]) + 1) * (i + 2);
  }
  return ALFABETO[suma % ALFABETO.length];
}

/**
 * Limpia lo que escribió una persona: mayúsculas y sin separadores. No intenta "corregir" letras.
 * El alfabeto ya excluye 0/O y 1/I/L, así que un código NUNCA las contiene: si aparecen, es un
 * error de lectura y adivinar cuál era la buena convierte un código inválido en uno ajeno.
 */
const limpiar = txt => String(txt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function generar() {
  // randomInt y no Math.random: un código acertado es un descuento regalado, y Math.random es
  // predecible por diseño. El costo de usar el azar bueno acá es cero.
  let cuerpo = '';
  for (let i = 0; i < LARGO; i++) cuerpo += ALFABETO[randomInt(ALFABETO.length)];
  return cuerpo + verificador(cuerpo);
}

/** ¿Tiene forma de código válido? Sirve para descartar sin ir a la base. */
function formaValida(codigo) {
  const c = String(codigo || '').toUpperCase();
  if (c.length !== LARGO + 1) return false;
  if (![...c].every(x => ALFABETO.includes(x))) return false;
  return verificador(c.slice(0, LARGO)) === c[LARGO];
}

/**
 * Extrae un código de un texto libre ("hola, tengo el código K7M2XQ" o una nota de voz
 * transcripta). Devuelve el primero que además pase el verificador: sin esa condición, cualquier
 * palabra de seis letras del mensaje se tomaría por un código.
 */
function buscarEnTexto(texto) {
  // Por PALABRAS, no barriendo el texto entero. Pegar las palabras y buscar ventanas de seis
  // parece más tolerante, pero una ventana cualquiera pasa el verificador 1 de cada 31 veces:
  // "una mesa cerca de la ventana" produce ESACER, que valida y no es ningún código. Una palabra
  // que sea EXACTAMENTE un código válido es una condición mucho más difícil de cumplir por azar.
  const t = String(texto || '').toUpperCase()
    // El guión con que se muestra (XYP-K7P) se saca sólo si está entre dos caracteres del
    // alfabeto: así no se pega a la palabra de al lado.
    .replace(new RegExp(`(?<=[${ALFABETO}])[.·-](?=[${ALFABETO}])`, 'g'), '');

  const palabras = t.split(/[^A-Z0-9]+/).filter(Boolean);
  for (const w of palabras) if (formaValida(w)) return w;

  // Dictado letra por letra ("E W H 7 3 4"): se pegan sólo las corridas de palabras de UN
  // carácter. Nunca junta dos palabras de verdad, que es de donde salían los falsos positivos.
  let corrida = '';
  for (const w of palabras.concat([''])) {
    if (w.length === 1) { corrida += w; continue; }
    for (let i = 0; corrida && i + LARGO + 1 <= corrida.length; i++) {
      const c = corrida.slice(i, i + LARGO + 1);
      if (formaValida(c)) return c;
    }
    corrida = '';
  }
  return null;
}

/** Cómo se le muestra a una persona: en dos bloques se lee y se dicta mucho mejor. */
const bonito = codigo => String(codigo || '').replace(/^(.{3})(.{3})$/, '$1-$2');

module.exports = { generar, formaValida, buscarEnTexto, limpiar, bonito, ALFABETO, LARGO };
