/**
 * Reads the live shape of the `public` schema of a running Postgres database
 * (the per-pipeline runtime DB provisioned in DB_PROVISIONING_RUNNING) so
 * diff.ts can compute what's missing/changed relative to the EML-derived
 * SchemaModel.
 *
 * Deliberately narrow: it only tracks objects that follow @dlo/erd's own
 * naming convention (pk_/uk_/fk_/chk_/idx_ — see postgresDdl.ts), so it
 * never treats hand-written schema objects outside that convention as drift.
 */

import pg from "pg";

export interface LiveColumnInfo {
  dataType: string;
  characterMaxLength: number | null;
  nullable: boolean;
}

export interface LiveTableInfo {
  tableName: string;
  columns: Map<string, LiveColumnInfo>;
  constraintNames: Set<string>;
  indexNames: Set<string>;
}

export interface LiveSchemaInfo {
  tables: Map<string, LiveTableInfo>;
}

export async function introspectLiveSchema(connectionString: string): Promise<LiveSchemaInfo> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const tables: Map<string, LiveTableInfo> = new Map();

    const tableRows = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    for (const row of tableRows.rows) {
      tables.set(row.table_name, {
        tableName: row.table_name,
        columns: new Map(),
        constraintNames: new Set(),
        indexNames: new Set(),
      });
    }

    const columnRows = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: "YES" | "NO";
    }>(
      `SELECT table_name, column_name, data_type, character_maximum_length, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    for (const row of columnRows.rows) {
      const table = tables.get(row.table_name);
      if (!table) continue;
      table.columns.set(row.column_name, {
        dataType: row.data_type,
        characterMaxLength: row.character_maximum_length,
        nullable: row.is_nullable === "YES",
      });
    }

    const constraintRows = await client.query<{ table_name: string; constraint_name: string }>(
      `SELECT tc.table_name, tc.constraint_name
       FROM information_schema.table_constraints tc
       WHERE tc.table_schema = 'public'`,
    );
    for (const row of constraintRows.rows) {
      const table = tables.get(row.table_name);
      if (!table) continue;
      table.constraintNames.add(row.constraint_name);
    }

    const indexRows = await client.query<{ tablename: string; indexname: string }>(
      `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    for (const row of indexRows.rows) {
      const table = tables.get(row.tablename);
      if (!table) continue;
      table.indexNames.add(row.indexname);
    }

    return { tables };
  } finally {
    await client.end();
  }
}

/** Runs an ordered list of DDL/DML statements against the target database, sequentially. */
export async function applyStatements(
  connectionString: string,
  statements: string[],
): Promise<{ applied: string[]; failedAt?: { statement: string; error: string } }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        applied.push(stmt);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { applied, failedAt: { statement: stmt, error } };
      }
    }
    return { applied };
  } finally {
    await client.end();
  }
}

export async function testConnection(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
