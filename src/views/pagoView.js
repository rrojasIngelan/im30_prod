// Vistas: dan forma a las respuestas JSON (la base usa snake_case; la API responde en camelCase).

function pago(tx) {
  return {
    id: Number(tx.id),
    tipo: tx.tipo,
    origen: tx.origen,
    estado: tx.estado,
    monto: tx.monto,
    ticket: tx.ticket,
    descripcion: tx.descripcion ?? null,
    referencia: tx.referencia ?? null,
    rutBeneficiario: tx.rut_beneficiario ?? null,
    voucherPdf: tx.voucher_pdf ?? null,
    creadoEn: tx.creado_en,
    actualizadoEn: tx.actualizado_en,
    respuesta: tx.response_code === null || tx.response_code === undefined
      ? null
      : { codigo: tx.response_code, mensaje: tx.response_message },
    autorizacion: tx.authorization_code,
    operacion: tx.operation_number,
    tarjeta: tx.last4 || tx.card_brand || tx.card_type
      ? { ultimos4: tx.last4, marca: tx.marca_tarjeta || null, codigoMarca: tx.card_brand?.trim() || null, tipo: tx.card_type }
      : null,
    cuotas: tx.con_cuotas === null || tx.con_cuotas === undefined
      ? null
      : { conCuotas: tx.con_cuotas, numero: tx.numero_cuotas, montoCuota: tx.monto_cuota, tipo: tx.tipo_cuota },
    comercio: tx.commerce_code,
    terminal: tx.terminal_id,
    fechaPos: tx.pos_fecha_hora,
    anulaA: tx.anula_a ? Number(tx.anula_a) : null,
    error: tx.error,
  };
}

const detalle = (tx) => ({
  ...pago(tx),
  voucher: tx.voucher ? tx.voucher.split('\n') : null,
  eventos: (tx.eventos || []).map((e) => ({ fecha: e.creado_en, codigo: e.codigo, mensaje: e.mensaje })),
});

const lista = (rows) => ({ total: rows.length, pagos: rows.map(pago) });

const aceptado = (id) => ({ id: Number(id), estado: 'pendiente', consultar: `/pagos/${id}`, watch: `/pagos/${id}/watch` });

const anulacion = (res) => ({
  id: res.transaccionId ? Number(res.transaccionId) : null,
  aprobada: res.successful,
  respuesta: { codigo: res.responseCode, mensaje: res.responseMessage },
  autorizacion: res.authorizationCode || null,
  operacion: res.operationNumber || null,
});

const health = (pos, db) => ({ ok: pos.ok && db.ok, pos, db });

const error = (err) => ({ error: err.message, ...(err.extra || {}) });

module.exports = { pago, detalle, lista, aceptado, anulacion, health, error };
