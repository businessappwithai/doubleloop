// scripts/emit-schema.ts — concatenates the root SDL document with every module SDL fragment
// into schema.graphql (Implementation.md m7). Split into pure functions
// (`extractTopLevelTypeNames`, `mergeSchemaDocuments`) that tests exercise against fixture
// documents — no real filesystem — and an I/O shell (`emitSchema`) that `main()` runs when this
// file is invoked directly, the same `node --experimental-strip-types` convention the `collab`
// npm script uses. A build-time tool, not application code: nothing under `src/` imports it.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kind, parse } from "graphql";
import type { DefinitionNode } from "graphql";
import { ConfigError } from "../src/core/errors";

export interface SchemaDocument {
  readonly path: string;
  readonly sdl: string;
}

/**
 * Returns the names introduced by non-extension type/interface/union/enum/scalar/input
 * definitions in `sdl`. An `extend type X { ... }` deliberately does not count — extending a
 * type defined in another document is how module fragments are meant to add fields to `Query`
 * and `Mutation` without redeclaring them.
 */
export function extractTopLevelTypeNames(sdl: string): readonly string[] {
  const document = parse(sdl);
  const names: string[] = [];
  for (const definition of document.definitions) {
    const name = definitionName(definition);
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
}

function definitionName(definition: DefinitionNode): string | null {
  switch (definition.kind) {
    case Kind.SCALAR_TYPE_DEFINITION:
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.ENUM_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      return definition.name.value;
    default:
      return null;
  }
}

/**
 * Concatenates `root` followed by `fragments` (sorted by `path` for deterministic output,
 * independent of directory-listing order) into one SDL string. Throws
 * `ConfigError('schema.duplicateTypeDefinition')` if two documents each define — not extend —
 * the same type name.
 */
export function mergeSchemaDocuments(root: SchemaDocument, fragments: readonly SchemaDocument[]): string {
  const ordered = [root, ...[...fragments].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))];

  const definedIn = new Map<string, string>();
  for (const document of ordered) {
    for (const typeName of extractTopLevelTypeNames(document.sdl)) {
      const existingPath = definedIn.get(typeName);
      if (existingPath !== undefined) {
        throw new ConfigError(
          "schema.duplicateTypeDefinition",
          `Type "${typeName}" is defined in both "${existingPath}" and "${document.path}"`,
          { details: { typeName, firstPath: existingPath, secondPath: document.path } },
        );
      }
      definedIn.set(typeName, document.path);
    }
  }

  return ordered.map((document) => `# --- ${document.path} ---\n\n${document.sdl.trimEnd()}\n`).join("\n");
}

/** Recursively collects every `*.graphql` file under `dir`, or `[]` if `dir` does not exist. */
function findGraphqlFragments(dir: string): SchemaDocument[] {
  if (!existsSync(dir)) {
    return [];
  }
  const documents: SchemaDocument[] = [];
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    if (statSync(entryPath).isDirectory()) {
      documents.push(...findGraphqlFragments(entryPath));
    } else if (entry.endsWith(".graphql")) {
      documents.push({ path: entryPath, sdl: readFileSync(entryPath, "utf8") });
    }
  }
  return documents;
}

export interface EmitSchemaOptions {
  readonly rootPath: string;
  readonly modulesDir: string;
  readonly outputPath: string;
}

/** Reads the root document and every module fragment, merges them, and writes `outputPath`. */
export function emitSchema(options: EmitSchemaOptions): string {
  const root: SchemaDocument = { path: options.rootPath, sdl: readFileSync(options.rootPath, "utf8") };
  const fragments = findGraphqlFragments(options.modulesDir).map((fragment) => ({
    path: relative(options.modulesDir, fragment.path),
    sdl: fragment.sdl,
  }));
  const merged = mergeSchemaDocuments(root, fragments);
  writeFileSync(options.outputPath, merged, "utf8");
  return merged;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  emitSchema({
    rootPath: join(here, "..", "src", "graphql", "schema.root.graphql"),
    modulesDir: join(here, "..", "src", "modules"),
    outputPath: join(here, "..", "schema.graphql"),
  });
}
