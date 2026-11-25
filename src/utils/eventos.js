// Bus de eventos interno: el modelo avisa cada cambio en una transacción y la vista web
// lo recibe en vivo por Server-Sent Events (GET /eventos).
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100); // una escucha por cada navegador abierto en /transacciones

// accion: creada | evento | resultado | error | actualizada
function avisarTransaccion(id, accion) {
  if (id) bus.emit('transaccion', { id: Number(id), accion, en: new Date().toISOString() });
}

module.exports = { bus, avisarTransaccion };
