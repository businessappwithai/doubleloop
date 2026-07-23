/**
 * SchemaModel -> PostgreSQL DDL. Targets the per-pipeline runtime database
 * that DB_PROVISIONING_RUNNING stands up (postgres:17-alpine, see
 * packages/copilotkit-ui/src/lib/pipeline-helper.ts::runDbProvisioningBackground).
 *
 * Enum fields are enforced with a named CHECK constraint rather than a
 * native `CREATE TYPE ... AS ENUM`, so adding/removing allowed values later
 * is a plain DROP/ADD CONSTRAINT (diff.ts) instead of the append-only,
 * transaction-hostile ALTER TYPE ... ADD VALUE path.
 */

import type { EntityModel, FieldModel, SchemaModel } from "./model.js";

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const CANONICAL_TO_PG: Record<string, string> = {
  string: "varchar",
  text: "text",
  integer: "integer",
  decimal: "numeric(18,4)",
  boolean: "boolean",
  date: "date",
  datetime: "timestamptz",
  json: "jsonb",
};

export function pgColumnType(field: Pick<FieldModel, "canonicalType" | "maxLength">): string {
  if (field.canonicalType === "string") {
    return `varchar(${field.maxLength ?? 255})`;
  }
  return CANONICAL_TO_PG[field.canonicalType] ?? "text";
}

export function pkConstraintName(entity: EntityModel): string {
  return `pk_${entity.tableName}`;
}

export function fkConstraintName(entity: EntityModel, field: string): string {
  return `fk_${entity.tableName}_${field}`;
}

export function enumCheckConstraintName(entity: EntityModel, field: string): string {
  return `chk_${entity.tableName}_${field}_enum`;
}

export function indexName(entity: EntityModel, columns: string[]): string {
  return `idx_${entity.tableName}_${columns.join("_")}`;
}

function columnDefLine(field: FieldModel): string {
  const parts = [quoteIdent(field.name), pgColumnType(field)];
  if (!field.isOptional) parts.push("NOT NULL");
  return `  ${parts.join(" ")}`;
}

export function createTableStatement(entity: EntityModel): string {
  const lines = entity.fields.map(columnDefLine);
  const pkFields = entity.fields.filter((f) => f.isPrimaryKey).map((f) => f.name);
  if (pkFields.length > 0) {
    lines.push(`  CONSTRAINT ${quoteIdent(pkConstraintName(entity))} PRIMARY KEY (${pkFields.map(quoteIdent).join(", ")})`);
  }
  for (const field of entity.fields) {
    if (field.isUnique && !field.isPrimaryKey) {
      lines.push(`  CONSTRAINT ${quoteIdent(`uk_${entity.tableName}_${field.name}`)} UNIQUE (${quoteIdent(field.name)})`);
    }
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(entity.tableName)} (\n${lines.join(",\n")}\n);`;
}

export function createTableStatements(schema: SchemaModel): string[] {
  return schema.entities.map((e) => createTableStatement(e));
}

export function foreignKeyStatement(schema: SchemaModel, entity: EntityModel, fieldName: string): string | null {
  const fk = entity.foreignKeys.find((f) => f.field === fieldName);
  if (!fk) return null;
  const target = schema.entities.find((e) => e.name === fk.targetEntity);
  if (!target) return null;
  return (
    `ALTER TABLE ${quoteIdent(entity.tableName)} ` +
    `ADD CONSTRAINT ${quoteIdent(fkConstraintName(entity, fieldName))} ` +
    `FOREIGN KEY (${quoteIdent(fieldName)}) REFERENCES ${quoteIdent(target.tableName)} (${quoteIdent(fk.targetField)}) ` +
    `ON UPDATE NO ACTION ON DELETE NO ACTION;`
  );
}

export function foreignKeyStatements(schema: SchemaModel): string[] {
  const out: string[] = [];
  for (const entity of schema.entities) {
    for (const fk of entity.foreignKeys) {
      const stmt = foreignKeyStatement(schema, entity, fk.field);
      if (stmt) out.push(stmt);
    }
  }
  return out;
}

export function enumCheckStatement(entity: EntityModel, field: FieldModel, schema: SchemaModel): string | null {
  if (!field.enumRef) return null;
  const en = schema.enums.find((e) => e.name === field.enumRef);
  if (!en || en.values.length === 0) return null;
  const list = en.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return (
    `ALTER TABLE ${quoteIdent(entity.tableName)} ` +
    `ADD CONSTRAINT ${quoteIdent(enumCheckConstraintName(entity, field.name))} ` +
    `CHECK (${quoteIdent(field.name)} IN (${list}));`
  );
}

export function enumCheckStatements(schema: SchemaModel): string[] {
  const out: string[] = [];
  for (const entity of schema.entities) {
    for (const field of entity.fields) {
      const stmt = enumCheckStatement(entity, field, schema);
      if (stmt) out.push(stmt);
    }
  }
  return out;
}

export function indexStatements(schema: SchemaModel): string[] {
  const out: string[] = [];
  for (const entity of schema.entities) {
    for (const idx of entity.indexes) {
      // Skip if it duplicates the single-column PK/UNIQUE already enforced inline.
      if (idx.columns.length === 1) {
        const f = entity.fields.find((x) => x.name === idx.columns[0]);
        if (f?.isPrimaryKey || (f?.isUnique && idx.unique)) continue;
      }
      const cols = idx.columns.map(quoteIdent).join(", ");
      out.push(
        `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(indexName(entity, idx.columns))} ` +
          `ON ${quoteIdent(entity.tableName)} (${cols});`,
      );
    }
  }
  return out;
}

/** Full from-scratch creation script, correctly ordered: tables, then FKs, checks, indexes. */
export function fullCreateScript(schema: SchemaModel): string[] {
  return [
    ...createTableStatements(schema),
    ...foreignKeyStatements(schema),
    ...enumCheckStatements(schema),
    ...indexStatements(schema),
  ];
}
