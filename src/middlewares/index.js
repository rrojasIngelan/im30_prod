// Middlewares: API key, log de peticiones, 404 y manejo de errores
const crypto = require('crypto');
const config = require('../config');
const view = require('../views/pagoView');
const { UnauthorizedError, NotFoundError } = require('../utils/errors');

// Si API_KEY está definida, exige el header x-api-key (comparación en tiempo constante)
function apiKey(req, res, next) {
  if (!config.http.apiKey) return next();
  const recibida = Buffer.from(String(req.get('x-api-key') || ''));
  const esperada = Buffer.from(config.http.apiKey);
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) {
    return next(UnauthorizedError());
  }
  next();
}

function logger(req, res, next) {
  const inicio = Date.now();
  res.on('finish', () => console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - inicio} ms)`));
  next();
}

function noEncontrado(req, res, next) {
  next(NotFoundError('Ruta no encontrada'));
}

// eslint-disable-next-line no-unused-vars
function manejarErrores(err, req, res, next) {
  // JSON mal formado o cuerpo demasiado grande (express.json)
  if (err.type === 'entity.parse.failed') err = Object.assign(new Error('JSON inválido'), { status: 400 });
  if (err.type === 'entity.too.large') err = Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 });

  const status = err.status || 500;
  if (status >= 500) console.error(`[HTTP] ${req.method} ${req.originalUrl}:`, err);
  res.status(status).json(view.error(status >= 500 && !err.status ? new Error('Error interno') : err));
}

module.exports = { apiKey, logger, noEncontrado, manejarErrores };
