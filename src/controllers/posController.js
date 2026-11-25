// Operaciones de mantenimiento del POS
const posService = require('../services/posService');

// POST /pos/llaves: fuerza una carga de llaves (0800)
async function cargarLlaves(req, res) {
  const llaves = await posService.recargarLlaves();
  res.status(llaves.ok ? 200 : 502).json({ llaves });
}

// POST /pos/cierre: cierre del día (0500)
async function cierre(req, res) {
  const r = await posService.cierre();
  res.status(r.successful ? 200 : 502).json({
    id: r.transaccionId ? Number(r.transaccionId) : null,
    aprobado: r.successful,
    respuesta: { codigo: r.responseCode, mensaje: r.responseMessage },
    voucher: r.voucher || null,
  });
}

// GET /pos/ultima-venta: última venta guardada en el POS (0250)
async function ultimaVenta(req, res) {
  const r = await posService.ultimaVenta();
  res.json({
    existe: r.responseCode === 0,
    respuesta: { codigo: r.responseCode, mensaje: r.responseMessage },
    ticket: r.ticket ?? null,
    monto: r.amount ?? null,
    autorizacion: r.authorizationCode ?? null,
    operacion: r.operationNumber ?? null,
    fecha: r.realDate ?? null,
    hora: r.realTime ?? null,
  });
}

module.exports = { cargarLlaves, cierre, ultimaVenta };
