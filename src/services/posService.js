// Servicio del POS para el backend: una sola conexión serial abierta y un cobro a la vez.
const config = require('../config');
const { PosSerial } = require('../lib/PosSerial');
const Transaccion = require('../models/Transaccion');
const { ventaRegistrada, operacionRegistrada, conciliarConUltimaVenta } = require('./registroService');
const { procesarVoucher, imprimirVoucher, generarVoucher } = require('./voucherService');
const { ConflictError, NotFoundError, UnavailableError, AppError } = require('../utils/errors');

const pos = new PosSerial({
  debug: config.pos.debug,
  ackTimeout: config.pos.ackTimeout,
  responseTimeout: config.pos.responseTimeout,
});
pos.on('error', (e) => console.error('[POS] Error de puerto:', e.message));
pos.on('mensaje', (t) => console.log(`[POS] Mensaje no solicitado: ${t}`));
pos.on('desconectado', (e) => {
  console.warn(`[POS] ${e.message}; se reconectará automáticamente`);
  reintentarConexion();
});

let abriendo = null;
let ultimoPuerto = null; // puerto donde respondió el POS la última vez (con POS_PORT=auto se prueba primero)
const puertoActual = () => (pos.port?.isOpen && pos.path) || ultimoPuerto || config.pos.port;
let enCurso = null; // { id, tipo, inicio }

// Última carga de llaves (0800) desde que se abrió la conexión
let llaves = { ok: false, fecha: null, responseCode: null, responseMessage: 'No cargadas', transaccionId: null };

// Carga de llaves (0800): el POS se comunica con Transbank y actualiza sus llaves.
// Queda registrada en la base como tipo 'carga_llaves'. Tiene su propio límite de tiempo
// (POS_LLAVES_TIMEOUT) y nunca corre dos a la vez.
let cargando = null;
function cargarLlaves() {
  if (cargando) return cargando;
  const inicio = Date.now();
  console.log(`[POS] Cargando llaves (0800), máximo ${config.pos.llavesTimeout / 1000} s...`);
  llaves = { ...llaves, cargando: true };
  cargando = (async () => {
    try {
      const r = await operacionRegistrada('carga_llaves', { comando: '0800' }, () => pos.cargarLlaves(config.pos.llavesTimeout));
      llaves = { ok: r.successful, fecha: new Date(), responseCode: r.responseCode, responseMessage: r.responseMessage, transaccionId: r.transaccionId };
    } catch (e) {
      llaves = { ok: false, fecha: new Date(), responseCode: null, responseMessage: e.message, transaccionId: null };
    }
    llaves.duracionSeg = Math.round((Date.now() - inicio) / 1000);
    console.log(`[POS] Carga de llaves: ${llaves.ok ? 'OK' : 'FALLÓ'} (${llaves.responseCode ?? '-'} ${llaves.responseMessage}) en ${llaves.duracionSeg} s`);
    if (!llaves.ok) {
      console.warn('[POS] Si la carga de llaves falla siempre, el POS no logra comunicarse con Transbank: revisar su red (WiFi/LAN) o la habilitación del terminal');
    }
    return llaves;
  })().finally(() => { cargando = null; });
  return cargando;
}

// Al abrir la conexión: poll (0100) para verificar comunicación y, en segundo plano, carga de llaves
// (0800). La carga de llaves no bloquea el arranque ni las peticiones; un cobro que llegue mientras
// tanto espera en la cola del POS hasta que termine.
async function prepararPOS() {
  await pos.poll();
  console.log(`[POS] Poll OK en ${puertoActual()}`);
  if (config.pos.cargarLlavesAlConectar) cargarLlaves();
}

async function conectar() {
  if (pos.port?.isOpen && !abriendo) return;
  if (!abriendo) {
    abriendo = (async () => {
      if (!pos.port?.isOpen) {
        ultimoPuerto = await pos.conectarA(config.pos.port, config.pos.baud, ultimoPuerto);
        if (config.pos.auto) console.log(`[POS] Detectado en ${ultimoPuerto} (POS_PORT=auto)`);
      }
      try {
        await prepararPOS();
      } catch (e) {
        await pos.cerrar().catch(() => {}); // sin poll no hay comunicación: cerrar y reintentar la próxima vez
        throw e;
      }
    })().finally(() => { abriendo = null; });
  }
  try {
    await abriendo;
  } catch (e) {
    throw UnavailableError(`No se pudo conectar con el POS en ${config.pos.auto ? 'modo auto' : config.pos.port}: ${e.message}`);
  }
}

// Antes de cada venta: poll (transbank_ws hacía autoconnect + poll en cada pago).
// Si el POS no responde, se cierra el puerto y se reconecta (poll + llaves).
async function verificarConexion() {
  try {
    await pos.poll();
  } catch (e) {
    console.warn(`[POS] Poll falló antes de vender (${e.message}); reconectando...`);
    await pos.cerrar().catch(() => {});
    await conectar();
  }
}

// Después de una venta con voucher (como transbank_ws): generar el PDF, imprimirlo y guardar
// su ruta en Postgres. Los datos de la venta (voucher, RUT, autorización...) ya quedaron en
// la tabla transacciones (vista tbk_transacciones). No bloquea la respuesta y nunca lanza.
// Solo imprime ventas APROBADAS (responseCode 0), incluidas las recuperadas por conciliación.
function despuesDeVenta(res) {
  if (!config.voucher.imprimir || !res?.successful) return;
  if (!res.voucherPdf) {
    console.warn(`[VOUCHER] Venta ${res.transaccionId ?? ''} aprobada sin voucher para imprimir (¿POS_VOUCHER=1?)`);
    return;
  }
  imprimirVoucher(res.voucherPdf).catch((e) => console.error(`[VOUCHER] No se pudo imprimir: ${e.message}`));
}

// Imprime a pedido el voucher de una venta (POST /pagos/:id/voucher/imprimir).
// Siempre regenera el PDF desde el texto guardado en la base, para que salga con el formato actual
// (ancho, negrita, refuerzo) aunque la venta se haya hecho con una configuración anterior.
async function imprimirVoucherDe(id) {
  const tx = await Transaccion.buscarPorId(id);
  if (!tx) throw NotFoundError(`No existe la transacción ${id}`);
  if (!tx.voucher) throw NotFoundError(`La transacción ${id} no tiene voucher (solo las ventas aprobadas con POS_VOUCHER=1)`);
  const archivo = await generarVoucher(tx.voucher.split('\n'), `voucher-${id}`);
  if (!archivo) throw new AppError(500, 'No se pudo generar el PDF del voucher');
  if (archivo !== tx.voucher_pdf) await Transaccion.guardarVoucherPdf(id, archivo);
  try {
    await imprimirVoucher(archivo);
  } catch (e) {
    throw UnavailableError(`No se pudo imprimir en "${config.voucher.impresora || 'la impresora predeterminada'}": ${e.message}`);
  }
  return { id: Number(id), impreso: true, impresora: config.voucher.impresora || 'predeterminada', archivo };
}

// Reconexión automática: tras un corte del puerto (o un pago sin verificar) se reintenta cada
// POS_RECONEXION_MS hasta que el POS responda; al volver, verifica los pagos pendientes.
let reconexion = null;
let ultimoErrorReconexion = null;
function reintentarConexion() {
  if (reconexion) return;
  reconexion = setTimeout(async () => {
    reconexion = null;
    if (enCurso) { reintentarConexion(); return; } // hay una operación: probar después
    ocupar('reconexion');
    try {
      await conectar();
      await verificarConexion();
      await conciliarPendientesInterno();
      if (ultimoErrorReconexion !== null) console.log(`[POS] Conexión recuperada en ${puertoActual()}`);
      ultimoErrorReconexion = null;
      enCurso = null;
    } catch (e) {
      if (e.message !== ultimoErrorReconexion) console.warn(`[POS] Reconexión: ${e.message}; reintentando cada ${config.pos.reconexionMs / 1000} s`);
      ultimoErrorReconexion = e.message;
      enCurso = null;
      reintentarConexion();
    }
  }, config.pos.reconexionMs);
  reconexion.unref?.();
}

// Antes de operar: si quedó un pago sin verificar, se verifica primero (solo la última venta del POS
// sirve para conciliar; un cobro nuevo la reemplazaría). Si no se puede, no se opera.
async function verificarPendientesAntesDe(tipo) {
  try {
    await conciliarPendientesInterno();
  } catch (e) {
    reintentarConexion();
    throw UnavailableError(`Hay un pago anterior sin verificar con el POS; no se puede hacer la ${tipo} hasta verificarlo (${e.message})`);
  }
}

function ocupar(tipo) {
  if (enCurso) throw ConflictError('El POS está ocupado con otra operación', { id: enCurso.id, tipo: enCurso.tipo });
  enCurso = { id: null, tipo, inicio: new Date() };
  return enCurso;
}

// Inicia un cobro. Devuelve { id, terminado }: "terminado" resuelve a { res } (respuesta del POS)
// o { error } (falla de comunicación); nunca se rechaza.
async function cobrar({ monto, ticket, descripcion = null, referencia = null, rutBeneficiario = null, voucher = config.pos.voucher, origen = 'caja' }) {
  if (referencia) {
    const existente = await Transaccion.buscarActivaPorReferencia(referencia);
    if (existente) throw ConflictError('Ya existe un pago pendiente o aprobado con esa referencia', { id: existente });
  }
  ocupar('venta');
  try {
    await conectar();
    if (cargando) console.log('[POS] Hay una carga de llaves en curso; el cobro se enviará al terminar');
    await verificarConexion();
    await verificarPendientesAntesDe('venta');
  } catch (e) {
    enCurso = null;
    throw e;
  }

  let avisarId;
  const idListo = new Promise((r) => { avisarId = r; });
  const terminado = ventaRegistrada(pos, monto, ticket, {
    voucher,
    origen,
    descripcion,
    referencia,
    rutBeneficiario,
    requiereRegistro: true,
    onRegistrada: (id) => { enCurso.id = id; avisarId(id); },
    onIntermedio: (d) => console.log(`[POS] ${d.responseCode} - ${d.responseMessage}`),
  })
    .then((res) => {
      // 26 = "Debe Cargar Llaves": recargarlas en segundo plano después de esta venta
      if (res.responseCode === 26) setImmediate(() => cargarLlaves());
      despuesDeVenta(res);
      return { res };
    })
    .catch((error) => {
      console.error(`[PAGO] ${error.message}`);
      if (error.porVerificar) reintentarConexion();
      return { error };
    })
    .finally(() => { enCurso = null; avisarId(null); });

  const id = await idListo;
  if (!id) {
    await terminado;
    throw new AppError(500, 'No se pudo registrar el pago en la base; no se envió al POS');
  }
  return { id, terminado };
}

async function anular(id) {
  const tx = await Transaccion.buscarPorId(id);
  if (!tx) throw NotFoundError(`No existe la transacción ${id}`);
  if (tx.tipo !== 'venta' || tx.estado !== 'aprobada' || !tx.operation_number) {
    throw ConflictError('Solo se puede anular una venta aprobada con número de operación');
  }
  ocupar('anulacion');
  try {
    await conectar();
    await verificarPendientesAntesDe('anulación');
    return await operacionRegistrada('anulacion', { comando: `1200|${tx.operation_number}`, anulaA: tx.id },
      () => pos.anular(tx.operation_number));
  } finally {
    enCurso = null;
  }
}

// Cierre del día (0500). Manual: "se debe ejecutar diariamente o como mínimo una vez a la semana".
// Borra las ventas guardadas en el POS (después ya no hay "última venta" para conciliar).
async function cierre() {
  ocupar('cierre');
  try {
    await conectar();
    await verificarPendientesAntesDe('cierre'); // el cierre borra las ventas del POS
    const r = await operacionRegistrada('cierre', { comando: `0500|${config.pos.voucher ? 1 : 0}` },
      () => pos.cierre(config.pos.voucher));
    console.log(`[POS] Cierre: ${r.successful ? 'OK' : 'FALLÓ'} (${r.responseCode} ${r.responseMessage})`);
    if (r.voucher?.length) procesarVoucher(r.voucher, `cierre-${r.transaccionId}`);
    return r;
  } finally {
    enCurso = null;
  }
}

// Pagos que quedaron 'pendiente': el servidor se detuvo, el puerto se cortó o no llegó la respuesta.
// Manual IM30: si no llegó la respuesta de una venta, se consulta la última venta (0250) y se compara
// el ticket. Solo la venta pendiente más reciente puede coincidir con la última del POS.
// Requiere el POS ocupado y conectado. Lanza si no se pudo consultar (la venta sigue pendiente).
async function conciliarPendientesInterno() {
  const pendientes = await Transaccion.listarPendientes();
  if (!pendientes.length) return;
  for (const p of pendientes.filter((x) => x.tipo !== 'venta')) {
    await Transaccion.marcarError(p.id, 'No llegó la respuesta del POS (corte de conexión o reinicio del servidor)');
  }
  const ventas = pendientes.filter((p) => p.tipo === 'venta');
  if (!ventas.length) return;
  const [ultima, ...anteriores] = ventas;
  for (const p of anteriores) {
    await Transaccion.marcarError(p.id, 'No llegó la respuesta y ya no es la última venta del POS: revisar a mano');
  }
  console.log(`[POS] Venta ${ultima.id} pendiente (ticket ${ultima.ticket}); consultando última venta del POS...`);
  const r = await conciliarConUltimaVenta(pos, ultima.ticket, config.pos.voucher);
  if (r) {
    const voucherPdf = r.voucher?.length ? await generarVoucher(r.voucher, `voucher-${ultima.id}`).catch(() => null) : null;
    await Transaccion.guardarResultado(ultima.id, { ...r, voucherPdf });
    console.log(`[POS] Venta ${ultima.id}: SÍ se cobró (aut ${r.authorizationCode}); registrada como aprobada`);
    despuesDeVenta({ ...r, voucherPdf, transaccionId: ultima.id });
  } else {
    await Transaccion.marcarError(ultima.id, 'No llegó la respuesta; la última venta del POS tiene otro ticket: no se cobró');
    console.log(`[POS] Venta ${ultima.id}: no se cobró (la última venta del POS tiene otro ticket)`);
  }
}

// Al arrancar el servidor. Si el POS no responde, la venta sigue pendiente y se reintenta en segundo plano.
async function conciliarPendientes() {
  if (!(await Transaccion.listarPendientes()).length) return;
  if (enCurso) { reintentarConexion(); return; }
  ocupar('conciliacion'); // no aceptar cobros mientras se verifica
  try {
    await conectar();
    await conciliarPendientesInterno();
  } catch (e) {
    console.warn(`[POS] No se pudo verificar los pagos pendientes (${e.message}); se reintentará`);
    reintentarConexion();
  } finally {
    enCurso = null;
  }
}

// Última venta guardada en el POS (0250), para revisar/conciliar a mano
async function ultimaVenta() {
  ocupar('ultima_venta');
  try {
    await conectar();
    return await pos.ultimaVenta(false);
  } finally {
    enCurso = null;
  }
}

// Carga de llaves a pedido (POST /pos/llaves)
async function recargarLlaves() {
  ocupar('carga_llaves');
  try {
    await conectar(); // si la conexión es nueva, ya carga llaves al conectar
    if (llaves.fecha && Date.now() - llaves.fecha.getTime() < 2000) return llaves;
    return await cargarLlaves();
  } finally {
    enCurso = null;
  }
}

// Estado del POS: hace poll solo si no hay una operación en curso (no interrumpir un cobro)
async function estado() {
  if (enCurso) return { ok: true, puerto: puertoActual(), ocupado: enCurso.id, error: null, llaves };
  try {
    await conectar();
    await pos.poll();
    return { ok: true, puerto: puertoActual(), ocupado: null, error: null, llaves };
  } catch (e) {
    return { ok: false, puerto: puertoActual(), ocupado: null, error: e.message, llaves };
  }
}

const cerrar = () => {
  if (reconexion) clearTimeout(reconexion);
  reconexion = null;
  return pos.cerrar();
};

module.exports = {
  conectar, cobrar, anular, estado, recargarLlaves, cierre, ultimaVenta, conciliarPendientes, imprimirVoucherDe, cerrar, puertoActual, reintentarConexion };
