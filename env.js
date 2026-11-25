// Carga .env (en la carpeta del proyecto) sin dependencias, con process.loadEnvFile de Node >= 20.12.
// Las variables ya definidas en la terminal NO se sobrescriben.
const fs = require('fs');
const path = require('path');

const archivo = path.join(__dirname, '.env');
if (fs.existsSync(archivo) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(archivo);
}
// Si la clave sigue siendo el marcador del ejemplo, no intentar conectar a la base
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('TU_CLAVE')) {
  delete process.env.DATABASE_URL;
}
