// Aplicación Express (sin levantar el servidor: eso lo hace server.js)
const express = require('express');
const routes = require('./routes');
const web = require('./controllers/webController');
const eventos = require('./controllers/eventosController');
const { apiKey, logger, noEncontrado, manejarErrores } = require('./middlewares');

const app = express();
app.disable('x-powered-by');
app.use(logger);
app.use(express.json({ limit: '10kb' }));

// Vista web de transacciones (la página no tiene datos; los pide a /pagos, que sí exige la API key)
app.get('/transacciones', web.transacciones);
app.get('/', (req, res) => res.redirect('/transacciones'));
app.get(['/favicon.svg', '/favicon.ico'], web.favicon);
// Avisos en vivo de cambios (solo ids; EventSource no puede enviar el header x-api-key)
app.get('/eventos', eventos.stream);

app.use(apiKey);
app.use(routes);
app.use(noEncontrado);
app.use(manejarErrores);

module.exports = app;
