// Cuotas de una venta (manual IM30, respuesta 0210, campos opcionales tras el voucher):
//   Tipo cuota (00 sin cuota · 01 cuota normal · 03 cuota contado · 04 n cuotas)
//   Número de cuotas · Monto cuota · Glosa tipo cuota (ej. "CUOTAS SIN INTERES")
// El POS solo los envía si el comercio tiene contratado el producto Cuotas. Si no vienen,
// se buscan en el voucher ("NUMERO DE CUOTAS: 06"); si tampoco están, la venta es sin cuotas.

const TIPOS = { '00': 'Sin cuotas', '01': 'Cuota normal', '03': 'Cuota contado', '04': 'N cuotas' };

const entero = (v) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isNaN(n) ? null : n;
};

function cuotasDesdeVoucher(voucher) {
  const texto = (Array.isArray(voucher) ? voucher.join('\n') : String(voucher || '')).toUpperCase();
  const n = /NUMERO DE CUOTAS\s*:?\s*(\d+)/.exec(texto);
  if (!n) return null;
  const glosa = /TIPO DE CUOTAS\s*:?\s*([A-ZÁÉÍÓÚÑ ]+?)(?:\s{2,}|\n|VALOR|MONTO|$)/.exec(texto);
  const monto = /(?:VALOR|MONTO) CUOTA\s*\d*\s*:?\s*\$?\s*([\d.]+)/.exec(texto);
  return {
    numero: entero(n[1]),
    glosa: glosa ? glosa[1].trim() : null,
    monto: monto ? entero(monto[1].replace(/\./g, '')) : null,
  };
}

// res: respuesta de venta del POS (sharesType, sharesNumber, sharesAmount, sharesTypeComment, voucher)
// Devuelve { conCuotas, numero, montoCuota, tipo, codigoTipo }
function cuotas(res = {}) {
  const codigoTipo = String(res.sharesType ?? '').trim() || null;
  let numero = entero(res.sharesNumber);
  let montoCuota = entero(res.sharesAmount);
  let glosa = String(res.sharesTypeComment ?? '').trim() || null;

  if (!numero) {
    const v = cuotasDesdeVoucher(res.voucher);
    if (v) { numero = v.numero; montoCuota = montoCuota ?? v.monto; glosa = glosa ?? v.glosa; }
  }

  const conCuotas = Boolean(numero && numero > 1);
  return {
    conCuotas,
    numero: conCuotas ? numero : null,
    // 0 = el emisor no informó el valor (cuotas con interés): se guarda vacío, no $0
    montoCuota: conCuotas && montoCuota > 0 ? montoCuota : null,
    tipo: conCuotas ? (glosa || TIPOS[codigoTipo] || 'Cuotas') : 'Sin cuotas',
    codigoTipo,
  };
}

module.exports = { cuotas, cuotasDesdeVoucher, TIPOS };
