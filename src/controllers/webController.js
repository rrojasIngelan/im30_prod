// Vistas web (HTML) del backend
const path = require('path');

// GET /transacciones: página con la lista de transacciones (usa la API /pagos y /health)
function transacciones(req, res) {
  res.sendFile(path.join(__dirname, '..', 'views', 'web', 'transacciones.html'));
}

// GET /favicon.svg y /favicon.ico: ícono del sitio (SVG, sirve para ambas rutas)
function favicon(req, res) {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, '..', 'views', 'web', 'favicon.svg'));
}

module.exports = { transacciones, favicon };
