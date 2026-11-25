// Validación del cuerpo de POST /pagos
const { ValidationError } = require('../utils/errors');

function validarCrearPago(b = {}) {
  const monto = Number(b.monto);
  if (!Number.isInteger(monto) || monto <= 0 || monto > 999_999_999) {
    throw ValidationError('monto debe ser un entero entre 1 y 999999999');
  }
  if (b.ticket !== undefined && !/^[A-Za-z0-9-]{1,20}$/.test(String(b.ticket))) {
    throw ValidationError('ticket: 1 a 20 caracteres alfanuméricos (o guion)');
  }
  if (b.descripcion !== undefined && String(b.descripcion).length > 500) {
    throw ValidationError('descripcion: máximo 500 caracteres');
  }
  if (b.referencia !== undefined && !/^[\w.:-]{1,100}$/.test(String(b.referencia))) {
    throw ValidationError('referencia: 1 a 100 caracteres (letras, números, . _ : -)');
  }
  return {
    monto,
    ticket: b.ticket !== undefined ? String(b.ticket) : undefined,
    descripcion: b.descripcion !== undefined ? String(b.descripcion) : null,
    referencia: b.referencia !== undefined ? String(b.referencia) : null,
    esperar: b.esperar === true,
  };
}

// Fecha AAAA-MM-DD válida (en la zona horaria del servidor de base de datos)
function fecha(v, campo) {
  if (v === undefined || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!m || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    throw ValidationError(`${campo}: fecha inválida, usa el formato AAAA-MM-DD`);
  }
  return String(v);
}

function validarListar(q = {}) {
  const limite = Math.min(Math.max(parseInt(q.limite || '50', 10) || 50, 1), 2000);
  const estado = q.estado || null;
  if (estado && !['pendiente', 'aprobada', 'rechazada', 'error'].includes(estado)) {
    throw ValidationError('estado: pendiente, aprobada, rechazada o error');
  }
  // desde / hasta: días completos e inclusivos (hasta=2026-11-20 incluye todo ese día)
  const desde = fecha(q.desde, 'desde');
  const hasta = fecha(q.hasta, 'hasta');
  if (desde && hasta && desde > hasta) throw ValidationError('desde no puede ser posterior a hasta');
  return { limite, estado, desde, hasta };
}

function validarId(id) {
  if (!/^\d+$/.test(String(id))) throw ValidationError('id inválido');
  return String(id);
}

module.exports = { validarCrearPago, validarListar, validarId };
