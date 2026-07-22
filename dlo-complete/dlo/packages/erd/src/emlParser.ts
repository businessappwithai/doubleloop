/**
 * Parses the ERD section (plus %%enum / %%field / %%index / %%entity
 * directives) of an EML (.eml.mmd) document into a SchemaModel.
 *
 * Only the `erd` conformance level is consumed here — business-rules
 * flowcharts and workflow diagrams elsewhere in the same document are
 * ignored, since this translator's job is "view/apply entity relationships",
 * not the JDM/workflow pipeline.
 */

import { cardinalityKind, normalizeType, type CardinalityKind } from "@dlo/language";
import {
  entityTableName,
  toSnakeCase,
  type EntityModel,
  type EnumModel,
  type FieldModel,
  type ForeignKeyModel,
  type ParseResult,
  type ParseWarning,
  type RelationshipModel,
  type SchemaModel,
} from "./model.js";

const DIAGRAM_KEYWORDS = ["flowchart", "graph", "stateDiagram-v2", "stateDiagram"];

interface EntityMeta {
  audited?: boolean;
  prefix?: string;
  softDelete?: boolean;
}

function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, "").trim();
}

/** Extracts every `erDiagram ... ` block's line range from the document. */
function findErdBlocks(lines: string[]): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "erDiagram") continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trim();
      if (DIAGRAM_KEYWORDS.some((kw) => t === kw || t.startsWith(`${kw} `))) {
        end = j;
        break;
      }
    }
    blocks.push({ start: i + 1, end });
  }
  return blocks;
}

function parseAttributeLine(
  line: string,
): { type: string; maxLength?: number; name: string; modifiers: string[]; comment?: string } | null {
  let rest = line.trim();
  if (!rest) return null;

  let comment: string | undefined;
  const commentMatch = rest.match(/"([^"]*)"\s*$/);
  if (commentMatch) {
    comment = commentMatch[1];
    rest = rest.slice(0, commentMatch.index).trim();
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const typeToken = tokens[0]!;
  const typeMatch = typeToken.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((\d+)\))?$/);
  const type = typeMatch ? typeMatch[1]! : typeToken;
  const maxLength = typeMatch?.[2] ? parseInt(typeMatch[2], 10) : undefined;
  const name = tokens[1]!;
  const modifiers = tokens.slice(2).map((t) => t.toUpperCase());

  return {
    type,
    name,
    modifiers,
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

const RELATIONSHIP_RE =
  /^(\w+)\s+([|o}{><][o|][-]{2}[o|][|o}{><])\s+(\w+)\s*(?::\s*"?([^"]*?)"?\s*)?$/;

function parseRelationshipLine(
  line: string,
): { left: string; operator: string; right: string; label?: string } | null {
  const m = line.trim().match(RELATIONSHIP_RE);
  if (!m) return null;
  const result: { left: string; operator: string; right: string; label?: string } = {
    left: m[1]!,
    operator: m[2]!,
    right: m[3]!,
  };
  if (m[4] !== undefined && m[4] !== "") result.label = stripQuotes(m[4]);
  return result;
}

/** `%%enum Name: v1, v2, v3` */
const ENUM_DIRECTIVE_RE = /^%%enum\s+(\w+)\s*:\s*(.+)$/;
/** `%%field Entity.field enum: EnumName` (only the enum-ref form is applied here) */
const FIELD_ENUM_DIRECTIVE_RE = /^%%field\s+(\w+)\.(\w+)\s+enum\s*:\s*(\w+)/;
/** `%%index Entity(col1, col2) unique?` */
const INDEX_DIRECTIVE_RE = /^%%index\s+(\w+)\(([^)]+)\)\s*(unique)?/i;
/** `%%entity Entity key: value key2: value2 ...` */
const ENTITY_DIRECTIVE_RE = /^%%entity\s+(\w+)\s+(.+)$/;
/** `%%meta key: value` */
const META_DIRECTIVE_RE = /^%%meta\s+(\w+)\s*:\s*(.+)$/;

function parseEntityMetaPairs(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*:\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

export function parseEmlSource(source: string, sourcePath?: string): ParseResult {
  const lines = source.split(/\r?\n/);
  const warnings: ParseWarning[] = [];

  const enums = new Map<string, EnumModel>();
  const fieldEnumRefs = new Map<string, string>(); // "Entity.field" -> enumName
  const indexDirectives = new Map<string, Array<{ columns: string[]; unique: boolean }>>();
  const entityMeta = new Map<string, EntityMeta>();
  let schemaName: string | undefined;
  let schemaVersion: string | undefined;

  // Only the %%meta block preceding the FIRST diagram (the erd section, by
  // EML convention) sets the document-level name/version — later %%meta
  // blocks belong to rules/workflow sections and must not overwrite it.
  const firstDiagramIdx = lines.findIndex((l) => {
    const t = l.trim();
    return t === "erDiagram" || DIAGRAM_KEYWORDS.some((kw) => t === kw || t.startsWith(`${kw} `));
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith("%%")) continue;

    let m = line.match(ENUM_DIRECTIVE_RE);
    if (m) {
      const name = m[1]!;
      const values = m[2]!.split(",").map((v) => v.trim()).filter(Boolean);
      enums.set(name, { name, values });
      continue;
    }

    m = line.match(FIELD_ENUM_DIRECTIVE_RE);
    if (m) {
      fieldEnumRefs.set(`${m[1]}.${m[2]}`, m[3]!);
      continue;
    }

    m = line.match(INDEX_DIRECTIVE_RE);
    if (m) {
      const entity = m[1]!;
      const columns = m[2]!.split(",").map((c) => c.trim()).filter(Boolean);
      const unique = !!m[3];
      const arr = indexDirectives.get(entity) ?? [];
      arr.push({ columns, unique });
      indexDirectives.set(entity, arr);
      continue;
    }

    m = line.match(ENTITY_DIRECTIVE_RE);
    if (m) {
      const entity = m[1]!;
      const pairs = parseEntityMetaPairs(m[2]!);
      const meta: EntityMeta = entityMeta.get(entity) ?? {};
      if (pairs.audited !== undefined) meta.audited = pairs.audited === "true";
      if (pairs.prefix !== undefined) meta.prefix = pairs.prefix;
      if (pairs.softDelete !== undefined) meta.softDelete = pairs.softDelete === "true";
      entityMeta.set(entity, meta);
      continue;
    }

    m = line.match(META_DIRECTIVE_RE);
    if (m && (firstDiagramIdx === -1 || i < firstDiagramIdx)) {
      const key = m[1]!;
      const value = m[2]!.trim();
      if (key === "name") schemaName = value;
      if (key === "version") schemaVersion = value;
      continue;
    }
  }

  const blocks = findErdBlocks(lines);
  if (blocks.length === 0) {
    warnings.push({ message: "No `erDiagram` section found in the EML document." });
    return {
      schema: {
        ...(schemaName !== undefined ? { name: schemaName } : {}),
        ...(schemaVersion !== undefined ? { version: schemaVersion } : {}),
        entities: [],
        enums: [...enums.values()],
        relationships: [],
      },
      warnings,
      ...(sourcePath !== undefined ? { sourcePath } : {}),
    };
  }

  const entities: EntityModel[] = [];
  const entityByName = new Map<string, EntityModel>();
  const relationships: RelationshipModel[] = [];

  for (const block of blocks) {
    let current: EntityModel | null = null;

    for (let i = block.start; i < block.end; i++) {
      const raw = lines[i]!;
      const line = raw.trim();
      if (!line || line.startsWith("%%")) continue;

      if (current === null) {
        const openMatch = line.match(/^(\w+)\s*\{$/);
        if (openMatch) {
          const name = openMatch[1]!;
          if (entityByName.has(name)) {
            current = entityByName.get(name)!;
          } else {
            const meta = entityMeta.get(name);
            current = {
              name,
              tableName: entityTableName(name, meta?.prefix),
              fields: [],
              indexes: [],
              foreignKeys: [],
              ...(meta?.audited !== undefined ? { audited: meta.audited } : {}),
              ...(meta?.prefix !== undefined ? { prefix: meta.prefix } : {}),
              ...(meta?.softDelete !== undefined ? { softDelete: meta.softDelete } : {}),
            };
            entities.push(current);
            entityByName.set(name, current);
          }
          continue;
        }

        const rel = parseRelationshipLine(line);
        if (rel) {
          const kind = cardinalityKind(rel.operator);
          if (!kind) {
            warnings.push({ message: `Unrecognized relationship operator "${rel.operator}" between ${rel.left} and ${rel.right}; skipping FK inference for this line.` });
          }
          const relModel: RelationshipModel = { left: rel.left, right: rel.right, operator: rel.operator, kind };
          if (rel.label !== undefined) relModel.label = rel.label;
          relationships.push(relModel);
          continue;
        }

        warnings.push({ message: `Could not parse ERD line: "${line}"` });
        continue;
      }

      if (line === "}") {
        current = null;
        continue;
      }

      const attr = parseAttributeLine(line);
      if (!attr) {
        warnings.push({ message: `Could not parse attribute line: "${line}"`, entity: current.name });
        continue;
      }

      const canonicalType = normalizeType(attr.type);
      const mods = new Set(attr.modifiers);
      const field: FieldModel = {
        name: attr.name,
        rawType: attr.type,
        canonicalType,
        isPrimaryKey: mods.has("PK"),
        isForeignKey: mods.has("FK"),
        isUnique: mods.has("PK") || mods.has("UK") || mods.has("UNIQUE"),
        isOptional: (mods.has("OPTIONAL") || mods.has("NULL")) && !mods.has("PK"),
      };
      if (attr.maxLength !== undefined) field.maxLength = attr.maxLength;
      if (attr.comment !== undefined) field.comment = attr.comment;
      const enumRef = fieldEnumRefs.get(`${current.name}.${attr.name}`);
      if (enumRef) {
        if (enums.has(enumRef)) {
          field.enumRef = enumRef;
        } else {
          warnings.push({ message: `%%field references undeclared enum "${enumRef}"`, entity: current.name, field: attr.name });
        }
      }
      current.fields.push(field);
    }
  }

  // Auto-add a synthetic `id PK` when an entity declares none (generator default).
  for (const entity of entities) {
    if (!entity.fields.some((f) => f.isPrimaryKey)) {
      entity.fields.unshift({
        name: "id",
        rawType: "string",
        canonicalType: "string",
        isPrimaryKey: true,
        isForeignKey: false,
        isUnique: true,
        isOptional: false,
      });
      warnings.push({ message: "No primary key declared; auto-added `id PK`.", entity: entity.name });
    }
  }

  // Apply %%index directives.
  for (const entity of entities) {
    for (const idx of indexDirectives.get(entity.name) ?? []) {
      const missing = idx.columns.filter((c) => !entity.fields.some((f) => f.name === c));
      if (missing.length > 0) {
        warnings.push({ message: `%%index references unknown column(s): ${missing.join(", ")}`, entity: entity.name });
        continue;
      }
      entity.indexes.push({ columns: idx.columns, unique: idx.unique });
    }
  }

  resolveForeignKeys(entities, entityByName, relationships, warnings);

  const schema: SchemaModel = {
    entities,
    enums: [...enums.values()],
    relationships,
  };
  if (schemaName !== undefined) schema.name = schemaName;
  if (schemaVersion !== undefined) schema.version = schemaVersion;

  return { schema, warnings, ...(sourcePath !== undefined ? { sourcePath } : {}) };
}

/** Which side of a cardinality kind owns the FK column, given (left, right) entity names. */
function fkOwnerAndTarget(
  kind: CardinalityKind,
  left: string,
  right: string,
): { owner: string; target: string } | null {
  switch (kind) {
    case "oneToMany":
      return { owner: right, target: left };
    case "manyToOne":
      return { owner: left, target: right };
    case "oneToOne":
      // Ambiguous by cardinality alone; caller resolves by field-name convention, defaulting to `right`.
      return { owner: right, target: left };
    case "manyToMany":
      return null;
  }
}

function pkFieldName(entity: EntityModel | undefined): string {
  const pk = entity?.fields.find((f) => f.isPrimaryKey);
  return pk?.name ?? "id";
}

function resolveForeignKeys(
  entities: EntityModel[],
  entityByName: Map<string, EntityModel>,
  relationships: RelationshipModel[],
  warnings: ParseWarning[],
): void {
  const fkQueues = new Map<string, string[]>();
  for (const entity of entities) {
    fkQueues.set(
      entity.name,
      entity.fields.filter((f) => f.isForeignKey).map((f) => f.name),
    );
  }

  const manyToManyPairs: Array<{ left: string; right: string; label?: string }> = [];

  for (const rel of relationships) {
    if (!entityByName.has(rel.left) || !entityByName.has(rel.right)) {
      warnings.push({ message: `Relationship references undeclared entity: ${rel.left} <-> ${rel.right}` });
      continue;
    }
    if (!rel.kind) continue;

    if (rel.kind === "manyToMany") {
      const pair: { left: string; right: string; label?: string } = { left: rel.left, right: rel.right };
      if (rel.label !== undefined) pair.label = rel.label;
      manyToManyPairs.push(pair);
      continue;
    }

    const resolved = fkOwnerAndTarget(rel.kind, rel.left, rel.right);
    if (!resolved) continue;
    const { owner, target } = resolved;

    const queue = fkQueues.get(owner) ?? [];
    const expectedName = `${toSnakeCase(target)}_id`;
    let idx = queue.findIndex((f) => f.toLowerCase() === expectedName);
    if (idx === -1) idx = 0;
    const fieldName = queue.length > 0 ? queue.splice(idx, 1)[0] : undefined;

    if (!fieldName) {
      warnings.push({
        message: `Relationship ${rel.left} ${rel.operator} ${rel.right} implies a foreign key on "${owner}" but no unassigned FK-tagged column was found; no constraint was generated for this relationship.`,
      });
      continue;
    }

    const ownerEntity = entityByName.get(owner)!;
    const fk: ForeignKeyModel = {
      field: fieldName,
      targetEntity: target,
      targetField: pkFieldName(entityByName.get(target)),
    };
    if (rel.label !== undefined) fk.relationshipLabel = rel.label;
    if (rel.kind !== null) fk.cardinality = rel.kind;
    ownerEntity.foreignKeys.push(fk);
  }

  // Leftover FK-tagged fields: try to resolve by naming convention against a declared entity.
  for (const entity of entities) {
    const leftover = fkQueues.get(entity.name) ?? [];
    for (const fieldName of leftover) {
      const stem = fieldName.replace(/_id$/i, "");
      const target = entities.find((e) => toSnakeCase(e.name) === stem.toLowerCase());
      if (target) {
        entity.foreignKeys.push({
          field: fieldName,
          targetEntity: target.name,
          targetField: pkFieldName(target),
        });
      } else {
        warnings.push({
          message: `Foreign-key column "${fieldName}" could not be resolved to a declared entity by name or by relationship; no constraint was generated.`,
          entity: entity.name,
          field: fieldName,
        });
      }
    }
  }

  // Implicit join tables for many-to-many relationships not already modeled by an explicit entity.
  for (const pair of manyToManyPairs) {
    const leftEntity = entityByName.get(pair.left)!;
    const rightEntity = entityByName.get(pair.right)!;
    const alreadyModeled = entities.some(
      (e) =>
        e.foreignKeys.some((fk) => fk.targetEntity === pair.left) &&
        e.foreignKeys.some((fk) => fk.targetEntity === pair.right),
    );
    if (alreadyModeled) continue;

    const joinName = `${pair.left}${pair.right}Link`;
    if (entityByName.has(joinName)) continue;

    const leftField = `${toSnakeCase(pair.left)}_id`;
    const rightField = `${toSnakeCase(pair.right)}_id`;
    const joinEntity: EntityModel = {
      name: joinName,
      tableName: entityTableName(joinName),
      fields: [
        { name: leftField, rawType: "string", canonicalType: "string", isPrimaryKey: true, isForeignKey: true, isUnique: false, isOptional: false },
        { name: rightField, rawType: "string", canonicalType: "string", isPrimaryKey: true, isForeignKey: true, isUnique: false, isOptional: false },
      ],
      indexes: [],
      foreignKeys: [
        { field: leftField, targetEntity: pair.left, targetField: pkFieldName(leftEntity) },
        { field: rightField, targetEntity: pair.right, targetField: pkFieldName(rightEntity) },
      ],
      comment: `Implicit join table for the many-to-many relationship between ${pair.left} and ${pair.right}.`,
    };
    entities.push(joinEntity);
    entityByName.set(joinName, joinEntity);
    warnings.push({ message: `Synthesized implicit join table "${joinEntity.tableName}" for many-to-many relationship ${pair.left} <-> ${pair.right}.` });
  }
}
