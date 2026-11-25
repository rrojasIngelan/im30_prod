// Configuración centralizada (lee .env a través de env.js)
require('../../env');

const int = (v, def) => (v === undefined || v === '' ? def : parseInt(v, 10));

module.exports = {
  http: {
    port: int(process.env.PORT, 3000),
    host: process.env.HOST || '127.0.0.1',
    apiKey: process.env.API_KEY || '',
  },
  pos: {
    // Puerto COM del adaptador USB-serie o "auto" (por defecto): detecta el adaptador donde responde el POS
    port: process.env.POS_PORT || 'auto',
    auto: !process.env.POS_PORT || process.env.POS_PORT.toLowerCase() === 'auto',
    baud: int(process.env.POS_BAUD, 19200),
    debug: process.env.POS_DEBUG === '1',
    voucher: process.env.POS_VOUCHER === '1',
    ackTimeout: int(process.env.POS_ACK_TIMEOUT, 3000),
    responseTimeout: int(process.env.POS_RESP_TIMEOUT, 75000),
    // Al conectar: poll + carga de llaves (0800). Desactivar con POS_LLAVES_AL_CONECTAR=0
    cargarLlavesAlConectar: process.env.POS_LLAVES_AL_CONECTAR !== '0',
    // Máximo para esperar la respuesta de la carga de llaves (el POS tarda ~50 s si no llega a Transbank)
    llavesTimeout: int(process.env.POS_LLAVES_TIMEOUT, 70000),
    // Cada cuánto reintentar la conexión tras un corte del puerto
    reconexionMs: int(process.env.POS_RECONEXION_MS, 10000),
  },
  voucher: {
    imprimir: process.env.VOUCHER_IMPRIMIR === '1',
    impresora: process.env.VOUCHER_IMPRESORA || '',
    dir: process.env.VOUCHER_DIR || 'vouchers',
    // Ancho imprimible del papel en mm: 72 para rollo de 80 mm, 104 para rollo de 112 mm
    anchoMm: Number(process.env.VOUCHER_ANCHO_MM) || 72,
    // Letra máxima (pt); se achica sola si la línea más larga no cabe en el ancho
    letraMax: Number(process.env.VOUCHER_LETRA_MAX) || 10,
    // Letra en negrita (Courier Bold, mismo ancho): se imprime más oscura en impresoras térmicas. 0 = normal
    negrita: process.env.VOUCHER_NEGRITA !== '0',
    // Pasadas extra de cada línea, desplazadas 1 punto, para engrosar el trazo (0 = ninguna, máx 3)
    refuerzo: Math.min(3, Math.max(0, int(process.env.VOUCHER_REFUERZO, 1) || 0)),
    // Escala al imprimir: noscale (tamaño real, recomendado) | fit | shrink
    escala: ['noscale', 'fit', 'shrink'].includes(process.env.VOUCHER_ESCALA) ? process.env.VOUCHER_ESCALA : 'noscale',
  },
  db: {
    url: process.env.DATABASE_URL || '',
  },
};
