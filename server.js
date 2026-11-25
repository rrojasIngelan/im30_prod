// Backend de pagos con el POS IM30 (serial) — punto de entrada.
//
//   node server.js
//
// Estructura MVC (src/):
//   config/       configuración desde .env
//   lib/          protocolo del POS (PosSerial)
//   models/       PostgreSQL: conexión y modelo Transaccion
//   services/     lógica: cobrar/anular en el POS registrando en la base
//   controllers/  reciben la petición HTTP, validan y responden
//   views/        forma del JSON de respuesta
//   validators/   validación de entrada
//   middlewares/  API key, log, 404, errores
//   routes/       rutas de la API
//
// Endpoints:
//   GET  /health                    estado del POS y de la base
//   POST /pagos                     { monto, ticket?, descripcion?, referencia?, esperar? } -> 202 (o 200 si esperar)
//   GET  /pagos?limite=50&estado=   lista de transacciones
//   GET  /pagos/:id                 detalle con eventos
//   POST /pagos/:id/anular          anula una venta aprobada
//   POST /pos/llaves                fuerza una carga de llaves (0800). Al conectar se hace poll + carga de llaves
//   POST /pos/cierre                cierre del día (0500). Automático con CIERRE_DIARIO=HH:MM
//   GET  /pos/ultima-venta          última venta guardada en el POS (0250)

const config = require('./src/config');
const app = require('./src/app');
const db = require('./src/models/db');
const posService = require('./src/services/posService');

if (!config.db.url) {
  console.error('Falta DATABASE_URL en .env: el backend necesita la base para registrar y consultar pagos.');
  process.exit(1);
}

let servidor;

async function iniciar() {
  await db.setup(); // crea tablas/columnas si faltan (idempotente)

  // Primero el servidor HTTP (no esperar al POS para atender peticiones)
  const base = `http://${config.http.host}:${config.http.port}`;
  servidor = app.listen(config.http.port, config.http.host, () => {
    console.log(`Backend de pagos en ${base}${config.http.apiKey ? ' (requiere x-api-key)' : ''}`);
    console.log(`  API: ${base}/health, ${base}/pagos, ${base}/pos/...`);
    console.log(`  Vista: ${base}/transacciones`);
  });
  servidor.on('error', (e) => {
    console.error(`No se pudo escuchar en el puerto ${config.http.port}: ${e.message}`);
    process.exit(1);
  });
  programarCierreDiario();

  // Luego el POS: poll y carga de llaves en segundo plano
  try {
    await posService.conectar();
    console.log(`[POS] Conectado en ${posService.puertoActual()}`);
  } catch (e) {
    console.warn(`[POS] ${e.message}; se reintentará en segundo plano`);
    posService.reintentarConexion();
  }

  // Pagos que quedaron 'pendiente' en una ejecución anterior: verificar con la última venta del POS
  await posService.conciliarPendientes().catch((e) => console.error(`[POS] Conciliación: ${e.message}`));
}

// Cierre diario automático (manual IM30: cierre diario o como mínimo semanal).
// CIERRE_DIARIO=HH:MM en .env (vacío = desactivado). Si el POS está ocupado, reintenta en 5 min.
let timerCierre;
function programarCierreDiario() {
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(process.env.CIERRE_DIARIO || '');
  if (!hhmm) return;
  const proximo = new Date();
  proximo.setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0);
  if (proximo <= new Date()) proximo.setDate(proximo.getDate() + 1);
  console.log(`[CIERRE] Próximo cierre automático: ${proximo.toLocaleString('es-CL')}`);
  const ejecutar = async (intento = 1) => {
    try {
      await posService.cierre();
      programarCierreDiario();
    } catch (e) {
      console.error(`[CIERRE] Intento ${intento} falló: ${e.message}`);
      if (intento < 6) timerCierre = setTimeout(() => ejecutar(intento + 1), 5 * 60_000);
      else programarCierreDiario();
    }
  };
  timerCierre = setTimeout(() => ejecutar(), proximo - new Date());
}

async function apagar() {
  clearTimeout(timerCierre);
  console.log('Cerrando...');
  servidor?.close();
  await posService.cerrar().catch(() => { });
  await db.cerrar().catch(() => { });
  process.exit(0);
}
// Red de seguridad: un error asíncrono no manejado (ej. del puerto serie) no debe tumbar el backend
process.on('unhandledRejection', (e) => console.error('[ERROR] Promesa rechazada sin manejar:', e?.stack || e));

process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);

iniciar().catch((e) => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
