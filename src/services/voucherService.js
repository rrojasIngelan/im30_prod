// Voucher de Transbank: genera un PDF con las líneas que entrega el POS y lo envía a la impresora.
// Impresora del kiosco: "Star TUP900 (TUP942)".
//
// .env:
//   VOUCHER_IMPRIMIR=1                       1 = imprimir; 0 = solo guardar el PDF
//   VOUCHER_IMPRESORA=Star TUP900 (TUP942)   nombre exacto de la impresora en Windows (vacío = predeterminada)
//   VOUCHER_DIR=vouchers                     carpeta donde se guardan los PDF
//   VOUCHER_ANCHO_MM=72                      ancho imprimible: 72 (rollo 80 mm) o 104 (rollo 112 mm)
//   VOUCHER_LETRA_MAX=10                     letra máxima en pt (se achica si una línea no cabe)
//   VOUCHER_NEGRITA=1                        1 = Courier Bold (más oscuro en térmica, por defecto); 0 = normal
//   VOUCHER_REFUERZO=1                       pasadas extra de cada línea para engrosar el trazo (0 = ninguna, máx 3)
//   VOUCHER_ESCALA=noscale                   noscale (tamaño real) | fit | shrink
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const config = require('../config');

const MM = 72 / 25.4; // puntos por milímetro

// Arma el PDF en Courier con el ancho del papel (VOUCHER_ANCHO_MM). La letra se ajusta a la línea
// más larga del voucher para que ninguna se corte a la derecha. Alto según la cantidad de líneas.
async function generarPDF(lineas, archivo) {
  const doc = await PDFDocument.create();
  const fuente = await doc.embedFont(config.voucher.negrita ? StandardFonts.CourierBold : StandardFonts.Courier);
  const margen = 2 * MM;
  const ancho = config.voucher.anchoMm * MM;
  const texto = lineas
    .filter((l) => l != null && !String(l).includes('null'))
    .map((l) => String(l).replace(/[^\x20-\xFF]/g, ' ').trimEnd()); // conserva los espacios iniciales (centrado del POS)
  const columnas = Math.max(32, ...texto.map((l) => l.length));
  texto.push(''); // espacio antes del corte

  // Refuerzo: cada línea se dibuja otra vez desplazada 1 punto de la impresora (203 dpi ≈ 0,125 mm)
  // por pasada, para engrosar el trazo: la térmica pierde los bordes grises y la letra sale clara.
  const paso = 25.4 / 203 * MM;
  const extra = config.voucher.refuerzo * paso;
  // Courier: cada carácter mide 0,6 × el tamaño de la letra
  const tam = Math.min(config.voucher.letraMax, (ancho - margen * 2 - extra) / (columnas * 0.6));
  const alto = tam * 1.25;
  const page = doc.addPage([ancho, Math.max(60 * MM, margen * 2 + texto.length * alto + 4 * MM)]);
  let y = page.getHeight() - margen - tam;
  for (const l of texto) {
    for (let i = 0; i <= config.voucher.refuerzo; i++) {
      page.drawText(l, { x: margen + i * paso, y, size: tam, font: fuente });
    }
    y -= alto;
  }
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, await doc.save());
  return archivo;
}

async function imprimirPDF(archivo) {
  const { print } = require('pdf-to-printer');
  // noscale: imprime a tamaño real, alineado a la izquierda (con "fit" el driver lo agranda a su
  // papel configurado y, si es más ancho que el rollo real, se corta la derecha)
  const opciones = { silent: true, scale: config.voucher.escala };
  if (config.voucher.impresora) opciones.printer = config.voucher.impresora;
  await print(archivo, opciones);
}

// Solo genera el PDF. Devuelve la ruta o null (nunca lanza).
async function generarVoucher(lineas, nombre) {
  if (!Array.isArray(lineas) || !lineas.length) return null;
  try {
    const archivo = path.resolve(config.voucher.dir, `${nombre}.pdf`);
    await generarPDF(lineas, archivo);
    console.log(`[VOUCHER] PDF generado: ${archivo}`);
    return archivo;
  } catch (e) {
    console.error(`[VOUCHER] No se pudo generar el PDF: ${e.message}`);
    return null;
  }
}

// Imprime un PDF ya generado en VOUCHER_IMPRESORA. Lanza si falla (para informar a quien lo pidió).
async function imprimirVoucher(archivo) {
  await imprimirPDF(archivo);
  console.log(`[VOUCHER] Impreso en ${config.voucher.impresora || 'la impresora predeterminada'}: ${archivo}`);
}

// Genera y (si VOUCHER_IMPRIMIR=1) imprime. Nunca lanza: solo informa en consola.
async function procesarVoucher(lineas, nombre) {
  const archivo = await generarVoucher(lineas, nombre);
  if (archivo && config.voucher.imprimir) {
    await imprimirVoucher(archivo).catch((e) => console.error(`[VOUCHER] No se pudo imprimir: ${e.message}`));
  }
  return archivo;
}

module.exports = { generarPDF, imprimirPDF, generarVoucher, imprimirVoucher, procesarVoucher };
