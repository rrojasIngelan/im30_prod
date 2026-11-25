// Nombre legible de la marca de la tarjeta (Visa, Mastercard, American Express, ...).
//
// El POS la informa de dos formas:
//   1. cardBrand: abreviación de 2 letras (manual IM30, "Tabla abreviación de tarjetas soportadas")
//   2. el voucher: la línea bajo el número de tarjeta trae el nombre (ej. "MASTERCARD   A0000000043060")
// Se prefiere el nombre del voucher (es el que ve el cliente); si no hay, se usa la abreviación.

const POR_CODIGO = {
  VI: 'Visa',
  MC: 'Mastercard',
  AX: 'American Express',
  DC: 'Diners Club',
  MG: 'Magna',
  DB: 'Redcompra',
};

const POR_NOMBRE = {
  VISA: 'Visa',
  'VISA ELECTRON': 'Visa Electron',
  MASTERCARD: 'Mastercard',
  'MASTER CARD': 'Mastercard',
  MAESTRO: 'Maestro',
  AMEX: 'American Express',
  'AMERICAN EXPRESS': 'American Express',
  DINERS: 'Diners Club',
  'DINERS CLUB': 'Diners Club',
  MAGNA: 'Magna',
  REDCOMPRA: 'Redcompra',
  OTRA: 'Otra',
};

const tituloCase = (t) => t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

// Busca el nombre de la marca en las líneas del voucher (null si no lo encuentra)
function marcaDesdeVoucher(voucher) {
  const lineas = Array.isArray(voucher) ? voucher : String(voucher || '').split('\n');
  const i = lineas.findIndex((l) => /NUMERO DE TARJETA/i.test(l));
  if (i < 0) return null;
  // Tras el encabezado vienen la línea del número (****1234 ...) y luego la de la marca
  for (const linea of lineas.slice(i + 1, i + 4)) {
    const texto = String(linea).trim();
    if (!texto || /\*{3,}/.test(texto) || /^TOTAL/i.test(texto)) continue;
    // "MASTERCARD                A0000000043060" -> "MASTERCARD" (se descarta el AID del chip)
    const nombre = texto.split(/\s{2,}|\s+A0{3,}\w*/)[0].trim().toUpperCase();
    if (!nombre || /\d{4,}/.test(nombre)) return null;
    return POR_NOMBRE[nombre] || tituloCase(nombre);
  }
  return null;
}

// res: respuesta de venta del POS (cardBrand, voucher) o una fila de la base (card_brand, voucher)
function marcaTarjeta({ cardBrand, card_brand, voucher } = {}) {
  const codigo = String(cardBrand ?? card_brand ?? '').trim().toUpperCase();
  const delVoucher = marcaDesdeVoucher(voucher);
  if (delVoucher && delVoucher !== 'Otra') return delVoucher;
  if (POR_CODIGO[codigo]) return POR_CODIGO[codigo];
  return delVoucher || null; // 'Otra' o sin dato
}

module.exports = { marcaTarjeta, marcaDesdeVoucher, POR_CODIGO };
