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
const faq = require('./faq');
const inv = require('./invitaciones');

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
// SALIR pide la palabra sola y exacta. Alguien que escribe "cancela la reserva" no entra ahí, y
// en el paso del nombre CUALQUIER texto se toma como nombre: pasó de verdad, y quedó una reserva
// creada a partir de un pedido de cancelarla. Esto atrapa la frase, no sólo la palabra.
// Anclada al principio: "cancela la reserva" corta, pero "Ana Cancela" —que es un apellido real—
// sigue siendo un nombre. De los dos errores posibles este es el lado correcto para equivocarse:
// rechazar un nombre se arregla escribiéndolo de nuevo, tomar una cancelación como nombre deja
// una reserva que nadie pidió.
const CANCELAR = /^\s*(cancel|anul|olvid[aá])/i;

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
 * Igual que `decir`, pero para listas y botones. Existe porque `wa.enviarLista` y
 * `wa.enviarBotones` mandan sin registrar: el inbox mostraba que el cliente eligió "Noche,
 * primer turno" sin mostrar nunca la pregunta que se lo ofreció. Se guarda el texto y las
 * opciones, que es lo que necesita leer una persona que abre la conversación después.
 */
async function decirOpciones(cfg, waId, texto, opciones, negocioId, enviar) {
  const r = await enviar();
  if (negocioId) await db.logWhatsapp({
    direccion: 'saliente', wa_id: waId, negocio_id: negocioId, mensaje_id: r.id,
    tipo: 'interactive', estado: r.ok ? 'enviado' : 'error',
    texto: texto + '\n' + opciones.map(o => '· ' + o).join('\n'),
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
  if (SALIR.test(entrada) || CANCELAR.test(entrada)) {
    await db.borrarConversacion(negocio.id, waId);
    if (conv) {
      await decir(cfg, waId, 'Listo, no reservé nada. Si querés, escribime cuando quieras.', negocio.id);
      return true;
    }
    // Sin conversación abierta, "cancelá" habla de una reserva YA hecha. Cancelarla desde acá
    // todavía no se sabe hacer, así que se dice y se deriva — mucho mejor que contestar con el
    // menú de siempre, que se lee como si no hubiéramos entendido.
    if (CANCELAR.test(entrada)) {
      await decir(cfg, waId, 'Para cancelar o cambiar una reserva ya hecha te paso con el equipo. ' +
        'Ya les avisé y te responden por acá.', negocio.id);
      return true;
    }
    return false;
  }

  const paso = conv ? conv.paso : null;
  let datos = conv ? (conv.datos || {}) : {};

  // Un código puede aparecer en cualquier mensaje: al saludar, en medio del flujo o pegado al
  // final de una frase. Se detecta siempre y se guarda; pedirlo en un paso fijo obligaría a la
  // persona a acordarse de cuándo decirlo.
  const codigo = inv.buscarEnTexto(entrada);
  // Un código que existe pero no sirve (agotado, vencido, ya usado) NO es un código que no se
  // entendió: si se lo trata igual, el paso que pide el código contesta "no me figura" después
  // de que acá se dijo el motivo real, y la conversación queda dando vueltas sin avanzar.
  let rechazo = null, codigoTomado = false;
  if (codigo && codigo !== datos.invitacion) {
    const r = await db.consultarInvitacion(codigo, negocio.id, waId).catch(() => null);
    if (r && r.ok) {
      datos = { ...datos, invitacion: codigo };
      if (paso) await db.setConversacion(negocio.id, waId, paso, datos);
      // El nombre de pila si lo tenemos: quien llega con una invitación suele ser alguien a quien
      // el negocio ya invitó por su nombre.
      const cli = await db.clientePorTelefono(negocio.id, waId).catch(() => null);
      const pila = String((cli && cli.nombre) || mensaje.perfil || '').trim().split(/\s+/)[0] || '';
      await decir(cfg, waId, `¡Bien${pila ? ', ' + pila : ''}! Tu invitación está activa: ` +
        `${r.texto}. La dejo aplicada a esta reserva.`, negocio.id);
      codigoTomado = true;
    } else if (r) {
      rechazo = r.mensaje;
      // En el paso del código, la salida la ofrece ese paso —con sus dos botones—. En cualquier
      // otro, la reserva ya venía en marcha y no hay nada que preguntar: se avisa y se sigue.
      if (paso !== 'codigo') {
        await decir(cfg, waId, `${rechazo} No te preocupes, seguimos con la reserva igual.`, negocio.id);
      }
    }
  }

  try {
    if (!paso) {
      // Con una invitación válida en el primer mensaje no hay nada que preguntar: la persona ya
      // dijo a qué viene. Presentarse ahí —"soy el asistente, ¿en qué te puedo ayudar?"— después
      // de haberle dicho que le aplicamos la invitación a "esta reserva" suena a que no la
      // estábamos escuchando. Se va derecho a elegir el día.
      if (codigoTomado && ofreceReservas) {
        await db.setConversacion(negocio.id, waId, 'ofrecido', datos);
        return await elegirDia(cfg, negocio, waId, entrada, datos);
      }
      // Si el primer mensaje ya es una pregunta que el negocio tiene contestada, se contesta y
      // recién después se ofrece el menú: hacerlo al revés obliga a repetir la pregunta.
      if (await responderFaq(cfg, negocio, waId, entrada, canal)) {
        return await saludar(cfg, negocio, waId, canal, ofreceReservas, mensaje.perfil, datos) || true;
      }
      return await saludar(cfg, negocio, waId, canal, ofreceReservas, mensaje.perfil, datos);
    }
    // "Otra consulta": lo que sigue va al inbox para que lo lea una persona.
    if (paso === 'consulta') return await recibirConsulta(cfg, negocio, waId, entrada, canal);
    if (paso === 'ofrecido') {
      if (entrada === 'consulta') return await pedirConsulta(cfg, negocio, waId);
      if (!ofreceReservas) return await recibirConsulta(cfg, negocio, waId, entrada, canal);
      // Texto libre en vez de un botón: puede ser una pregunta. Si está contestada, se contesta
      // y se queda donde estaba, en vez de arrancar a pedirle días a alguien que preguntó otra cosa.
      if (entrada !== 'reservar' && await responderFaq(cfg, negocio, waId, entrada, canal)) return true;
      // Igual que en la web: se pregunta por el código ANTES de mostrar días, porque la
      // invitación puede limitar qué días y qué turnos se pueden ofrecer. Quien llegó con una
      // tarjeta física no tiene por qué adivinar que hay que mencionarla.
      if (!datos.invitacion && await db.invitacionesActivas(negocio.id)) {
        return await preguntarCodigo(cfg, negocio, waId, datos);
      }
      // Si el código vino pegado en este mismo mensaje, ya se confirmó arriba: preguntar por él
      // otra vez sería no haber leído lo que acaba de escribir.
      return await elegirDia(cfg, negocio, waId, entrada, datos);
    }
    if (paso === 'codigo') return await recibirCodigo(cfg, negocio, waId, entrada, datos, rechazo);
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

async function saludar(cfg, negocio, waId, canal, ofreceReservas, perfil, datos = {}) {
  // Se arranca con lo que ya se sepa: un código detectado en el PRIMER mensaje no tiene todavía
  // conversación donde guardarse, y sin esto se perdía justo ahí.
  await db.setConversacion(negocio.id, waId, 'ofrecido', datos);
  // El saludo lo escribe el negocio en el configurador; si no puso nada, se arma uno.
  // Si WhatsApp nos da el nombre del perfil, se usa el primero para que no suene a máquina.
  // El nombre con el que lo conoce el NEGOCIO gana sobre el del perfil de WhatsApp: el perfil lo
  // escribe cualquiera y puede decir "Fer 🔥"; el de la ficha es el que quedó de la vez anterior.
  const cli = await db.clientePorTelefono(negocio.id, waId);
  const nombrePila = String((cli && cli.nombre) || perfil || '').trim().split(/\s+/)[0] || '';
  // Si el saludo que escribió el negocio ya arranca con "hola", se le saca para no duplicarlo:
  // "Hola Fernando. Hola, soy el asistente…" suena a error, y es el que va a escribir cualquiera.
  const propio = String(canal.saludo || '').trim();
  const base = (propio || `Soy el asistente de ${negocio.nombre}.`)
    .replace(/^[¡\s]*hola[\s,.!¡]*/i, '')
    .replace(/^./, c => c.toUpperCase());
  const saludo = nombrePila ? `Hola ${nombrePila}. ${base}` : `Hola. ${base}`;
  const botones = [];
  // Sin "Ahora no": ofrecer una salida antes de que la persona haya pedido nada suena a que
  // estamos insistiendo. Quien no quiere nada simplemente no contesta, y "no" escrito sigue
  // cortando el flujo igual.
  if (ofreceReservas) botones.push({ id: 'reservar', titulo: 'Reservar' });
  if (canal.inbox) botones.push({ id: 'consulta', titulo: 'Otra consulta' });

  if (!botones.length) return false;
  const texto = `${saludo}\n\n¿En qué te puedo ayudar?`;
  const r = await decirOpciones(cfg, waId, texto, botones.map(b => b.titulo), negocio.id,
    () => wa.enviarBotones(waId, texto, botones, cfg));
  // Si los botones fallan (algún cliente viejo no los soporta), se sigue en texto plano.
  if (!r.ok) await decir(cfg, waId, saludo + (ofreceReservas
    ? '\n\nSi querés reservar, escribime "reservar". Si es otra cosa, contame y te respondemos.'
    : '\n\nContame en qué te puedo ayudar y te respondemos a la brevedad.'), negocio.id);
  return true;
}

/**
 * Si el negocio ya escribió una respuesta para esto, la manda TAL CUAL y devuelve true.
 * Lo que sale es el texto del negocio, no uno redactado por el modelo: el modelo sólo elige cuál
 * de las respuestas guardadas contesta la pregunta, o ninguna.
 */
async function responderFaq(cfg, negocio, waId, texto, canal) {
  const lista = (canal && canal.faq) || [];
  if (!lista.length) return false;
  const i = await faq.responder(texto, lista).catch(() => null);
  if (i == null) return false;
  await decir(cfg, waId, lista[i].r, negocio.id);
  return true;
}

async function preguntarCodigo(cfg, negocio, waId, datos) {
  await db.setConversacion(negocio.id, waId, 'codigo', datos);
  // Dos botones y no uno: con un solo "No, seguir" no queda claro que el sí se contesta
  // escribiendo el código, y la persona se queda sin saber qué hacer.
  const texto = '¿Tenés un código de invitación?';
  const botones = [{ id: 'con_codigo', titulo: 'Sí, tengo uno' },
                   { id: 'sin_codigo', titulo: 'No tengo' }];
  const r = await wa.enviarBotones(waId, texto, botones, cfg);
  if (!r.ok) await decir(cfg, waId, texto + ' Escribilo acá, o respondeme "no".', negocio.id);
  else await db.logWhatsapp({ direccion: 'saliente', wa_id: waId, negocio_id: negocio.id,
    mensaje_id: r.id, tipo: 'interactive', estado: 'enviado',
    texto: texto + '\n· Sí, tengo uno\n· No tengo' }).catch(() => {});
  return true;
}

async function recibirCodigo(cfg, negocio, waId, entrada, datos, rechazo) {
  // El código ya se detecta arriba, en cualquier mensaje: si llegó acá con uno válido, `datos`
  // lo trae. Lo que queda es seguir, con o sin él.
  if (entrada === 'sin_codigo' || /^(no|nada|ninguno|seguir)$/i.test(entrada) || datos.invitacion) {
    return await elegirDia(cfg, negocio, waId, '', datos);
  }
  if (entrada === 'con_codigo') {
    await decir(cfg, waId, 'Perfecto. Escribime el código tal como te llegó — son seis ' +
      'caracteres, como ABC-123.', negocio.id);
    return true;
  }
  // El código se entendió pero no sirve. El motivo se dice una sola vez y con las dos salidas a
  // la vista: quedarse en el paso repitiendo "probá de nuevo" es dejar a la persona sin reserva
  // por algo que no puede arreglar.
  if (rechazo) {
    const texto = `${rechazo}\n\nPodés escribirme otro código, o seguimos sin invitación.`;
    const botones = [{ id: 'sin_codigo', titulo: 'Seguir sin código' }];
    const r = await decirOpciones(cfg, waId, texto, ['Seguir sin código'], negocio.id,
      () => wa.enviarBotones(waId, texto, botones, cfg));
    if (!r.ok) await decir(cfg, waId, texto + ' Respondeme "seguir".', negocio.id);
    return true;
  }
  // Nada de lo que escribió se parece a un código: no está intentando dictarlo, está diciendo
  // otra cosa ("hola", "tengo otro", "dale"). Insistir con "fijate si está bien copiado" deja la
  // conversación en un bucle del que no se sale ni saludando — pasó, y no había manera de salir.
  if (!pareceCodigo(entrada)) {
    await decir(cfg, waId, 'No encontré un código ahí, así que seguimos sin invitación. ' +
      'Si la tenés a mano, escribime el código en cualquier momento y la aplico.', negocio.id);
    return await elegirDia(cfg, negocio, waId, '', datos);
  }
  // Sí parece un código, pero está mal. Se deja reintentar, no para siempre: al tercero se sigue
  // igual. Perder la reserva por un código mal impreso es el peor final posible.
  const fallos = (datos.codigo_fallos || 0) + 1;
  if (fallos >= 3) {
    await decir(cfg, waId, 'Ese código sigue sin figurarme. Seguimos con la reserva y lo vemos ' +
      'cuando llegues — mostralo en el local y lo resolvemos ahí.', negocio.id);
    const { codigo_fallos, ...limpio } = datos;
    return await elegirDia(cfg, negocio, waId, '', limpio);
  }
  await db.setConversacion(negocio.id, waId, 'codigo', { ...datos, codigo_fallos: fallos });
  await decir(cfg, waId, 'Ese código no me figura. Fijate si está bien copiado y probá de nuevo, ' +
    'o respondeme "seguir" y lo vemos cuando llegues.', negocio.id);
  return true;
}

/**
 * ¿El mensaje es un intento de dictar un código, aunque esté mal? Se mira la FORMA, no la
 * validez: un token corto y sin espacios que mezcle letras y números, o todo en mayúsculas.
 * Sirve para distinguir "GAFQ9X" (mal copiado: hay que avisar) de "hola" (no viene al caso).
 */
function pareceCodigo(texto) {
  return String(texto || '').split(/[\s.,;:!?]+/).filter(Boolean).some(t => {
    const c = t.replace(/[^A-Za-z0-9]/g, '');
    if (c.length < 4 || c.length > 9) return false;
    return /[0-9]/.test(c) || c === c.toUpperCase();
  });
}

// Consultas que no son una operación del bot: se guardan para que las lea una persona.
async function pedirConsulta(cfg, negocio, waId) {
  await db.setConversacion(negocio.id, waId, 'consulta', {});
  await decir(cfg, waId, 'Contame en qué te puedo ayudar y te respondemos a la brevedad.', negocio.id);
  return true;
}

async function recibirConsulta(cfg, negocio, waId, texto, canal) {
  // Primero lo que el negocio ya contestó: si hay respuesta, no hay nada que derivar.
  if (await responderFaq(cfg, negocio, waId, texto, canal)) return true;
  await db.borrarConversacion(negocio.id, waId);
  // El mensaje ya se guarda en la bitácora del webhook: acá sólo se acusa recibo. Prometer un
  // plazo que no controlamos sería peor que no prometer nada.
  await decir(cfg, waId, 'Gracias, ya le pasé tu mensaje al equipo. Te van a responder por acá.', negocio.id);
  return true;
}

// Los días que se ofrecen salen de la MISMA disponibilidad que la página pública: ya viene
// filtrada por anticipación, bloqueos y lugar libre.
/**
 * Qué deja hacer la invitación que la persona ya presentó: hasta qué día, qué días de la semana,
 * qué turnos y desde cuántas personas. Devuelve null si no hay invitación en juego.
 *
 * Se relee en cada paso y no se guarda en la conversación: una invitación puede vencer o agotarse
 * entre que se elige el día y se confirma, y el chat no puede seguir ofreciendo lo que ya no vale.
 */
async function limiteInvitacion(negocio, datos) {
  if (!datos || !datos.invitacion) return null;
  const r = await db.consultarInvitacion(datos.invitacion, negocio.id).catch(() => null);
  if (!r || !r.ok) return null;
  const c = (r.invitacion && r.invitacion.condiciones) || {};
  return {
    vence: soloFecha(r.invitacion.vence_en),
    dias: Array.isArray(c.dias) ? c.dias : [],
    turnos: Array.isArray(c.turnos) ? c.turnos : [],
    minimo: c.cantidad_min || null,
    texto: r.texto,
  };
}

/**
 * AAAA-MM-DD de lo que venga. Una columna `date` vuelve de la base como objeto Date, y recortarla
 * como texto da "Tue Aug 18": comparado contra "2026-08-18" no coincide nunca y el filtro se
 * llevaba puestos TODOS los días.
 */
function soloFecha(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

/** El isodow de una fecha, sin pasar por zonas horarias: la fecha ya viene como AAAA-MM-DD. */
function isodow(fecha) {
  const [a, m, d] = String(fecha).split('-').map(Number);
  const n = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return n === 0 ? 7 : n;
}

async function elegirDia(cfg, negocio, waId, entrada, datos = {}) {
  if (entrada === 'no') {
    await db.borrarConversacion(negocio.id, waId);
    await decir(cfg, waId, 'Dale, cuando quieras. Acá estoy.', negocio.id);
    return true;
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const hasta = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const turnos = await db.disponibilidadPublica(negocio.id, hoy, hasta);
  // La invitación acota el calendario ANTES de mostrarlo. Ofrecer treinta días y rechazar al final
  // el que la persona eligió es hacerle perder el tiempo con una regla que ya conocíamos.
  const lim = await limiteInvitacion(negocio, datos);
  let libres = turnos;
  if (lim) {
    libres = turnos.filter(t =>
      (!lim.vence || t.fecha <= lim.vence) &&
      (!lim.dias.length || lim.dias.includes(isodow(t.fecha))) &&
      (!lim.turnos.length || lim.turnos.includes(t.turno_id)));
  }
  const fechas = [...new Set(libres.map(t => t.fecha))].sort().slice(0, 10);
  if (!fechas.length) {
    await db.borrarConversacion(negocio.id, waId);
    await decir(cfg, waId, lim
      ? 'Tu invitación no tiene días disponibles: puede que ya haya pasado la fecha en la que valía. ' +
        'Si querés reservar igual, escribime "reservar" sin el código.'
      : 'Por ahora no tengo días disponibles. Probá más adelante.', negocio.id);
    return true;
  }
  // Se conserva lo ya sabido: la fecha y el turno se descartan porque son justamente lo que se
  // está por elegir, pero la cantidad y el nombre siguen valiendo.
  await db.setConversacion(negocio.id, waId, 'dia',
    { cantidad: datos.cantidad, nombre: datos.nombre, pedir_nombre: datos.pedir_nombre,
      invitacion: datos.invitacion });
  const filas = fechas.map(f => ({ id: 'd:' + f, titulo: dia(f) }));
  // Con la lista recortada hay que decir por qué: si no, parece que el local no tiene lugar.
  const pregunta = lim && fechas.length <= 3
    ? `Tu invitación vale ${fechas.length === 1 ? 'sólo el ' + dia(fechas[0]) : 'para estos días'}. ¿Te sirve?`
    : '¿Para qué día?';
  await decirOpciones(cfg, waId, pregunta, filas.map(f => f.titulo), negocio.id,
    () => wa.enviarLista(waId, pregunta, 'Ver días', filas, cfg));
  return true;
}

async function elegirTurno(cfg, negocio, waId, entrada, datos) {
  const fecha = entrada.startsWith('d:') ? entrada.slice(2) : null;
  if (!fecha) { await decir(cfg, waId, 'Elegí un día de la lista, por favor.', negocio.id); return true; }
  let turnos = (await db.disponibilidadPublica(negocio.id, fecha, fecha));
  const lim = await limiteInvitacion(negocio, datos);
  if (lim && lim.turnos.length) turnos = turnos.filter(t => lim.turnos.includes(t.turno_id));
  if (!turnos.length) {
    await decir(cfg, waId, 'Ese día se quedó sin lugar. Escribime "reservar" y elegimos otro.', negocio.id);
    await db.borrarConversacion(negocio.id, waId);
    return true;
  }
  await db.setConversacion(negocio.id, waId, 'turno', { ...datos, fecha });
  const texto = `${dia(fecha)}. ¿Qué turno?`;
  const filas = turnos.map(t => ({ id: 't:' + t.turno_id, titulo: t.nombre,
                                   detalle: `${t.hora_desde} a ${t.hora_hasta}` }));
  await decirOpciones(cfg, waId, texto, filas.map(f => `${f.titulo} (${f.detalle})`), negocio.id,
    () => wa.enviarLista(waId, texto, 'Ver turnos', filas, cfg));
  return true;
}

/** El tope REAL de una reserva en ese turno: el del turno o el general, y nunca más que lo libre. */
async function topeDe(negocioId, fecha, turnoId) {
  const t = (await db.disponibilidadPublica(negocioId, fecha, fecha)).find(x => x.turno_id === turnoId);
  return t ? t.tope : null;
}

async function pedirCantidad(cfg, negocio, waId, entrada, datos) {
  const turnoId = entrada.startsWith('t:') ? entrada.slice(2) : null;
  if (!turnoId) { await decir(cfg, waId, 'Elegí un turno de la lista, por favor.', negocio.id); return true; }
  return await avanzar(cfg, negocio, waId, { ...datos, turno_id: turnoId });
}

async function pedirNombre(cfg, negocio, waId, entrada, datos) {
  const n = parseInt(String(entrada).replace(/\D+/g, ''), 10);
  const cfgRes = await db.getConfigReservas(negocio.id);
  if (!n || n < cfgRes.cantidad_min) {
    await decir(cfg, waId, `Necesito un número. ¿Para ${cuantos(cfgRes.unidad)} ${plural(cfgRes.unidad, 2)}?`, negocio.id);
    return true;
  }
  // El mínimo del beneficio se avisa acá y no al confirmar: enterarse al final de que la
  // invitación pedía más gente obliga a rehacer toda la conversación.
  const lim = await limiteInvitacion(negocio, datos);
  if (lim && lim.minimo && n < lim.minimo) {
    await decir(cfg, waId, `Tu invitación aplica desde ${lim.minimo} ${plural(cfgRes.unidad, lim.minimo)}. ` +
      `¿Van a ser ${lim.minimo} o más? Si preferís reservar para ${n}, escribime "reservar" sin el código.`, negocio.id);
    return true;
  }
  return await avanzar(cfg, negocio, waId, { ...datos, cantidad: n });
}

/**
 * Decide cuál es la primera pregunta que falta y la hace. Es el único lugar que conoce el orden
 * de los datos, así que da igual si vienen de un audio, de los botones o de una mezcla: lo que ya
 * se sabe no se vuelve a preguntar.
 */
async function avanzar(cfg, negocio, waId, datos) {
  if (!datos.fecha)    return await elegirDia(cfg, negocio, waId, '', datos);
  if (!datos.turno_id) return await elegirTurno(cfg, negocio, waId, 'd:' + datos.fecha, datos);

  const cfgRes = await db.getConfigReservas(negocio.id);
  const tope = await topeDe(negocio.id, datos.fecha, datos.turno_id);

  // Sin cantidad, o con una que no entra en este turno: se pregunta diciendo el máximo, así nadie
  // propone un número que va a rebotar.
  if (!datos.cantidad || (tope && datos.cantidad > tope)) {
    const pasada = datos.cantidad && tope && datos.cantidad > tope ? datos.cantidad : null;
    await db.setConversacion(negocio.id, waId, 'cantidad', { ...datos, cantidad: null });
    await decir(cfg, waId, (pasada
      ? `Para ese turno puedo tomar hasta ${tope} ${plural(cfgRes.unidad, tope)} en una reserva. `
      : '') + `¿Para ${cuantos(cfgRes.unidad)} ${plural(cfgRes.unidad, 2)}?` +
      (!pasada && tope ? ` Hasta ${tope}.` : '') + ' Respondeme con un número.', negocio.id);
    return true;
  }

  // Si el número ya es cliente del negocio, el nombre ya lo sabemos: pedírselo a alguien que ya
  // vino es la fricción que hace que un canal se sienta burocrático. Igual lo va a ver en el
  // resumen y lo puede corregir. `pedir_nombre` es cómo se pide esa corrección: si viene puesto,
  // no se identifica solo — si no, "Cambiar algo" volvería a completarlo y no habría salida.
  if (!datos.nombre && !datos.pedir_nombre) {
    const cli = await db.clientePorTelefono(negocio.id, waId);
    if (cli && cli.nombre) datos = { ...datos, nombre: cli.nombre, cliente_id: cli.id };
  }

  // Nombre Y apellido: es lo que queda en la base del negocio, y un nombre suelto no alcanza
  // para reconocer a alguien cuando llega.
  if (!datos.nombre) {
    await db.setConversacion(negocio.id, waId, 'nombre', datos);
    await decir(cfg, waId, 'Por último, decime tu nombre y apellido, por favor.', negocio.id);
    return true;
  }

  // Están los cuatro datos: se muestra lo entendido y se pide un sí. Que el último paso siga
  // siendo humano es la regla de la casa, y acá además protege de una transcripción torcida.
  const t = (await db.disponibilidadPublica(negocio.id, datos.fecha, datos.fecha))
    .find(o => o.turno_id === datos.turno_id);
  const resumen = `${dia(datos.fecha)}${t ? `, ${t.nombre} ${t.hora_desde}` : ''}\n` +
                  `${datos.cantidad} ${plural(cfgRes.unidad, datos.cantidad)}\nA nombre de ${datos.nombre}` +
                  (datos.invitacion ? `\nCon tu invitación ${inv.bonito(datos.invitacion)}` : '');
  await db.setConversacion(negocio.id, waId, 'confirmar_voz', datos);
  const texto = `Así queda tu reserva:\n\n${resumen}\n\n¿La confirmo?`;
  const bot = [{ id: 'ok_voz', titulo: 'Sí, confirmá' }, { id: 'cambiar_voz', titulo: 'Cambiar algo' }];
  const r = await decirOpciones(cfg, waId, texto, bot.map(b => b.titulo), negocio.id,
    () => wa.enviarBotones(waId, texto, bot, cfg));
  if (!r.ok) await decir(cfg, waId, `Así queda tu reserva:\n\n${resumen}\n\nRespondeme "sí" para confirmarla.`, negocio.id);
  return true;
}

const ERRORES = {
  inv_agotada:  'Esa invitación ya se usó. Escribime "reservar" y la hacemos sin ella.',
  inv_vencida:  'Esa invitación ya venció. Escribime "reservar" y la hacemos sin ella.',
  inv_anulada:  'Esa invitación fue dada de baja. Escribime "reservar" y la hacemos sin ella.',
  inv_ajena:    'Esa invitación ya está en uso por otra persona.',
  inv_repetida: 'Esa invitación ya la usaste. Escribime "reservar" y la hacemos sin ella.',
  inv_dia:      'La invitación no aplica a ese día. Escribime "reservar" y elegimos otro.',
  inv_turno:    'La invitación no aplica a ese turno. Escribime "reservar" y elegimos otro.',
  inv_cantidad: 'La invitación no aplica para esa cantidad. Escribime "reservar" y lo vemos.',
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
      invitacion_codigo: datos.invitacion || null,
      // Si ya se lo identificó, se manda el id: _resolverCliente lo valida contra el negocio y
      // se ahorra la búsqueda por teléfono.
      cliente_id: datos.cliente_id || null,
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
  // Se repite el beneficio en la confirmación: es lo que la persona va a mostrar al llegar, y
  // tenerlo por escrito en el chat evita la discusión en la mesa.
  // Y con la cobertura pegada: "100% de descuento" a secas, en una mesa de 4 con una invitación
  // para 2, es una promesa que el mostrador después tiene que desdecir.
  const cob = r.invitacion && db.textoCobertura(r.invitacion.cubre, r.invitacion.personas);
  const conInv = r.invitacion
    ? `\nInvitación aplicada: ${r.invitacion.texto}${cob ? ` — ${cob}` : ''}` : '';
  await decir(cfg, waId, r.estado === 'confirmada'
    ? `¡Listo! Reserva confirmada en ${negocio.nombre}.\n\n${cuando}\n${cant}\nA nombre de ${nombre}${conInv}\n\nTe esperamos.`
    : `Anotado. Tu pedido quedó registrado en ${negocio.nombre}.\n\n${cuando}\n${cant}\nA nombre de ${nombre}${conInv}\n\nQueda pendiente de confirmación; te aviso por acá.`,
    negocio.id);

  // Y la tarjeta. Va como pedido y no acá mismo porque dibujarla lleva unos segundos (la
  // fotografía un navegador en el host) y el chat no puede quedarse mudo esperando eso: primero
  // sale la confirmación por texto, que es la que importa, y la imagen llega detrás.
  await db.pedirTarjeta(negocio.id, r.id, waId);
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

  if (!ofreceReservas) return void await recibirConsulta(cfg, negocio, waId, texto, canal);

  const cfgRes = await db.getConfigReservas(negocio.id);
  const hoy = new Date().toISOString().slice(0, 10);
  const hasta = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const opciones = await db.disponibilidadPublica(negocio.id, hoy, hasta);

  // El código puede venir dictado en el propio audio.
  let invitacion = null;
  const codigo = inv.buscarEnTexto(texto);
  if (codigo) {
    const c = await db.consultarInvitacion(codigo, negocio.id, waId).catch(() => null);
    if (c && c.ok) {
      invitacion = codigo;
      await decir(cfg, waId, `¡Bien! Tu invitación está activa: ${c.texto}.`, negocio.id);
    } else if (c) await decir(cfg, waId, `${c.mensaje} No te preocupes, seguimos igual.`, negocio.id);
  }

  const i = await voz.interpretar(texto, {
    opciones, hoy, unidad: cfgRes.unidad,
    cantidadMin: cfgRes.cantidad_min, cantidadMax: cfgRes.cantidad_max,
  });

  // No se entendió, o el audio no era para reservar: al inbox, que es donde lo va a leer alguien.
  if (!i) return void await elegirDia(cfg, negocio, waId, '');
  if (i.intencion !== 'reserva') return void await recibirConsulta(cfg, negocio, waId, texto, canal);

  // Pidió un día concreto que no está en la agenda. Sin esto se le muestra una lista que empieza
  // semanas después y se lee como "no hay lugar", cuando puede ser que el local esté cerrado.
  if (!i.fecha && i.fecha_pedida) {
    // Si el negocio cargó una respuesta que explica por qué no hay —está cerrado, reabre tal
    // día—, se agrega. Decir sólo "no tengo disponibilidad" se lee como "está lleno", que es
    // otra cosa y manda a la persona a buscar en otro lado.
    const j = await faq.responder(`¿Están abiertos ${i.fecha_pedida}?`, canal.faq || []).catch(() => null);
    const porque = j != null ? ' ' + canal.faq[j].r : '';
    await decir(cfg, waId, `Para ${i.fecha_pedida} no tengo disponibilidad.` + porque, negocio.id);
  }

  // Lo entendido entra al MISMO flujo que los botones: `avanzar` decide qué falta y lo pregunta.
  // Si el día que pidió no está disponible se le ofrece la lista, pero la cantidad y el nombre que
  // sí dijo se conservan — que un dato no sirva no es razón para tirar los otros.
  await avanzar(cfg, negocio, waId,
    { fecha: i.fecha, turno_id: i.turno_id, cantidad: i.cantidad, nombre: i.nombre, invitacion });
}

const SI = /^(s[ií]|dale|ok|oka?y|confirm[oá]|listo|correcto|exacto|perfecto)\b/i;

async function confirmarVoz(cfg, negocio, waId, entrada, datos) {
  if (entrada === 'ok_voz' || SI.test(entrada)) {
    // Entra por la misma puerta que todo el resto: crearReserva, con su lock de capacidad.
    return await confirmar(cfg, negocio, waId, datos.nombre, datos);
  }
  // Se rehace desde cero y pidiendo el nombre: si se autocompletara otra vez, alguien que quiere
  // reservar a nombre de otro quedaría girando en el mismo resumen.
  if (entrada === 'cambiar_voz') return await elegirDia(cfg, negocio, waId, '', { pedir_nombre: true });
  // Cualquier otra cosa se toma como corrección: mejor rehacerlo guiado que adivinar qué cambió.
  await decir(cfg, waId, 'Dale, lo armamos de nuevo.', negocio.id);
  return await elegirDia(cfg, negocio, waId, '');
}

module.exports = { atender, seguirVoz };
