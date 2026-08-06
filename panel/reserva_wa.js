/* Reservar por WhatsApp — ClaUsina v2.0 / F5e.
 *
 * Un canal alternativo a la página pública. Funciona porque el cliente ESCRIBE PRIMERO: eso abre
 * la ventana de 24 h de Meta, dentro de la cual se puede contestar libremente y con botones y
 * listas, sin plantillas aprobadas.
 *
 * Lo que la ventana NO cambia es quién aprueba. La reserva entra por `crearReserva`, con las
 * mismas validaciones y el mismo lock de capacidad que la página y que el panel: no hay una
 * segunda puerta para reservar, hay un segundo mostrador para el mismo trámite.
 *
 * El flujo es guiado y no de texto libre a propósito. Interpretar "una mesa para el finde a la
 * noche" es tentador y frágil; una lista de días y una de turnos no se malinterpretan, y el
 * cliente no tiene que adivinar cómo hablarle a un sistema.
 */
const wa = require('./whatsapp');
const db = require('./db');

const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
// Singular, plural y género: sin el género sale "¿para cuántas cubiertos?".
const UNI = {
  personas:  ['persona',  'personas',  'f'],
  cubiertos: ['cubierto', 'cubiertos', 'm'],
  canchas:   ['cancha',   'canchas',   'f'],
  mesas:     ['mesa',     'mesas',     'f'],
  lugares:   ['lugar',    'lugares',   'm'],
  cupos:     ['cupo',     'cupos',     'm'],
};

const dia = iso => { const d = new Date(iso + 'T12:00:00'); return `${DOW[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`; };
const plural = (u, n) => (UNI[u] || UNI.personas)[n === 1 ? 0 : 1];
const cuantos = u => ((UNI[u] || UNI.personas)[2] === 'm' ? 'cuántos' : 'cuántas');
const SALIR = /^(cancelar|salir|basta|no|nada|chau|gracias)$/i;

/** Mensajes cortos: en WhatsApp un párrafo largo no se lee. */
async function decir(cfg, waId, texto, negocioId) {
  const r = await wa.enviarTexto(waId, texto, cfg);
  // Todo lo que dice el asistente queda en la bitácora: el inbox tiene que mostrar la
  // conversación completa, no sólo la mitad que escribió el cliente.
  if (negocioId) await db.logWhatsapp({
    direccion: 'saliente', wa_id: waId, negocio_id: negocioId, mensaje_id: r.id,
    tipo: 'text', texto, estado: r.ok ? 'enviado' : 'error',
  }).catch(() => {});
  return r;
}

/**
 * Procesa un mensaje entrante en el número de un negocio.
 * Devuelve true si lo atendió (y por lo tanto ya contestó), false si no aplica.
 */
async function atender(negocio, mensaje) {
  const waId = mensaje.wa_id;
  const cfgWa = await db.getWhatsappNegocio(negocio.id, true);
  if (!cfgWa || !cfgWa.wa_phone_id || !cfgWa.token) return false;
  const cfg = { phone_id: cfgWa.wa_phone_id, token: cfgWa.token };

  // Qué ofrece el bot lo decide el negocio en el configurador. Si no ofrece nada y el inbox
  // está apagado, no contesta: mejor callar que ofrecer algo que después no se puede cumplir.
  const canal = await db.getCanalWhatsapp(negocio.id);
  const ofreceReservas = canal.ofrece.includes('reservas') && await db.reservasPorWhatsapp(negocio.id);
  if (!ofreceReservas && !canal.inbox) return false;

  const entrada = String(mensaje.accion || mensaje.texto || '').trim();
  const conv = await db.getConversacion(negocio.id, waId);

  // Salida en cualquier momento. Que se pueda cortar es parte de que no sea molesto.
  if (SALIR.test(entrada)) {
    await db.borrarConversacion(negocio.id, waId);
    if (conv) await decir(cfg, waId, 'Listo, no reservé nada. Si querés, escribime cuando quieras.', negocio.id);
    return !!conv;
  }

  const paso = conv ? conv.paso : null;
  const datos = conv ? (conv.datos || {}) : {};

  try {
    if (!paso) return await saludar(cfg, negocio, waId, canal, ofreceReservas);
    // "Otra consulta": lo que sigue va al inbox para que lo lea una persona.
    if (paso === 'consulta') return await recibirConsulta(cfg, negocio, waId, mensaje);
    if (paso === 'ofrecido') {
      if (entrada === 'consulta') return await pedirConsulta(cfg, negocio, waId);
      if (!ofreceReservas) return await recibirConsulta(cfg, negocio, waId, mensaje);
      return await elegirDia(cfg, negocio, waId, entrada);
    }
    if (paso === 'dia') return await elegirTurno(cfg, negocio, waId, entrada, datos);
    if (paso === 'turno') return await pedirCantidad(cfg, negocio, waId, entrada, datos);
    if (paso === 'cantidad') return await pedirNombre(cfg, negocio, waId, entrada, datos);
    if (paso === 'nombre') return await confirmar(cfg, negocio, waId, entrada, datos);
  } catch (e) {
    console.error('reserva wa', e.message);
    await db.borrarConversacion(negocio.id, waId);
    await decir(cfg, waId, 'Perdón, se me complicó. Probá de nuevo escribiéndome "reservar".', negocio.id);
    return true;
  }
  return false;
}

async function saludar(cfg, negocio, waId, canal, ofreceReservas) {
  await db.setConversacion(negocio.id, waId, 'ofrecido', {});
  // El saludo lo escribe el negocio en el configurador; si no puso nada, se arma uno.
  const saludo = canal.saludo || `Hola. Soy el asistente de ${negocio.nombre}.`;
  const botones = [];
  if (ofreceReservas) botones.push({ id: 'reservar', titulo: 'Reservar' });
  if (canal.inbox) botones.push({ id: 'consulta', titulo: 'Otra consulta' });
  if (ofreceReservas) botones.push({ id: 'no', titulo: 'Ahora no' });

  if (!botones.length) return false;
  const r = await wa.enviarBotones(waId, `${saludo}\n\n¿En qué te puedo ayudar?`, botones, cfg);
  // Si los botones fallan (algún cliente viejo no los soporta), se sigue en texto plano.
  if (!r.ok) await decir(cfg, waId, saludo + (ofreceReservas
    ? '\n\nSi querés reservar, escribime "reservar". Si es otra cosa, contame y te respondemos.'
    : '\n\nContame en qué te puedo ayudar y te respondemos a la brevedad.'), negocio.id);
  return true;
}

// Consultas que no son una operación del bot: se guardan para que las lea una persona.
async function pedirConsulta(cfg, negocio, waId) {
  await db.setConversacion(negocio.id, waId, 'consulta', {});
  await decir(cfg, waId, 'Contame en qué te puedo ayudar y te respondemos a la brevedad.', negocio.id);
  return true;
}

async function recibirConsulta(cfg, negocio, waId, mensaje) {
  await db.borrarConversacion(negocio.id, waId);
  // El mensaje ya se guarda en la bitácora del webhook: acá sólo se acusa recibo. Prometer un
  // plazo que no controlamos sería peor que no prometer nada.
  await decir(cfg, waId, 'Gracias, ya le pasé tu mensaje al equipo. Te van a responder por acá.', negocio.id);
  return true;
}

// Los días que se ofrecen salen de la MISMA disponibilidad que la página pública: ya viene
// filtrada por anticipación, bloqueos y lugar libre.
async function elegirDia(cfg, negocio, waId, entrada) {
  if (entrada === 'no') {
    await db.borrarConversacion(negocio.id, waId);
    await decir(cfg, waId, 'Dale, cuando quieras. Acá estoy.', negocio.id);
    return true;
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const hasta = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const turnos = await db.disponibilidadPublica(negocio.id, hoy, hasta);
  const fechas = [...new Set(turnos.map(t => t.fecha))].sort().slice(0, 10);
  if (!fechas.length) {
    await db.borrarConversacion(negocio.id, waId);
    await decir(cfg, waId, 'Por ahora no tengo días disponibles. Probá más adelante.', negocio.id);
    return true;
  }
  await db.setConversacion(negocio.id, waId, 'dia', {});
  await wa.enviarLista(waId, '¿Para qué día?', 'Ver días',
    fechas.map(f => ({ id: 'd:' + f, titulo: dia(f) })), cfg);
  return true;
}

async function elegirTurno(cfg, negocio, waId, entrada, datos) {
  const fecha = entrada.startsWith('d:') ? entrada.slice(2) : null;
  if (!fecha) { await decir(cfg, waId, 'Elegí un día de la lista, por favor.', negocio.id); return true; }
  const turnos = (await db.disponibilidadPublica(negocio.id, fecha, fecha));
  if (!turnos.length) {
    await decir(cfg, waId, 'Ese día se quedó sin lugar. Escribime "reservar" y elegimos otro.', negocio.id);
    await db.borrarConversacion(negocio.id, waId);
    return true;
  }
  await db.setConversacion(negocio.id, waId, 'turno', { ...datos, fecha });
  await wa.enviarLista(waId, `${dia(fecha)}. ¿Qué turno?`, 'Ver turnos',
    turnos.map(t => ({ id: 't:' + t.turno_id, titulo: t.nombre,
                       detalle: `${t.hora_desde} a ${t.hora_hasta}` })), cfg);
  return true;
}

async function pedirCantidad(cfg, negocio, waId, entrada, datos) {
  const turnoId = entrada.startsWith('t:') ? entrada.slice(2) : null;
  if (!turnoId) { await decir(cfg, waId, 'Elegí un turno de la lista, por favor.', negocio.id); return true; }
  const cfgRes = await db.getConfigReservas(negocio.id);
  await db.setConversacion(negocio.id, waId, 'cantidad', { ...datos, turno_id: turnoId });
  await decir(cfg, waId, `¿Para ${cuantos(cfgRes.unidad)} ${plural(cfgRes.unidad, 2)}? Respondeme con un número.`, negocio.id);
  return true;
}

async function pedirNombre(cfg, negocio, waId, entrada, datos) {
  const n = parseInt(String(entrada).replace(/\D+/g, ''), 10);
  const cfgRes = await db.getConfigReservas(negocio.id);
  if (!n || n < cfgRes.cantidad_min) {
    await decir(cfg, waId, `Necesito un número. ¿Para ${cuantos(cfgRes.unidad)} ${plural(cfgRes.unidad, 2)}?`, negocio.id);
    return true;
  }
  await db.setConversacion(negocio.id, waId, 'nombre', { ...datos, cantidad: n });
  await decir(cfg, waId, '¿A nombre de quién?', negocio.id);
  return true;
}

const ERRORES = {
  sin_lugar: 'Justo se ocupó ese turno. Escribime "reservar" y buscamos otro.',
  cantidad_fuera: 'Esa cantidad no entra en una sola reserva. Escribime "reservar" y lo vemos.',
  muy_pronto: 'Falta muy poco para ese turno. Escribime "reservar" y elegimos otro.',
  muy_lejos: 'Todavía no se puede reservar tan adelante.',
  bloqueado: 'Ese día no está disponible.',
  turno_no_aplica: 'Ese turno no corre ese día.',
};

async function confirmar(cfg, negocio, waId, entrada, datos) {
  const nombre = String(entrada).trim().slice(0, 80);
  if (!nombre) { await decir(cfg, waId, '¿A nombre de quién?', negocio.id); return true; }

  let r;
  try {
    // Misma puerta que la página y el panel: mismas validaciones y el mismo lock de capacidad.
    r = await db.crearReserva(negocio.id, {
      turno_id: datos.turno_id, fecha: datos.fecha, cantidad: datos.cantidad,
      cliente_nombre: nombre, cliente_telefono: waId, canal: 'whatsapp',
    });
  } catch (e) {
    await db.borrarConversacion(negocio.id, waId);
    await decir(cfg, waId, ERRORES[e.code] || 'No pude tomar la reserva. Probá de nuevo más tarde.', negocio.id);
    return true;
  }

  await db.borrarConversacion(negocio.id, waId);
  const cfgRes = await db.getConfigReservas(negocio.id);
  const turnos = await db.disponibilidadPublica(negocio.id, datos.fecha, datos.fecha);
  const t = turnos.find(x => x.turno_id === datos.turno_id);
  const cuando = `${dia(datos.fecha)}${t ? `, ${t.nombre} ${t.hora_desde}` : ''}`;
  const cant = `${datos.cantidad} ${plural(cfgRes.unidad, datos.cantidad)}`;

  // Acá se ve la ventaja del canal: el cliente escribió primero, así que esta confirmación sale
  // sin plantilla y en el momento.
  await decir(cfg, waId, r.estado === 'confirmada'
    ? `¡Listo! Reserva confirmada en ${negocio.nombre}.\n\n${cuando}\n${cant}\nA nombre de ${nombre}\n\nTe esperamos.`
    : `Anotado. Tu pedido quedó registrado en ${negocio.nombre}.\n\n${cuando}\n${cant}\nA nombre de ${nombre}\n\nQueda pendiente de confirmación; te aviso por acá.`,
    negocio.id);
  return true;
}

module.exports = { atender };
