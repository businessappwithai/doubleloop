/**
 * Diffs an EML-derived SchemaModel against a live Postgres database
 * (introspectPostgres.ts) and produces the DDL needed to reconcile them.
 *
 * Additive, safe changes (new table/column/FK/check/index, relaxing a
 * NOT NULL) are returned in `statements` and are safe to auto-apply.
 * Anything that could lose data or fail on existing rows (dropped
 * table/column, a column type change, tightening to NOT NULL, adding a
 * UNIQUE/PK constraint after the fact) is returned separately in
 * `destructive` and must be explicitly confirmed before running.
 */

import type { EntityModel, SchemaModel } from "./model.js";
import type { LiveSchemaInfo, LiveTableInfo } from "./introspectPostgres.js";
import {
  createTableStatement,
  enumCheckConstraintName,
  enumCheckStatement,
  fkConstraintName,
  foreignKeyStatement,
  indexName,
  pgColumnType,
  pkConstraintName,
  quoteIdent,
} from "./postgresDdl.js";

export interface DiffStatement {
  sql: string;
  description: string;
  destructive: boolean;
  reason?: string;
}

export interface DiffResult {
  statements: DiffStatement[];
  destructive: DiffStatement[];
  warnings: string[];
}

const EXPECTED_DATA_TYPE: Record<string, string> = {
  string: "character varying",
  text: "text",
  integer: "integer",
  decimal: "numeric",
  boolean: "boolean",
  date: "date",
  datetime: "timestamp with time zone",
  json: "jsonb",
};

export function computeDiff(schema: SchemaModel, live: LiveSchemaInfo): DiffResult {
  const statements: DiffStatement[] = [];
  const destructive: DiffStatement[] = [];
  const warnings: string[] = [];
  const constraintStatements: DiffStatement[] = [];

  for (const entity of schema.entities) {
    const liveTable = live.tables.get(entity.tableName);

    if (!liveTable) {
      statements.push({
        sql: createTableStatement(entity),
        description: `Create table "${entity.tableName}"`,
        destructive: false,
      });
      queueConstraintsAndIndexes(schema, entity, undefined, constraintStatements, warnings);
      continue;
    }

    for (const field of entity.fields) {
      const liveCol = liveTable.columns.get(field.name);
      if (!liveCol) {
        statements.push({
          sql: `ALTER TABLE ${quoteIdent(entity.tableName)} ADD COLUMN ${quoteIdent(field.name)} ${pgColumnType(field)};`,
          description: `Add column "${entity.tableName}.${field.name}"`,
          destructive: false,
        });
        continue;
      }

      const expectedType = EXPECTED_DATA_TYPE[field.canonicalType] ?? "text";
      const lengthOk = field.canonicalType !== "string" || liveCol.characterMaxLength === (field.maxLength ?? 255);
      if (liveCol.dataType !== expectedType || !lengthOk) {
        destructive.push({
          sql: `ALTER TABLE ${quoteIdent(entity.tableName)} ALTER COLUMN ${quoteIdent(field.name)} TYPE ${pgColumnType(field)} USING ${quoteIdent(field.name)}::${pgColumnType(field)};`,
          description: `Change type of "${entity.tableName}.${field.name}" (${liveCol.dataType} -> ${pgColumnType(field)})`,
          destructive: true,
          reason: "A column type change can fail or truncate/convert existing data.",
        });
      }

      if (liveCol.nullable && !field.isOptional) {
        destructive.push({
          sql: `ALTER TABLE ${quoteIdent(entity.tableName)} ALTER COLUMN ${quoteIdent(field.name)} SET NOT NULL;`,
          description: `Require "${entity.tableName}.${field.name}" (currently nullable)`,
          destructive: true,
          reason: "Fails if any existing row has NULL in this column.",
        });
      } else if (!liveCol.nullable && field.isOptional) {
        statements.push({
          sql: `ALTER TABLE ${quoteIdent(entity.tableName)} ALTER COLUMN ${quoteIdent(field.name)} DROP NOT NULL;`,
          description: `Relax "${entity.tableName}.${field.name}" to optional`,
          destructive: false,
        });
      }
    }

    if (!liveTable.constraintNames.has(pkConstraintName(entity))) {
      const pkFields = entity.fields.filter((f) => f.isPrimaryKey).map((f) => f.name);
      if (pkFields.length > 0) {
        warnings.push(
          `Table "${entity.tableName}" is missing its expected primary key constraint (${pkConstraintName(entity)}); add it manually after verifying there are no duplicate/NULL values.`,
        );
      }
    }
    for (const field of entity.fields) {
      if (field.isUnique && !field.isPrimaryKey) {
        const ukName = `uk_${entity.tableName}_${field.name}`;
        if (!liveTable.constraintNames.has(ukName)) {
          destructive.push({
            sql: `ALTER TABLE ${quoteIdent(entity.tableName)} ADD CONSTRAINT ${quoteIdent(ukName)} UNIQUE (${quoteIdent(field.name)});`,
            description: `Add UNIQUE constraint on "${entity.tableName}.${field.name}"`,
            destructive: true,
            reason: "Fails if existing rows already contain duplicate values.",
          });
        }
      }
    }

    queueConstraintsAndIndexes(schema, entity, liveTable, constraintStatements, warnings);
  }

  for (const [tableName, liveTable] of live.tables) {
    const entity = schema.entities.find((e) => e.tableName === tableName);
    if (!entity) {
      destructive.push({
        sql: `DROP TABLE IF EXISTS ${quoteIdent(tableName)};`,
        description: `Drop table "${tableName}" (no longer declared in the ERD)`,
        destructive: true,
        reason: "Permanently deletes the table and all its data.",
      });
      continue;
    }
    for (const colName of liveTable.columns.keys()) {
      if (!entity.fields.some((f) => f.name === colName)) {
        destructive.push({
          sql: `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN IF EXISTS ${quoteIdent(colName)};`,
          description: `Drop column "${tableName}.${colName}" (no longer declared in the ERD)`,
          destructive: true,
          reason: "Permanently deletes this column's data.",
        });
      }
    }
  }

  return { statements: [...statements, ...constraintStatements], destructive, warnings };
}

function queueConstraintsAndIndexes(
  schema: SchemaModel,
  entity: EntityModel,
  liveTable: LiveTableInfo | undefined,
  out: DiffStatement[],
  warnings: string[],
): void {
  for (const fk of entity.foreignKeys) {
    const name = fkConstraintName(entity, fk.field);
    if (liveTable?.constraintNames.has(name)) continue;
    const stmt = foreignKeyStatement(schema, entity, fk.field);
    if (!stmt) {
      warnings.push(`Could not build FK statement for "${entity.tableName}.${fk.field}" -> "${fk.targetEntity}" (target table missing from schema).`);
      continue;
    }
    out.push({
      sql: stmt,
      description: `Add foreign key "${entity.tableName}.${fk.field}" -> "${fk.targetEntity}"`,
      destructive: false,
    });
  }

  for (const field of entity.fields) {
    if (!field.enumRef) continue;
    const name = enumCheckConstraintName(entity, field.name);
    if (liveTable?.constraintNames.has(name)) continue;
    const stmt = enumCheckStatement(entity, field, schema);
    if (stmt) {
      out.push({
        sql: stmt,
        description: `Add enum check on "${entity.tableName}.${field.name}" (${field.enumRef})`,
        destructive: false,
      });
    }
  }

  for (const idx of entity.indexes) {
    const name = indexName(entity, idx.columns);
    if (liveTable?.indexNames.has(name)) continue;
    const cols = idx.columns.map(quoteIdent).join(", ");
    out.push({
      sql: `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(entity.tableName)} (${cols});`,
      description: `Add index on "${entity.tableName}" (${idx.columns.join(", ")})`,
      destructive: false,
    });
  }
}
