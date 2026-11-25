// GET /eventos: Server-Sent Events con los cambios de transacciones, para la vista web en vivo.
// Solo envía el id y el tipo de cambio (nada sensible); la página pide los datos a /pagos.
const { bus } = require('../utils/eventos');

function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n'); // el navegador reintenta a los 3 s si se corta

  const enviar = (dato) => res.write(`event: transaccion\ndata: ${JSON.stringify(dato)}\n\n`);
  bus.on('transaccion', enviar);

  // Latido cada 25 s para que proxies y navegadores no cierren la conexión inactiva
  const latido = setInterval(() => res.write(': latido\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(latido);
    bus.off('transaccion', enviar);
  });
}

module.exports = { stream };
