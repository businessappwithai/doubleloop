import mariadb, { Pool, Connection } from "mariadb";

let pool: Pool | null = null;

export async function initDB(): Promise<void> {
  const config = {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "dlo",
    password: process.env.DB_PASSWORD || "dlopassword",
    database: process.env.DB_NAME || "dlo_pipelines",
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 10,
  };

  pool = mariadb.createPool(config);
  console.log(`[DB] Connected to ${config.host}:${config.port}/${config.database}`);
}

export async function getConnection(): Promise<Connection> {
  if (!pool) throw new Error("Database not initialized");
  return pool.getConnection();
}

export async function closeDB(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[DB] Connection pool closed");
  }
}

export async function query(sql: string, params: any[] = []): Promise<any[]> {
  const conn = await getConnection();
  try {
    return await conn.query(sql, params);
  } finally {
    await conn.end();
  }
}

export async function queryOne(sql: string, params: any[] = []): Promise<any> {
  const results = await query(sql, params);
  return results.length > 0 ? results[0] : null;
}

export async function execute(sql: string, params: any[] = []): Promise<any> {
  const conn = await getConnection();
  try {
    return await conn.execute(sql, params);
  } finally {
    await conn.end();
  }
}

export async function transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.end();
  }
}
