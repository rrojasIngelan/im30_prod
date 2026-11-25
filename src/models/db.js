// Conexión a PostgreSQL. Sin DATABASE_URL, disponible() es false y los modelos no hacen nada.
const fs = require('fs');
const path = require('path');
const { Pool, Client } = require('pg');
const config = require('../config');

let pool = null;

const disponible = () => Boolean(config.db.url);

function getPool() {
  if (!disponible()) return null;
  if (!pool) pool = new Pool({ connectionString: config.db.url });
  return pool;
}

function query(sql, params) {
  const p = getPool();
  if (!p) throw new Error('Base de datos no configurada (DATABASE_URL)');
  return p.query(sql, params);
}

// Crea la base (si no existe) y aplica db/schema.sql. Idempotente.
async function setup({ log = console.log } = {}) {
  if (!disponible()) throw new Error('Define DATABASE_URL, ej. postgres://postgres:CLAVE@localhost:5432/im30');
  const nombre = decodeURIComponent(new URL(config.db.url).pathname.slice(1)) || 'im30';
  const admin = new URL(config.db.url);
  admin.pathname = '/postgres';
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [nombre]);
    if (!rowCount) {
      await c.query(`CREATE DATABASE "${nombre.replace(/"/g, '""')}"`);
      log(`Base de datos "${nombre}" creada`);
    }
  } finally {
    await c.end();
  }
  await query(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8'));
  log(`Base de datos "${nombre}" lista (transacciones, transaccion_eventos)`);
}

async function cerrar() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { disponible, getPool, query, setup, cerrar };
