// Cliente de ejemplo del backend de pagos (server.js), como lo usaría una caja.
// Envía un cobro al POS y lo sigue con un "watch" (GET /pagos/:id/watch, Server-Sent Events):
// el backend avisa cada cambio (mensajes del POS y resultado) sin que la caja tenga que preguntar.
//
// Uso (con "node server.js" corriendo en otra terminal):
//   node cliente.js <monto> [ticket] [descripcion] [referencia]
//   node cliente.js 1500 ANGEL "Pago de prueba"
//   node cliente.js --watch <id>        solo seguir un pago ya creado
//
// Variables (.env o terminal):
//   API_URL=http://127.0.0.1:3000   (por defecto usa HOST/PORT del .env)
//   API_KEY=...                     (si el backend la exige)

require('./env');

const API = process.env.API_URL || `http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`;
const HEADERS = {
  'Content-Type': 'application/json',
  ...(process.env.API_KEY ? { 'x-api-key': process.env.API_KEY } : {}),
};
const LIMITE_MS = 5 * 60_000; // máximo a esperar un pago (el POS espera al cliente hasta ~3 min)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(metodo, ruta, cuerpo) {
  let r;
  try {
    r = await fetch(`${API}${ruta}`, { method: metodo, headers: HEADERS, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  } catch (e) {
    throw new Error(`No se pudo conectar a ${API} (¿está corriendo "node server.js"?)`);
  }
  const datos = await r.json().catch(() => ({}));
  return { status: r.status, datos };
}

// Lee un stream de Server-Sent Events y llama onEvento(nombre, datos) por cada evento.
async function leerEventos(respuesta, onEvento) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const trozo of respuesta.body) {
    buffer += decoder.decode(trozo, { stream: true });
    let fin;
    while ((fin = buffer.indexOf('\n\n')) >= 0) {
      const bloque = buffer.slice(0, fin);
      buffer = buffer.slice(fin + 2);
      let evento = 'message';
      const datos = [];
      for (const linea of bloque.split('\n')) {
        if (linea.startsWith('event:')) evento = linea.slice(6).trim();
        else if (linea.startsWith('data:')) datos.push(linea.slice(5).trimStart());
      }
      if (datos.length) onEvento(evento, JSON.parse(datos.join('\n')));
    }
  }
}

// Sigue un pago hasta que termina. onCambio(pago) se llama con cada estado (mensajes del POS incluidos).
// Si la conexión se corta, se reconecta (el watch reenvía el estado actual al conectar).
async function seguir(id, onCambio = () => {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < LIMITE_MS) {
    let final = null;
    try {
      const r = await fetch(`${API}/pagos/${id}/watch`, { headers: HEADERS, signal: AbortSignal.timeout(LIMITE_MS) });
      if (r.status !== 200) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`${r.status} ${d.error || 'no se pudo seguir el pago'}`);
      }
      await leerEventos(r, (evento, pago) => {
        onCambio(pago);
        if (evento === 'fin') final = pago;
      });
      if (final) return final;
    } catch (e) {
      if (/^4\d\d /.test(e.message)) throw e; // error definitivo (no existe, sin permiso)
      console.warn(`  (se perdió la conexión con el backend: ${e.message}; reconectando...)`);
    }
    await sleep(2000);
  }
  throw new Error(`El pago ${id} sigue pendiente después de ${LIMITE_MS / 1000} s; consultar GET /pagos/${id}`);
}

// Muestra solo los mensajes nuevos del POS (Opere tarjeta, Clave, Enviando al host...)
function mostrarProgreso() {
  let vistos = 0;
  return (pago) => {
    for (const e of (pago.eventos || []).slice(vistos)) console.log(`  [POS] ${e.codigo} - ${e.mensaje}`);
    vistos = pago.eventos?.length || 0;
  };
}

// Envía el cobro y espera a que termine (sin consultar en bucle). Devuelve el detalle del pago.
async function pagar({ monto, ticket, descripcion, referencia }, onCambio = mostrarProgreso()) {
  const { status, datos } = await api('POST', '/pagos', { monto, ticket, descripcion, referencia });
  if (status !== 202) throw new Error(`${status} ${datos.error || 'respuesta inesperada'}${datos.id ? ` (pago ${datos.id})` : ''}`);
  console.log(`Pago ${datos.id} enviado al POS. Esperando al cliente...`);
  return seguir(datos.id, onCambio);
}

function mostrarResultado(pago) {
  if (pago.estado === 'aprobada') {
    console.log(`✔ Aprobado: $${pago.monto} | aut ${pago.autorizacion} | oper ${pago.operacion}` +
      (pago.tarjeta ? ` | ${pago.tarjeta.tipo || ''} ****${pago.tarjeta.ultimos4}` : ''));
  } else if (pago.estado === 'rechazada') {
    console.log(`✘ Rechazado: ${pago.respuesta?.codigo} ${pago.respuesta?.mensaje}`);
  } else {
    console.log(`✘ Error: ${pago.error}`);
  }
  console.log(`Detalle: ${API}/pagos/${pago.id}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--watch') {
    if (!args[1]) throw new Error('Indica el id del pago: node cliente.js --watch <id>');
    console.log(`Siguiendo el pago ${args[1]}...`);
    mostrarResultado(await seguir(args[1], mostrarProgreso()));
    return;
  }
  const [monto, ticket, descripcion, referencia] = args;
  if (!monto) {
    console.log('Uso: node cliente.js <monto> [ticket] [descripcion] [referencia]');
    console.log('     node cliente.js --watch <id>');
    console.log('Ej.: node cliente.js 1500 ANGEL "Pago de prueba"');
    process.exitCode = 1;
    return;
  }

  const { status, datos: salud } = await api('GET', '/health');
  if (status !== 200) throw new Error(`Backend no disponible: ${JSON.stringify(salud)}`);

  mostrarResultado(await pagar({ monto: Number(monto), ticket, descripcion, referencia }));
}

if (require.main === module) {
  main().catch((e) => { console.error('Error:', e.message); process.exitCode = 1; });
}

module.exports = { pagar, seguir };
