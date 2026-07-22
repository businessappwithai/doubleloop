/**
 * Internal schema representation (IR) that every translator target
 * (DBML, Postgres DDL, live-DB diff, Liam schema.json) is derived from.
 *
 * Built once by emlParser.ts from an EML (.eml.mmd) document's `erDiagram`
 * section plus its `%%enum` / `%%field` / `%%index` / `%%entity` directives.
 */

import type { CanonicalType, CardinalityKind } from "@dlo/language";

export interface FieldModel {
  name: string;
  rawType: string;
  canonicalType: CanonicalType;
  maxLength?: number;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isUnique: boolean;
  isOptional: boolean;
  /** Name of a %%enum this field's values are constrained to, if any. */
  enumRef?: string;
  comment?: string;
}

export interface IndexModel {
  columns: string[];
  unique: boolean;
}

/** A resolved foreign key: this entity's field references another entity's PK. */
export interface ForeignKeyModel {
  field: string;
  targetEntity: string;
  targetField: string;
  relationshipLabel?: string;
  cardinality?: CardinalityKind;
}

export interface EntityModel {
  name: string;
  tableName: string;
  fields: FieldModel[];
  indexes: IndexModel[];
  foreignKeys: ForeignKeyModel[];
  audited?: boolean;
  prefix?: string;
  softDelete?: boolean;
  comment?: string;
}

export interface EnumModel {
  name: string;
  values: string[];
}

export interface RelationshipModel {
  left: string;
  right: string;
  operator: string;
  kind: CardinalityKind | null;
  label?: string;
}

export interface SchemaModel {
  name?: string;
  version?: string;
  entities: EntityModel[];
  enums: EnumModel[];
  relationships: RelationshipModel[];
}

export interface ParseWarning {
  message: string;
  entity?: string;
  field?: string;
}

export interface ParseResult {
  schema: SchemaModel;
  warnings: ParseWarning[];
  sourcePath?: string;
}

/** snake_case a PascalCase/camelCase/ALL_CAPS identifier, per the EML table-name derivation rule. */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Table name for an entity, per the EML tableNameDerivation rule:
 * PascalCase/camelCase -> snake_case; ALL_CAPS/snake stays lower-case.
 * An optional %%entity prefix (bus/sys/...) is prepended.
 */
export function entityTableName(entityName: string, prefix?: string): string {
  const base = toSnakeCase(entityName);
  return prefix ? `${prefix}_${base}` : base;
}
