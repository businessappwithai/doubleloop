import pg from "pg";
import type { ExitClauseResult, SqlAssertionClause } from "@dlo/core";
import type { ClauseContext, ClauseEvaluator } from "../registry.js";

const { Client } = pg;

export class SqlAssertionClauseEvaluator implements ClauseEvaluator {
  readonly kind = "sqlAssertion";

  async evaluate(clause: SqlAssertionClause, ctx: ClauseContext): Promise<ExitClauseResult> {
    const start = Date.now();

    if (!ctx.pgConnection) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: "PostgreSQL connection context (ctx.pgConnection) is missing",
        durationMs: Date.now() - start,
      };
    }

    const { host, port, user, database } = ctx.pgConnection;

    const client = new Client({
      host,
      port,
      user,
      database,
      password: process.env.PGPASSWORD, // Use standard environment variables
    });

    try {
      await client.connect();

      // Ensure single statement and read-only query (check basic SQL keywords for safety)
      const sanitizedQuery = clause.query.trim().toLowerCase();
      if (
        sanitizedQuery.includes(";") &&
        sanitizedQuery.indexOf(";") !== sanitizedQuery.length - 1
      ) {
        return {
          clauseId: clause.clauseId,
          passed: false,
          observed: "SQL assertions must contain a single query statement",
          durationMs: Date.now() - start,
        };
      }

      const mutativeKeywords = ["insert", "update", "delete", "drop", "alter", "truncate", "create"];
      for (const kw of mutativeKeywords) {
        if (sanitizedQuery.startsWith(kw) || sanitizedQuery.includes(` ${kw} `)) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `SQL assertions must be read-only. Mutative keyword detected: '${kw}'`,
            durationMs: Date.now() - start,
          };
        }
      }

      const res = await client.query(clause.query);
      const rows = res.rows;
      const durationMs = Date.now() - start;

      // Assert rowCountAtLeast
      if (clause.expect.rowCountAtLeast !== undefined) {
        if (rows.length < clause.expect.rowCountAtLeast) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `Row count assertion failed: expected at least ${clause.expect.rowCountAtLeast}, got ${rows.length}`,
            durationMs,
          };
        }
      }

      // Assert singleValueEquals
      if (clause.expect.singleValueEquals !== undefined) {
        if (rows.length === 0) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `Single value assertion failed: query returned 0 rows, expected value '${clause.expect.singleValueEquals}'`,
            durationMs,
          };
        }

        const firstRow = rows[0]!;
        const firstKey = Object.keys(firstRow)[0];
        if (!firstKey) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `Single value assertion failed: first row is empty`,
            durationMs,
          };
        }

        const observedValue = String(firstRow[firstKey]);
        if (observedValue !== clause.expect.singleValueEquals) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `Single value assertion failed: expected '${clause.expect.singleValueEquals}', got '${observedValue}'`,
            durationMs,
          };
        }
      }

      return {
        clauseId: clause.clauseId,
        passed: true,
        observed: `SQL query returned ${rows.length} rows. First row: ${JSON.stringify(rows[0] || {})}`,
        durationMs,
      };

    } catch (e: any) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `SQL query execution failed: ${e.message}`,
        durationMs: Date.now() - start,
      };
    } finally {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }
}
