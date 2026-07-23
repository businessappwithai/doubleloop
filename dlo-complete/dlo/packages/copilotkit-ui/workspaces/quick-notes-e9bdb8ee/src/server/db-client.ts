import { Pool } from 'pg';
import { getConfig } from './config';

let poolInstance: Pool | null | undefined;

export function getPool(): Pool | null {
  if (poolInstance !== undefined) {
    return poolInstance;
  }

  const config = getConfig();
  if (!config.databaseUrl) {
    poolInstance = null;
    return null;
  }

  poolInstance = new Pool({ connectionString: config.databaseUrl });
  return poolInstance;
}

export async function ensureSchema(pool: Pool): Promise<void> {
  const queries = [
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    `CREATE TABLE IF NOT EXISTS notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(200) NOT NULL,
      body text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );`,
    'CREATE INDEX IF NOT EXISTS notes_updated_at_idx ON notes (updated_at DESC);',
  ];

  for (const query of queries) {
    await pool.query(query);
  }
}
