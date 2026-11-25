// GET /health: estado del POS y de la base
const posService = require('../services/posService');
const db = require('../models/db');
const view = require('../views/pagoView');

async function health(req, res) {
  const pos = await posService.estado();
  let dbEstado = { ok: false };
  try {
    await db.query('SELECT 1');
    dbEstado = { ok: true };
  } catch (e) {
    dbEstado = { ok: false, error: e.message };
  }
  const cuerpo = view.health(pos, dbEstado);
  res.status(cuerpo.ok ? 200 : 503).json(cuerpo);
}

module.exports = { health };
