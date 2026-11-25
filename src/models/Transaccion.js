// Modelo: tabla transacciones y sus eventos (mensajes intermedios 0900).
// Sin base configurada, las escrituras no hacen nada y las lecturas devuelven vacío.
const db = require('./db');
const { avisarTransaccion } = require('../utils/eventos');
const { marcaTarjeta } = require('../lib/marcaTarjeta');
const { cuotas } = require('../lib/cuotas');

const estadoDe = (res) => (res.successful ? 'aprobada' : 'rechazada');

// "DDMMAAAA" + "HHMMSS" -> "AAAA-MM-DD HH:MM:SS" (o null)
function fechaPos(fecha, hora) {
  if (!/^\d{8}$/.test(fecha || '') || !/^\d{6}$/.test(hora || '')) return null;
  return `${fecha.slice(4, 8)}-${fecha.slice(2, 4)}-${fecha.slice(0, 2)} ${hora.slice(0, 2)}:${hora.slice(2, 4)}:${hora.slice(4, 6)}`;
}

const Transaccion = {
  // Crea la fila en estado 'pendiente' ANTES de enviar el comando al POS. Devuelve el id.
  async crear({ tipo, origen = 'caja', monto = null, ticket = null, comando = null, anulaA = null, descripcion = null, referencia = null, rutBeneficiario = null }) {
    if (!db.disponible()) return null;
    const { rows } = await db.query(
      `INSERT INTO transacciones (tipo, origen, monto, ticket, comando, anula_a, descripcion, referencia, rut_beneficiario)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [tipo, origen, monto, ticket, comando, anulaA, descripcion, referencia, rutBeneficiario],
    );
    avisarTransaccion(rows[0].id, 'creada');
    return rows[0].id;
  },

  async agregarEvento(id, { responseCode, responseMessage }) {
    if (!db.disponible() || !id) return;
    await db.query(
      'INSERT INTO transaccion_eventos (transaccion_id, codigo, mensaje) VALUES ($1, $2, $3)',
      [id, responseCode, responseMessage],
    );
    avisarTransaccion(id, 'evento');
  },

  async guardarResultado(id, res) {
    if (!db.disponible() || !id) return;
    const c = res.successful ? cuotas(res) : null; // cuotas solo para ventas aprobadas
    await db.query(
      `UPDATE transacciones SET
         actualizado_en = now(), estado = $2, response_code = $3, response_message = $4,
         authorization_code = $5, operation_number = $6, last4 = $7, card_type = $8, card_brand = $9,
         commerce_code = $10, terminal_id = $11, accounting_date = $12, pos_fecha_hora = $13,
         voucher = $14, respuesta_raw = $15,
         monto = COALESCE(monto, $16), ticket = COALESCE(ticket, $17),
         voucher_pdf = COALESCE($18, voucher_pdf),
         marca_tarjeta = COALESCE($19, marca_tarjeta),
         con_cuotas = COALESCE($20, con_cuotas), numero_cuotas = COALESCE($21, numero_cuotas),
         monto_cuota = COALESCE($22, monto_cuota), tipo_cuota = COALESCE($23, tipo_cuota)
       WHERE id = $1`,
      [
        id, estadoDe(res), res.responseCode, res.responseMessage,
        res.authorizationCode || null, res.operationNumber || null, res.last4Digits || null,
        res.cardType || null, res.cardBrand || null, res.commerceCode || null, res.terminalId || null,
        res.accountingDate || null, fechaPos(res.realDate, res.realTime),
        Array.isArray(res.voucher) ? res.voucher.join('\n') : null, res.raw || null,
        res.amount || null, res.ticket || null, res.voucherPdf || null,
        res.successful ? marcaTarjeta(res) : null,
        c ? c.conCuotas : null, c?.numero ?? null, c?.montoCuota ?? null, c ? c.tipo : null,
      ],
    );
    avisarTransaccion(id, 'resultado');
  },

  async actualizarComando(id, ticket, comando) {
    if (!db.disponible() || !id) return;
    await db.query('UPDATE transacciones SET ticket = $2, comando = $3, actualizado_en = now() WHERE id = $1', [id, ticket, comando]);
    avisarTransaccion(id, 'actualizada');
  },

  async guardarVoucherPdf(id, archivo) {
    if (!db.disponible() || !id) return;
    await db.query('UPDATE transacciones SET voucher_pdf = $2, actualizado_en = now() WHERE id = $1', [id, archivo]);
    avisarTransaccion(id, 'actualizada');
  },

  // Sin respuesta y sin poder consultar la última venta: no se sabe si se cobró. Sigue 'pendiente'
  // (con el motivo en "error") hasta que el backend la verifique con la última venta del POS.
  async marcarPorVerificar(id, motivo) {
    if (!db.disponible() || !id) return;
    await db.query(
      `UPDATE transacciones SET actualizado_en = now(), error = $2 WHERE id = $1 AND estado = 'pendiente'`,
      [id, String(motivo)],
    );
    avisarTransaccion(id, 'evento');
  },

  async marcarError(id, err) {
    if (!db.disponible() || !id) return;
    await db.query(
      `UPDATE transacciones SET actualizado_en = now(), estado = 'error', error = $2 WHERE id = $1`,
      [id, String(err?.message || err)],
    );
    avisarTransaccion(id, 'error');
  },

  async buscarPorId(id) {
    if (!db.disponible()) return null;
    const { rows } = await db.query('SELECT * FROM transacciones WHERE id = $1', [id]);
    if (!rows.length) return null;
    const ev = await db.query(
      'SELECT creado_en, codigo, mensaje FROM transaccion_eventos WHERE transaccion_id = $1 ORDER BY id',
      [id],
    );
    return { ...rows[0], eventos: ev.rows };
  },

  // Pago pendiente o aprobado con esa referencia externa (para no cobrar dos veces)
  async buscarActivaPorReferencia(referencia) {
    if (!db.disponible()) return null;
    const { rows } = await db.query(
      `SELECT id FROM transacciones WHERE referencia = $1 AND estado IN ('pendiente', 'aprobada')
       ORDER BY id DESC LIMIT 1`,
      [referencia],
    );
    return rows[0]?.id || null;
  },

  // Venta aprobada con ese número de operación (para enlazar una anulación)
  async buscarVentaAprobadaPorOperacion(operacion) {
    if (!db.disponible()) return null;
    const { rows } = await db.query(
      `SELECT id FROM transacciones WHERE tipo = 'venta' AND estado = 'aprobada' AND operation_number = $1
       ORDER BY id DESC LIMIT 1`,
      [String(operacion).padStart(6, '0').slice(-6)],
    );
    return rows[0]?.id || null;
  },

  // desde / hasta: 'AAAA-MM-DD', días completos e inclusivos, en la zona horaria de la base
  async listar({ limite = 50, estado = null, desde = null, hasta = null } = {}) {
    if (!db.disponible()) return [];
    const { rows } = await db.query(
      `SELECT * FROM transacciones
       WHERE ($2::text IS NULL OR estado = $2)
         AND ($3::date IS NULL OR creado_en >= $3::date)
         AND ($4::date IS NULL OR creado_en < $4::date + 1)
       ORDER BY id DESC LIMIT $1`,
      [limite, estado, desde, hasta],
    );
    return rows;
  },

  // Operaciones que quedaron 'pendiente', de la más reciente a la más antigua
  async listarPendientes() {
    if (!db.disponible()) return [];
    const { rows } = await db.query(`SELECT id, tipo, ticket FROM transacciones WHERE estado = 'pendiente' ORDER BY id DESC`);
    return rows;
  },

  // Pagos que quedaron 'pendiente' (ej. el servidor se cayó a mitad de un cobro)
  async marcarPendientesComoError(mensaje) {
    if (!db.disponible()) return 0;
    const { rowCount } = await db.query(
      `UPDATE transacciones SET estado = 'error', error = $1, actualizado_en = now() WHERE estado = 'pendiente'`,
      [mensaje],
    );
    if (rowCount) avisarTransaccion(-1, 'error');
    return rowCount;
  },
};

module.exports = Transaccion;
