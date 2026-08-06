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
const voz = require('./voz');

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

  // Una nota de voz no trae texto: se transcribe aparte, en el host. Acá sólo se acusa recibo
  // para que nadie quede mirando la pantalla; el resto lo sigue `seguirVoz`, que espera la
  // transcripción sin bloquear el webhook.
  if (mensaje.tipo === 'audio' && !String(mensaje.texto || '').trim()) {
    await decir(cfg, waId, voz.disponible()
      ? 'Escuchando tu audio, dame un segundo…'
      : 'Recibí tu audio. Por ahora lo estamos escuchando nosotros: si querés avanzar más rápido, ' +
        'escribime "reservar".', negocio.id);
    return true;
  }

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
    if (!paso) return await saludar(cfg, negocio, waId, canal, ofreceReservas, mensaje.perfil);
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
    if (paso === 'confirmar_voz') return await confirmarVoz(cfg, negocio, waId, entrada, datos);
  } catch (e) {
    console.error('reserva wa', e.message);
    await db.borrarConversacion(negocio.id, waId);
    await decir(cfg, waId, 'Perdón, se me complicó. Probá de nuevo escribiéndome "reservar".', negocio.id);
    return true;
  }
  return false;
}

async function saludar(cfg, negocio, waId, canal, ofreceReservas, perfil) {
  await db.setConversacion(negocio.id, waId, 'ofrecido', {});
  // El saludo lo escribe el negocio en el configurador; si no puso nada, se arma uno.
  // Si WhatsApp nos da el nombre del perfil, se usa el primero para que no suene a máquina.
  const nombrePila = String(perfil || '').trim().split(/\s+/)[0] || '';
  // Si el saludo que escribió el negocio ya arranca con "hola", se le saca para no duplicarlo:
  // "Hola Fernando. Hola, soy el asistente…" suena a error, y es el que va a escribir cualquiera.
  const propio = String(canal.saludo || '').trim();
  const base = (propio || `Soy el asistente de ${negocio.nombre}.`)
    .replace(/^[¡\s]*hola[\s,.!¡]*/i, '')
    .replace(/^./, c => c.toUpperCase());
  const saludo = nombrePila ? `Hola ${nombrePila}. ${base}` : `Hola. ${base}`;
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
  // Nombre Y apellido: es lo que queda en la base del negocio, y un nombre suelto no alcanza
  // para reconocer a alguien cuando llega.
  await decir(cfg, waId, 'Por último, decime tu nombre y apellido, por favor.', negocio.id);
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
  if (!nombre) { await decir(cfg, waId, 'Decime tu nombre y apellido, por favor.', negocio.id); return true; }

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

// ── Nota de voz ───────────────────────────────────────────────────────────────
// La voz NO es un flujo aparte: precarga el mismo flujo guiado y salta a la primera pregunta que
// falta. Un segundo camino para reservar sería un segundo lugar donde equivocarse con la
// capacidad, la anticipación y los bloqueos.

const VENTANA_MS = 60000;   // lo que se espera la transcripción antes de preguntar a mano
const PASO_MS = 2000;

/** El worker del host escribe el texto en la misma fila. Se lo espera sin bloquear el webhook. */
async function esperarTranscripcion(mensajeId) {
  const hasta = Date.now() + VENTANA_MS;
  while (Date.now() < hasta) {
    await new Promise(r => setTimeout(r, PASO_MS));
    const t = await db.transcripcionDe(mensajeId).catch(() => null);
    // El worker escribe un texto entre corchetes cuando no hay voz reconocible o el audio es
    // demasiado largo: eso no se interpreta, se trata como si no hubiera llegado nada.
    if (t) return /^\[.*\]$/.test(t.trim()) ? null : t;
  }
  return null;
}

/**
 * Se llama después de guardar el mensaje, SIN await: espera la transcripción, la interpreta y
 * deja la conversación lo más avanzada posible. Cualquier fallo cae al flujo guiado.
 */
async function seguirVoz(negocio, mensaje) {
  // Sin clave no hay interpretación posible, y entonces tampoco hay nada que seguir: el mensaje
  // ya quedó en el inbox y el cliente ya recibió el acuse. Salir acá deja el comportamiento
  // idéntico al de antes de esta función, que es lo que corresponde cuando falta la mitad.
  if (!voz.disponible()) return;
  const waId = mensaje.wa_id;
  const cfgWa = await db.getWhatsappNegocio(negocio.id, true);
  if (!cfgWa || !cfgWa.wa_phone_id || !cfgWa.token) return;
  const cfg = { phone_id: cfgWa.wa_phone_id, token: cfgWa.token };

  const canal = await db.getCanalWhatsapp(negocio.id);
  const ofreceReservas = canal.ofrece.includes('reservas') && await db.reservasPorWhatsapp(negocio.id);

  const texto = await esperarTranscripcion(mensaje.mensaje_id);
  // Sin transcripción no se inventa nada: queda en el inbox para que lo escuche una persona, y al
  // cliente se le ofrece el camino que sí funciona.
  if (!texto) {
    if (ofreceReservas) {
      await decir(cfg, waId, 'No llegué a entender bien el audio. Si querés, lo hacemos por acá.', negocio.id);
      return void await elegirDia(cfg, negocio, waId, '');
    }
    return void await decir(cfg, waId, 'Gracias, ya le pasé tu mensaje al equipo. Te van a responder por acá.', negocio.id);
  }

  if (!ofreceReservas) return void await recibirConsulta(cfg, negocio, waId, mensaje);

  const cfgRes = await db.getConfigReservas(negocio.id);
  const hoy = new Date().toISOString().slice(0, 10);
  const hasta = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const opciones = await db.disponibilidadPublica(negocio.id, hoy, hasta);

  const i = await voz.interpretar(texto, {
    opciones, hoy, unidad: cfgRes.unidad,
    cantidadMin: cfgRes.cantidad_min, cantidadMax: cfgRes.cantidad_max,
  });

  // No se entendió, o el audio no era para reservar: al inbox, que es donde lo va a leer alguien.
  if (!i) return void await elegirDia(cfg, negocio, waId, '');
  if (i.intencion !== 'reserva') return void await recibirConsulta(cfg, negocio, waId, mensaje);

  // Cada rama entra por el paso que ya existe, con una entrada armada — así la validación de
  // disponibilidad, el rango de cantidad y el texto de las preguntas son exactamente los mismos
  // que cuando el cliente escribe.
  const d = { fecha: i.fecha, turno_id: i.turno_id };
  if (!i.fecha)    return void await elegirDia(cfg, negocio, waId, '');
  if (!i.turno_id) return void await elegirTurno(cfg, negocio, waId, 'd:' + i.fecha, {});
  if (!i.cantidad) return void await pedirCantidad(cfg, negocio, waId, 't:' + i.turno_id, { fecha: i.fecha });
  if (!i.nombre)   return void await pedirNombre(cfg, negocio, waId, String(i.cantidad), d);

  // Están los cuatro datos: se muestra lo entendido y se pide un sí. Que el último paso siga
  // siendo humano es la regla de la casa, y acá además protege de una transcripción torcida.
  const t = opciones.find(o => o.turno_id === i.turno_id);
  const resumen = `${dia(i.fecha)}${t ? `, ${t.nombre} ${t.hora_desde}` : ''}\n` +
                  `${i.cantidad} ${plural(cfgRes.unidad, i.cantidad)}\nA nombre de ${i.nombre}`;
  await db.setConversacion(negocio.id, waId, 'confirmar_voz',
    { ...d, cantidad: i.cantidad, nombre: i.nombre });
  const r = await wa.enviarBotones(waId, `Entendí esto:\n\n${resumen}\n\n¿Lo confirmo?`,
    [{ id: 'ok_voz', titulo: 'Sí, confirmá' }, { id: 'cambiar_voz', titulo: 'Cambiar algo' }], cfg);
  if (!r.ok) await decir(cfg, waId, `Entendí esto:\n\n${resumen}\n\nRespondeme "sí" para confirmarlo.`, negocio.id);
}

const SI = /^(s[ií]|dale|ok|oka?y|confirm[oá]|listo|correcto|exacto|perfecto)\b/i;

async function confirmarVoz(cfg, negocio, waId, entrada, datos) {
  if (entrada === 'ok_voz' || SI.test(entrada)) {
    // Entra por la misma puerta que todo el resto: crearReserva, con su lock de capacidad.
    return await confirmar(cfg, negocio, waId, datos.nombre, datos);
  }
  if (entrada === 'cambiar_voz') return await elegirDia(cfg, negocio, waId, '');
  // Cualquier otra cosa se toma como corrección: mejor rehacerlo guiado que adivinar qué cambió.
  await decir(cfg, waId, 'Dale, lo armamos de nuevo.', negocio.id);
  return await elegirDia(cfg, negocio, waId, '');
}

module.exports = { atender, seguirVoz };
