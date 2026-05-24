const mysql = require('mysql2/promise');

const IS_DB_CONFIGURED = !!(
  process.env.DB_HOST &&
  process.env.DB_USER &&
  process.env.DB_PASS &&
  process.env.DB_NAME &&
  !process.env.DB_HOST.includes('your-')
);

let pool = null;

if (IS_DB_CONFIGURED) {
  pool = mysql.createPool({
    host:             process.env.DB_HOST || 'localhost',
    port:             parseInt(process.env.DB_PORT || '3306', 10),
    user:             process.env.DB_USER,
    password:         process.env.DB_PASS,
    database:         process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit:  10,
    queueLimit:       0,
    timezone:         '+00:00',
    charset:          'utf8mb4',
  });

  // Test connection on startup (non-blocking)
  pool.getConnection()
    .then(conn => { conn.release(); console.log('[db] MySQL connected to', process.env.DB_NAME); })
    .catch(err => console.error('[db] MySQL connection failed:', err.message));
} else {
  console.log('[db] MySQL not configured — running in mock/API-Football mode');
}

/**
 * Run a parameterised SELECT that returns multiple rows.
 * Returns [] when DB not configured.
 */
async function query(sql, params = []) {
  if (!pool) return [];
  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * Run a parameterised query and return the first row (or null).
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Run an INSERT / UPDATE / DELETE and return the ResultSetHeader.
 */
async function execute(sql, params = []) {
  if (!pool) return { insertId: null, affectedRows: 0 };
  const [result] = await pool.execute(sql, params);
  return result;
}

/**
 * Run multiple statements in a single transaction.
 * `fn` receives the connection and should return a value.
 */
async function transaction(fn) {
  if (!pool) return null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, queryOne, execute, transaction, IS_DB_CONFIGURED };
