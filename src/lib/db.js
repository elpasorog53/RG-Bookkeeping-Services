import pg from 'pg';

// pg's default parser turns `date` columns into JS Date objects (UTC
// midnight), which then serialize through res.json() as full ISO
// timestamps ("2026-09-12T00:00:00.000Z") instead of the plain "YYYY-MM-DD"
// the frontend and the <input type="date"> elements expect. Keep it a
// string; nothing server-side does date arithmetic on planned_date.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

let pool;

export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
