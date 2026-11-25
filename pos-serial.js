// Cliente propio del POS Autoservicio IM30 (Transbank / PAX) por puerto serial RS232.
// CLI sobre src/lib/PosSerial.js (protocolo) y src/services/registroService.js (registro en la base).
// Referencia: ManualIntegracion-IM30-v5.pdf (Transbank Developers).
//
// Conexión física: cable RJ45 (puerto RS232-A o RS232-B del IM30) + adaptador USB-Serial.
// Serial: 1200..115200 bps 8N1, velocidad inicial del POS 19200.
//
// Uso:
//   node pos-serial.js ports
//   node pos-serial.js poll
//   node pos-serial.js init                    -> 0070 + espera + 0080
//   node pos-serial.js keys                    -> carga de llaves (0800)
//   node pos-serial.js sale <monto> [ticket]   -> venta (0200). Ticket hasta 20 caracteres
//   node pos-serial.js last                    -> última venta (0250)
//   node pos-serial.js refund <operacion>      -> anulación (1200)
//   node pos-serial.js close                   -> cierre (0500)
//   node pos-serial.js listen [monto]          -> espera 0911 ("Paga con tarjeta") y lanza la venta
//   node pos-serial.js raw "<comando>"         -> envía un comando tal cual (ej. "0250|0")
//
// Variables de entorno:
//   POS_PORT=auto        puerto COM (ej. COM16) o "auto" (por defecto): busca el adaptador USB-serie donde responde el POS
//   POS_BAUD=19200       velocidad (por defecto 19200)
//   POS_DEBUG=1          muestra los bytes enviados y recibidos
//   POS_VOUCHER=1        pide voucher formateado (campo impresión = 1)
//   POS_ACK_TIMEOUT=3000 ms para esperar el ACK de cada comando
//   POS_RESP_TIMEOUT=75000   ms para esperar la respuesta (una venta espera al cliente)
//   BACKEND_URL=...      listen: GET devuelve {"monto":1500,"ticket":"ABC"} o 204 (nada que cobrar)
//   POS_LISTEN_MS=0      listen: termina solo después de N ms (pruebas)
//   DATABASE_URL=postgres://usuario:clave@localhost:5432/im30
//                        registra ventas, anulaciones y cierres en PostgreSQL (ver db/index.js)


const config = require('./src/config'); // carga .env
const { PosSerial, RESPUESTAS } = require('./src/lib/PosSerial');
const { ventaRegistrada, operacionRegistrada, sinFallar } = require('./src/services/registroService');
const Transaccion = require('./src/models/Transaccion');
const db = require('./src/models/db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function obtenerMonto(montoFijo) {
  if (process.env.BACKEND_URL) {
    const r = await fetch(process.env.BACKEND_URL);
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`Backend respondió ${r.status}`);
    return r.json(); // { monto, ticket }
  }
  return montoFijo ? { monto: parseInt(montoFijo, 10) } : null;
}

const mostrarEstado = (d) => console.log(`[POS] ${d.responseCode} - ${d.responseMessage}`);

const mostrarVenta = (res) => console.log(res.successful
  ? `✔ Venta aprobada (aut ${res.authorizationCode}, $${res.amount}, oper ${res.operationNumber})`
  : `✘ Venta no aprobada: ${res.responseCode} ${res.responseMessage}`);

async function escuchar(pos, montoFijo, voucher) {
  let ocupado = false;
  pos.on('mensaje', async (texto) => {
    console.log(`[POS] Mensaje no solicitado: ${texto}`);
    if (texto.split('|')[0] !== '0911') return;
    if (ocupado) { console.log('[POS] 0911 con una venta en curso; se ignora'); return; }
    ocupado = true;
    try {
      const pedido = await obtenerMonto(montoFijo);
      if (!pedido?.monto) { console.log('[POS] Sin monto pendiente; no se inicia venta'); return; }
      const res = await ventaRegistrada(pos, pedido.monto, pedido.ticket, { voucher, origen: 'pos_0911', onIntermedio: mostrarEstado });
      mostrarVenta(res);
    } catch (e) {
      console.error('✘ Error en la venta:', e.message);
    } finally {
      ocupado = false;
    }
  });
  console.log('Esperando que un cliente toque "Paga con tarjeta" (0911)... Ctrl+C para salir');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    const ms = parseInt(process.env.POS_LISTEN_MS || '0', 10);
    if (ms > 0) setTimeout(resolve, ms);
  });
}

async function main() {
  const [cmd = 'poll', ...args] = process.argv.slice(2);
  if (cmd === 'ports') { console.table(await PosSerial.listar()); return; }

  const { voucher } = config.pos;
  const pos = new PosSerial({
    debug: config.pos.debug,
    ackTimeout: config.pos.ackTimeout,
    responseTimeout: config.pos.responseTimeout,
  });
  pos.on('error', (e) => console.error('Error de puerto:', e.message));

  const puerto = await pos.conectarA(config.pos.port, config.pos.baud);
  if (config.pos.auto) console.log(`[POS] Detectado en ${puerto}`);
  try {
    // Antes de operar con tarjetas: poll + carga de llaves (igual que el backend al conectar)
    if (['sale', 'listen', 'refund'].includes(cmd) && config.pos.cargarLlavesAlConectar) {
      await pos.poll();
      console.log('[POS] Poll OK. Cargando llaves (0800)...');
      const k = await operacionRegistrada('carga_llaves', { comando: '0800' }, () => pos.cargarLlaves());
      console.log(`[POS] Carga de llaves: ${k.successful ? 'OK' : 'FALLÓ'} (${k.responseCode} ${k.responseMessage})`);
    }
    let res;
    switch (cmd) {
      case 'poll': res = await pos.poll(); break;
      case 'init': res = await pos.inicializar(); break;
      case 'keys': res = await pos.cargarLlaves(); break;
      case 'sale':
        res = await ventaRegistrada(pos, args[0], args[1], { voucher, onIntermedio: mostrarEstado });
        mostrarVenta(res);
        break;
      case 'last': res = await pos.ultimaVenta(voucher); break;
      case 'refund': {
        const anulaA = await sinFallar(() => Transaccion.buscarVentaAprobadaPorOperacion(args[0]));
        res = await operacionRegistrada('anulacion', { comando: `1200|${args[0]}`, anulaA }, () => pos.anular(args[0]));
        break;
      }
      case 'close': res = await operacionRegistrada('cierre', { comando: `0500|${voucher ? 1 : 0}` }, () => pos.cierre(voucher)); break;
      case 'listen': await escuchar(pos, args[0], voucher); return;
      case 'raw': {
        if (!args[0]) throw new Error('Indica el comando, ej. raw "0250|0"');
        // Espera mensajes que lleguen durante 5 s después del ACK
        pos.on('mensaje', (t) => console.log(`IN: ${t}`));
        res = await pos.comando(args[0]);
        await sleep(parseInt(process.env.POS_RAW_WAIT || '5000', 10));
        break;
      }
      default: throw new Error(`Comando desconocido: ${cmd}`);
    }
    console.log(JSON.stringify(res, null, 2));
  } finally {
    await pos.cerrar();
    await sinFallar(() => db.cerrar());
  }
}

if (require.main === module) {
  main()
    .catch((e) => { console.error('Error:', e.message || e); process.exitCode = 1; })
    .finally(() => process.exit());
}

module.exports = { PosSerial, RESPUESTAS };
