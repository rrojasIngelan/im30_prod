// Controlador de pagos: recibe la petición, valida, llama al servicio/modelo y responde con la vista.
const posService = require('../services/posService');
const Transaccion = require('../models/Transaccion');
const view = require('../views/pagoView');
const { validarCrearPago, validarListar, validarId } = require('../validators/pagoValidator');
const { NotFoundError } = require('../utils/errors');
const { bus } = require('../utils/eventos');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { generarPDF } = require('../services/voucherService');

// POST /pagos
async function crear(req, res) {
  const datos = validarCrearPago(req.body);
  const { id, terminado } = await posService.cobrar(datos);

  if (!datos.esperar) return res.status(202).location(`/pagos/${id}`).json(view.aceptado(id));

  await terminado;
  res.json(view.detalle(await Transaccion.buscarPorId(id)));
}

// GET /pagos
async function listar(req, res) {
  const filtros = validarListar(req.query);
  res.json(view.lista(await Transaccion.listar(filtros)));
}

// GET /pagos/:id
async function detalle(req, res) {
  const id = validarId(req.params.id);
  const tx = await Transaccion.buscarPorId(id);
  if (!tx) throw NotFoundError(`No existe la transacción ${id}`);
  res.json(view.detalle(tx));
}

// POST /pagos/:id/anular
async function anular(req, res) {
  const r = await posService.anular(validarId(req.params.id));
  res.status(r.successful ? 200 : 422).json(view.anulacion(r));
}

// GET /pagos/:id/watch: Server-Sent Events con cada cambio del pago hasta que termina.
//   event: estado  -> detalle actual (al conectar y en cada cambio: mensajes del POS, resultado)
//   event: fin     -> detalle final (aprobada / rechazada / error); luego se cierra la conexión
// Así la caja no necesita consultar GET /pagos/:id una y otra vez.
const MAX_WATCH_MS = 10 * 60_000;

async function watch(req, res) {
  const id = validarId(req.params.id);
  const tx = await Transaccion.buscarPorId(id);
  if (!tx) throw NotFoundError(`No existe la transacción ${id}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let cerrado = false;
  let enviando = Promise.resolve();
  const latido = setInterval(() => res.write(': latido\n\n'), 25_000);
  const limite = setTimeout(() => terminar(), MAX_WATCH_MS);

  function terminar() {
    if (cerrado) return;
    cerrado = true;
    clearInterval(latido);
    clearTimeout(limite);
    bus.off('transaccion', alCambiar);
    res.end();
  }

  // Envía el estado actual; si ya terminó, envía "fin" y cierra
  function enviar(t) {
    if (cerrado || !t) return;
    const datos = JSON.stringify(view.detalle(t));
    if (t.estado === 'pendiente') {
      res.write(`event: estado\ndata: ${datos}\n\n`);
    } else {
      res.write(`event: fin\ndata: ${datos}\n\n`);
      terminar();
    }
  }

  // En orden: cada cambio relee la transacción y la envía (sin mezclar respuestas)
  function alCambiar(dato) {
    if (dato.id !== Number(id) && dato.id > 0) return;
    enviando = enviando.then(() => (cerrado ? null : Transaccion.buscarPorId(id).then(enviar))).catch(() => {});
  }

  bus.on('transaccion', alCambiar);
  req.on('close', terminar);
  enviar(tx);
}

// GET /pagos/:id/voucher: PDF del voucher de Transbank de una venta aprobada.
// Si el PDF no existe (o se borró), se vuelve a generar desde el texto guardado en la base.
async function voucher(req, res) {
  const id = validarId(req.params.id);
  const tx = await Transaccion.buscarPorId(id);
  if (!tx) throw NotFoundError(`No existe la transacción ${id}`);
  if (!tx.voucher) throw NotFoundError(`La transacción ${id} no tiene voucher (solo las ventas aprobadas con POS_VOUCHER=1)`);
  let archivo = tx.voucher_pdf && fs.existsSync(tx.voucher_pdf) ? tx.voucher_pdf : null;
  if (!archivo) {
    archivo = path.resolve(config.voucher.dir, `voucher-${id}.pdf`);
    await generarPDF(tx.voucher.split('\n'), archivo);
    await Transaccion.guardarVoucherPdf(id, archivo);
  }
  res.type('application/pdf').set('Content-Disposition', `inline; filename="voucher-${id}.pdf"`).sendFile(archivo);
}

// POST /pagos/:id/voucher/imprimir: imprime (o reimprime) el voucher en VOUCHER_IMPRESORA
async function imprimirVoucher(req, res) {
  res.json(await posService.imprimirVoucherDe(validarId(req.params.id)));
}

module.exports = { crear, listar, detalle, anular, watch, voucher, imprimirVoucher };
