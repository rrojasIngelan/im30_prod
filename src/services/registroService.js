// Ejecuta operaciones en el POS dejándolas registradas en la base:
//   1. crea la transacción 'pendiente'  2. envía al POS  3. guarda eventos y resultado (o error).
// Lo usan el backend (posService) y la CLI (pos-serial.js).
// Un fallo de la base nunca interrumpe una operación ya enviada al POS: solo se avisa.
const { PosSerial } = require('../lib/PosSerial');
const Transaccion = require('../models/Transaccion');
const { generarVoucher } = require('./voucherService');

const sinFallar = async (fn) => {
  try { return await fn(); } catch (e) { console.warn(`[BD] ${e.message}`); return null; }
};

const normalizarTicket = (t) => String(t ?? '').trim().replace(/^0+/, '');

// Manual IM30 ("Datos última venta"): si la caja no recibe respuesta a la venta, debe pedir la
// última venta (0250) y comparar el ticket. Si coincide, el cobro YA se realizó; si no, no se cobró.
// Devuelve la respuesta de la venta si coincide, o null.
async function conciliarConUltimaVenta(pos, ticket, voucher) {
  const ultima = await pos.ultimaVenta(voucher);
  console.log(`[POS] Última venta: ticket ${ultima.ticket ?? '-'} (${ultima.responseCode} ${ultima.responseMessage})`);
  if (ultima.responseCode === 0 && normalizarTicket(ultima.ticket) === normalizarTicket(ticket)) return ultima;
  return null;
}

// Solo tiene sentido conciliar si el POS recibió la venta (hubo ACK) y luego no llegó la respuesta.
// Un corte del puerto (e.desconectado) cuenta como recibida: pudo llegar al POS justo antes.
const recibioLaVenta = (e) => e.desconectado || !/^(Sin ACK|NAK del POS|Puerto no abierto|Port is not open)/.test(e.message);

// Ticket único por venta (necesario para conciliar con la última venta).
// Con base: el id de la transacción (6 dígitos). Sin base: los últimos 6 dígitos de la hora.
const ticketPara = (id) => (id ? String(id).padStart(6, '0').slice(-6) : Date.now().toString().slice(-6));

// requiereRegistro: si no se pudo crear la fila en la base, NO se envía la venta al POS.
// ticket: si no se indica, se usa uno único por venta (ver ticketPara).
async function ventaRegistrada(pos, monto, ticket, {
  voucher = false, origen = 'caja', descripcion = null, referencia = null, rutBeneficiario = null,
  requiereRegistro = false, onRegistrada, onIntermedio,
} = {}) {
  const { amount } = PosSerial.comandoVenta(monto, ticket ?? '0', { voucher }); // valida el monto
  const id = await sinFallar(() => Transaccion.crear({ tipo: 'venta', origen, monto: amount, ticket: ticket ?? null, descripcion, referencia, rutBeneficiario }));
  if (!id && requiereRegistro) {
    onRegistrada?.(null);
    throw new Error('No se pudo registrar la venta en la base; no se envió al POS');
  }
  const tk = ticket ?? ticketPara(id);
  const { cmd } = PosSerial.comandoVenta(amount, tk, { voucher });
  await sinFallar(() => Transaccion.actualizarComando(id, tk, cmd));
  if (id) console.log(`[BD] Transacción ${id} registrada (pendiente, ticket ${tk})`);
  onRegistrada?.(id);

  try {
    const res = await pos.venta(amount, tk, {
      voucher,
      onIntermedio: (d) => {
        onIntermedio?.(d);
        sinFallar(() => Transaccion.agregarEvento(id, d));
      },
    });
    // El PDF del voucher se genera ANTES de guardar el resultado: así, cuando el pago aparece como
    // terminado (respuesta, watch, vista web), ya trae su voucherPdf.
    const voucherPdf = id && res.voucher?.length ? await generarVoucher(res.voucher, `voucher-${id}`) : null;
    await sinFallar(() => Transaccion.guardarResultado(id, { ...res, voucherPdf }));
    return { ...res, voucherPdf, transaccionId: id };
  } catch (e) {
    if (recibioLaVenta(e)) {
      console.warn(`[POS] Venta ${id} sin respuesta (${e.message}); consultando última venta...`);
      let sinVerificar = false;
      const conciliada = await conciliarConUltimaVenta(pos, tk, voucher).catch((err) => {
        console.warn(`[POS] No se pudo consultar la última venta: ${err.message}`);
        sinVerificar = true;
        return null;
      });
      // No se sabe si se cobró: queda 'pendiente' y se verifica al reconectar (nunca se marca como error
      // un pago que Transbank pudo haber aprobado)
      if (sinVerificar) {
        console.warn(`[POS] Venta ${id} queda pendiente: se verificará con la última venta al reconectar el POS`);
        await sinFallar(() => Transaccion.marcarPorVerificar(id, `${e.message}; se verificará con la última venta del POS al reconectar`));
        e.porVerificar = true;
        e.transaccionId = id;
        throw e;
      }
      if (conciliada) {
        console.log(`[POS] La venta ${id} SÍ se cobró (ticket ${tk}); se registra como aprobada`);
        const voucherPdf = id && conciliada.voucher?.length ? await generarVoucher(conciliada.voucher, `voucher-${id}`) : null;
        await sinFallar(() => Transaccion.guardarResultado(id, { ...conciliada, voucherPdf }));
        return { ...conciliada, voucherPdf, transaccionId: id, conciliada: true };
      }
    }
    await sinFallar(() => Transaccion.marcarError(id, e));
    throw e;
  }
}

// Anulación, cierre u otra operación con respuesta simple
async function operacionRegistrada(tipo, datos, fn) {
  const id = await sinFallar(() => Transaccion.crear({ tipo, ...datos }));
  try {
    const res = await fn();
    await sinFallar(() => Transaccion.guardarResultado(id, res));
    return { ...res, transaccionId: id };
  } catch (e) {
    await sinFallar(() => Transaccion.marcarError(id, e));
    throw e;
  }
}

module.exports = { ventaRegistrada, operacionRegistrada, sinFallar, conciliarConUltimaVenta };
