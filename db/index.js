// CLI de la base de transacciones (usa src/models).
//
//   node db setup                   -> crea la base (si no existe) y las tablas
//   node db list [n]                -> últimas n transacciones (por defecto 20)
//   node db show <id>               -> detalle de una transacción con sus eventos
//
// Conexión: DATABASE_URL en .env

const db = require('../src/models/db');

async function listar(n = 20) {
  const { rows } = await db.query(
    `SELECT id, to_char(creado_en, 'YYYY-MM-DD HH24:MI:SS') AS fecha, tipo, origen, estado, monto, ticket,
            response_code AS rc, response_message AS mensaje, authorization_code AS aut, operation_number AS oper, last4
     FROM transacciones ORDER BY id DESC LIMIT $1`,
    [n],
  );
  console.table(rows);
}

async function mostrar(id) {
  const { rows } = await db.query('SELECT * FROM transacciones WHERE id = $1', [id]);
  if (!rows.length) throw new Error(`No existe la transacción ${id}`);
  console.log(rows[0]);
  const ev = await db.query(
    `SELECT to_char(creado_en, 'HH24:MI:SS.MS') AS hora, codigo, mensaje FROM transaccion_eventos
     WHERE transaccion_id = $1 ORDER BY id`,
    [id],
  );
  console.table(ev.rows);
}

if (require.main === module) {
  const [cmd = 'list', ...args] = process.argv.slice(2);
  (async () => {
    if (!db.disponible()) throw new Error('Define DATABASE_URL en .env, ej. postgres://postgres:CLAVE@localhost:5432/im30');
    if (cmd === 'setup') await db.setup();
    else if (cmd === 'list') await listar(parseInt(args[0] || '20', 10));
    else if (cmd === 'show') await mostrar(args[0]);
    else throw new Error(`Comando desconocido: ${cmd}`);
  })()
    .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
    .finally(() => db.cerrar());
}
