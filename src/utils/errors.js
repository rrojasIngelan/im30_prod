// Errores de la aplicación con su código HTTP. Los servicios los lanzan; el errorHandler los convierte en respuesta.
class AppError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ValidationError = (msg, extra) => new AppError(400, msg, extra);
const UnauthorizedError = (msg = 'x-api-key inválida o ausente') => new AppError(401, msg);
const NotFoundError = (msg, extra) => new AppError(404, msg, extra);
const ConflictError = (msg, extra) => new AppError(409, msg, extra);
const UnavailableError = (msg, extra) => new AppError(503, msg, extra);

module.exports = { AppError, ValidationError, UnauthorizedError, NotFoundError, ConflictError, UnavailableError };
