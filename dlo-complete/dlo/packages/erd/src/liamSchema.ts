/**
 * SchemaModel -> the JSON `Schema` shape consumed by Liam ERD
 * (https://github.com/liam-hq/liam, @liam-hq/schema `schemaSchema`,
 * `format: "liam"` input to `liam erd build`).
 *
 * Mirrors frontend/packages/schema/src/schema/schema.ts from the liam-hq/liam
 * repo: { tables: Record<name, Table>, enums: Record<name, Enum>, extensions }.
 * Liam derives the relationship diagram edges/cardinality itself from each
 * table's constraints (see its `constraintsToRelationships` utility) — we
 * only need to emit correct PK/FK/UNIQUE/CHECK constraints per table.
 */

import type { SchemaModel } from "./model.js";
import {
  enumCheckConstraintName,
  fkConstraintName,
  pgColumnType,
  pkConstraintName,
} from "./postgresDdl.js";

export interface LiamColumn {
  name: string;
  type: string;
  default: string | number | boolean | null;
  check: string | null;
  notNull: boolean;
  comment: string | null;
}

export interface LiamIndex {
  name: string;
  unique: boolean;
  columns: string[];
  type: string;
}

export type LiamConstraint =
  | { type: "PRIMARY KEY"; name: string; columnNames: string[] }
  | {
      type: "FOREIGN KEY";
      name: string;
      columnNames: string[];
      targetTableName: string;
      targetColumnNames: string[];
      updateConstraint: "NO_ACTION" | "CASCADE" | "RESTRICT" | "SET_NULL" | "SET_DEFAULT";
      deleteConstraint: "NO_ACTION" | "CASCADE" | "RESTRICT" | "SET_NULL" | "SET_DEFAULT";
    }
  | { type: "UNIQUE"; name: string; columnNames: string[] }
  | { type: "CHECK"; name: string; detail: string };

export interface LiamTable {
  name: string;
  columns: Record<string, LiamColumn>;
  comment: string | null;
  indexes: Record<string, LiamIndex>;
  constraints: Record<string, LiamConstraint>;
}

export interface LiamEnum {
  name: string;
  values: string[];
  comment: string | null;
}

export interface LiamSchema {
  tables: Record<string, LiamTable>;
  enums: Record<string, LiamEnum>;
  extensions: Record<string, { name: string }>;
}

export function toLiamSchema(schema: SchemaModel): LiamSchema {
  const tables: Record<string, LiamTable> = {};

  for (const entity of schema.entities) {
    const columns: Record<string, LiamColumn> = {};
    for (const field of entity.fields) {
      columns[field.name] = {
        name: field.name,
        type: pgColumnType(field),
        default: null,
        check: null,
        notNull: !field.isOptional,
        comment: field.comment ?? null,
      };
    }

    const indexes: Record<string, LiamIndex> = {};
    for (const idx of entity.indexes) {
      const name = `idx_${entity.tableName}_${idx.columns.join("_")}`;
      indexes[name] = { name, unique: idx.unique, columns: idx.columns, type: "btree" };
    }

    const constraints: Record<string, LiamConstraint> = {};
    const pkFields = entity.fields.filter((f) => f.isPrimaryKey).map((f) => f.name);
    if (pkFields.length > 0) {
      const name = pkConstraintName(entity);
      constraints[name] = { type: "PRIMARY KEY", name, columnNames: pkFields };
    }
    for (const field of entity.fields) {
      if (field.isUnique && !field.isPrimaryKey) {
        const name = `uk_${entity.tableName}_${field.name}`;
        constraints[name] = { type: "UNIQUE", name, columnNames: [field.name] };
      }
      if (field.enumRef) {
        const en = schema.enums.find((e) => e.name === field.enumRef);
        if (en) {
          const name = enumCheckConstraintName(entity, field.name);
          const list = en.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
          constraints[name] = { type: "CHECK", name, detail: `${field.name} IN (${list})` };
        }
      }
    }
    for (const fk of entity.foreignKeys) {
      const target = schema.entities.find((e) => e.name === fk.targetEntity);
      if (!target) continue;
      const name = fkConstraintName(entity, fk.field);
      constraints[name] = {
        type: "FOREIGN KEY",
        name,
        columnNames: [fk.field],
        targetTableName: target.tableName,
        targetColumnNames: [fk.targetField],
        updateConstraint: "NO_ACTION",
        deleteConstraint: "NO_ACTION",
      };
    }

    tables[entity.tableName] = {
      name: entity.tableName,
      columns,
      comment: entity.comment ?? null,
      indexes,
      constraints,
    };
  }

  const enums: Record<string, LiamEnum> = {};
  for (const en of schema.enums) {
    enums[en.name] = { name: en.name, values: en.values, comment: null };
  }

  return { tables, enums, extensions: {} };
}
