// @vitest-environment node
//
// Runs in the node environment, not jsdom: this suite reads real files off disk via
// `fileURLToPath(new URL(..., import.meta.url))`, and under the jsdom environment wrapper
// import.meta.url is not resolved to a file: URL, so fileURLToPath throws
// ERR_INVALID_URL_SCHEME before any assertion runs. There is nothing DOM-dependent here.
// tests/emit-schema.test.ts — module m7 (Relay conventions). extractTopLevelTypeNames and
// mergeSchemaDocuments are exercised as pure functions against fixture SDL strings (deterministic
// ordering, extend-vs-define, duplicate-type-definition failure); emitSchema's real filesystem
// I/O is exercised against a temp directory created per test, never against this repo's own
// (not-yet-existing) src/modules or schema.graphql.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, expect } from "vitest";
import { parse } from "graphql";
import {
  emitSchema,
  extractTopLevelTypeNames,
  flattenTypeExtensions,
  mergeSchemaDocuments,
  type SchemaDocument,
} from "../scripts/emit-schema";
import { ConfigError } from "../src/core/errors";

describe("src/graphql/schema.root.graphql", () => {
  test("is syntactically valid SDL declaring Node, PageInfo, the OKF enums, the scalars, Query and Mutation", () => {
    const rootPath = new URL("../src/graphql/schema.root.graphql", import.meta.url);
    const sdl = readFileSync(fileURLToPath(rootPath), "utf8");

    expect(extractTopLevelTypeNames(sdl)).toEqual([
      "Node",
      "PageInfo",
      "TrustLevel",
      "Lifecycle",
      "DateTime",
      "JSON",
      "Query",
      "Mutation",
    ]);
  });
});

describe("extractTopLevelTypeNames", () => {
  test("collects scalar, object, interface, union, enum and input definitions", () => {
    const sdl = `
      scalar DateTime
      interface Node { id: ID! }
      type Bundle implements Node { id: ID! }
      union SearchResult = Bundle
      enum TrustLevel { UNVERIFIED }
      input CreateBundleInput { title: String! }
    `;
    expect(extractTopLevelTypeNames(sdl)).toEqual([
      "DateTime",
      "Node",
      "Bundle",
      "SearchResult",
      "TrustLevel",
      "CreateBundleInput",
    ]);
  });

  test("ignores extend definitions", () => {
    const sdl = `
      type Query { node(id: ID!): Node }
      extend type Query { bundles: [Bundle!]! }
    `;
    expect(extractTopLevelTypeNames(sdl)).toEqual(["Query"]);
  });

  test("returns an empty array for a document with only extensions", () => {
    expect(extractTopLevelTypeNames("extend type Query { ping: Boolean }")).toEqual([]);
  });
});

describe("mergeSchemaDocuments", () => {
  const root: SchemaDocument = {
    path: "schema.root.graphql",
    sdl: "interface Node { id: ID! }\ntype Query { node(id: ID!): Node }",
  };

  test("concatenates root then fragments sorted by path, independent of input order", () => {
    const fragments: SchemaDocument[] = [
      { path: "modules/search/search-schema.graphql", sdl: "extend type Query { search: Boolean }" },
      { path: "modules/bundles/bundle-schema.graphql", sdl: "type Bundle implements Node { id: ID! }" },
    ];

    const merged = mergeSchemaDocuments(root, fragments);

    const rootIndex = merged.indexOf("schema.root.graphql");
    const bundlesIndex = merged.indexOf("modules/bundles/bundle-schema.graphql");
    const searchIndex = merged.indexOf("modules/search/search-schema.graphql");
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    expect(rootIndex).toBeLessThan(bundlesIndex);
    expect(bundlesIndex).toBeLessThan(searchIndex);
    expect(merged).toContain("type Bundle implements Node");
    expect(merged).toContain("extend type Query { search: Boolean }");
  });

  test("returns just the root content when there are no fragments", () => {
    const merged = mergeSchemaDocuments(root, []);
    expect(merged).toContain("type Query { node(id: ID!): Node }");
  });

  test("throws ConfigError('schema.duplicateTypeDefinition') when two documents define the same type", () => {
    const fragments: SchemaDocument[] = [
      { path: "modules/a/a.graphql", sdl: "type Bundle { id: ID! }" },
      { path: "modules/b/b.graphql", sdl: "type Bundle { id: ID! }" },
    ];

    expect(() => mergeSchemaDocuments(root, fragments)).toThrow(ConfigError);
    try {
      mergeSchemaDocuments(root, fragments);
      throw new Error("expected mergeSchemaDocuments to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      expect(configError.code).toBe("schema.duplicateTypeDefinition");
      expect(configError.httpStatus).toBe(500);
      expect(configError.details).toEqual({
        typeName: "Bundle",
        firstPath: "modules/a/a.graphql",
        secondPath: "modules/b/b.graphql",
      });
    }
  });

  test("a fragment redefining a root type is also a duplicate", () => {
    const fragments: SchemaDocument[] = [{ path: "modules/a/a.graphql", sdl: "type Query { ping: Boolean }" }];
    expect(() => mergeSchemaDocuments(root, fragments)).toThrow(ConfigError);
  });

  test("a fragment extending a type the root defines is not a duplicate", () => {
    const fragments: SchemaDocument[] = [
      { path: "modules/bundles/bundle-schema.graphql", sdl: "extend type Query { bundles: Boolean }" },
    ];
    expect(() => mergeSchemaDocuments(root, fragments)).not.toThrow();
  });

  test("two fragments each extending the same type are not flagged as duplicates", () => {
    const fragments: SchemaDocument[] = [
      { path: "modules/a/a.graphql", sdl: "extend type Query { a: Boolean }" },
      { path: "modules/b/b.graphql", sdl: "extend type Query { b: Boolean }" },
    ];
    expect(() => mergeSchemaDocuments(root, fragments)).not.toThrow();
  });
});

describe("emitSchema", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "emit-schema-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the root document and every module fragment, merges them, and writes the output file", () => {
    const rootPath = join(dir, "schema.root.graphql");
    writeFileSync(rootPath, "interface Node { id: ID! }\ntype Query { node(id: ID!): Node }\n", "utf8");

    const modulesDir = join(dir, "modules");
    mkdirSync(join(modulesDir, "bundles"), { recursive: true });
    writeFileSync(
      join(modulesDir, "bundles", "bundle-schema.graphql"),
      "type Bundle implements Node { id: ID! }\nextend type Query { bundle(id: ID!): Bundle }\n",
      "utf8",
    );

    const outputPath = join(dir, "schema.graphql");
    const returned = emitSchema({ rootPath, modulesDir, outputPath });
    const written = readFileSync(outputPath, "utf8");

    expect(written).toBe(returned);
    expect(written).toContain("type Bundle implements Node");
    expect(written).toContain("extend type Query { bundle(id: ID!): Bundle }");
  });

  test("treats a missing modules directory as zero fragments", () => {
    const rootPath = join(dir, "schema.root.graphql");
    writeFileSync(rootPath, "type Query { node(id: ID!): Node }\n", "utf8");
    const outputPath = join(dir, "schema.graphql");

    const returned = emitSchema({ rootPath, modulesDir: join(dir, "does-not-exist"), outputPath });

    expect(returned).toContain("type Query { node(id: ID!): Node }");
    expect(readFileSync(outputPath, "utf8")).toBe(returned);
  });

  test("recurses into nested module subdirectories", () => {
    const rootPath = join(dir, "schema.root.graphql");
    writeFileSync(rootPath, "type Query { node(id: ID!): Node }\n", "utf8");
    const modulesDir = join(dir, "modules");
    mkdirSync(join(modulesDir, "hierarchy", "nested"), { recursive: true });
    writeFileSync(join(modulesDir, "hierarchy", "nested", "deep.graphql"), "type Deep { id: ID! }\n", "utf8");
    const outputPath = join(dir, "schema.graphql");

    const returned = emitSchema({ rootPath, modulesDir, outputPath });

    expect(returned).toContain("type Deep");
  });

  test("propagates the duplicate-type-definition failure when it comes from real files", () => {
    const rootPath = join(dir, "schema.root.graphql");
    writeFileSync(rootPath, "type Query { node(id: ID!): Node }\n", "utf8");
    const modulesDir = join(dir, "modules");
    mkdirSync(join(modulesDir, "a"), { recursive: true });
    mkdirSync(join(modulesDir, "b"), { recursive: true });
    writeFileSync(join(modulesDir, "a", "a.graphql"), "type Bundle { id: ID! }\n", "utf8");
    writeFileSync(join(modulesDir, "b", "b.graphql"), "type Bundle { id: ID! }\n", "utf8");
    const outputPath = join(dir, "schema.graphql");

    expect(() => emitSchema({ rootPath, modulesDir, outputPath })).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// flattenTypeExtensions
//
// relay-compiler reads schema.graphql as the SERVER schema and treats a type extension in it as a
// CLIENT schema extension — fields that live only in the client store. An operation whose fields
// are all client-only has no text to send, so relay emits `params.text: null`, `src/relay/fetch.ts`
// POSTs `{"query": null}`, and the route answers 400. Every module fragment adds its root fields
// via `extend type Query`, so five of this app's seven operations compiled with no query text and
// every one of them failed at runtime. relay-compiler reports it only as
// "compiled documents: 7 reader, 7 normalization, 2 operation text".
// ---------------------------------------------------------------------------

describe("flattenTypeExtensions", () => {
  test("folds an extend block into the type it extends", () => {
    const sdl = ["type Query {", "  node(id: ID!): Node", "}", "", "extend type Query {", "  bundle(id: ID!): Bundle", "}", ""].join("\n");

    const result = flattenTypeExtensions(sdl);

    expect(result).not.toContain("extend type");
    expect(result).toContain("  node(id: ID!): Node");
    expect(result).toContain("  bundle(id: ID!): Bundle");
    expect(result.match(/^type Query \{/gm)).toHaveLength(1);
  });

  test("folds several extends of the same type, in document order", () => {
    const sdl = [
      "type Query {",
      "  node(id: ID!): Node",
      "}",
      "",
      "extend type Query {",
      "  bundle(id: ID!): Bundle",
      "}",
      "",
      "extend type Query {",
      "  concept(id: ID!): Concept",
      "}",
      "",
    ].join("\n");

    const result = flattenTypeExtensions(sdl);

    expect(result).not.toContain("extend type");
    const body = result.slice(result.indexOf("type Query {"), result.indexOf("}", result.indexOf("type Query {")));
    expect(body.indexOf("node")).toBeLessThan(body.indexOf("bundle"));
    expect(body.indexOf("bundle")).toBeLessThan(body.indexOf("concept"));
  });

  test("folds into a type declared with an implements clause", () => {
    // `type Concept implements Node {` — the definition pattern must not require `{` to follow
    // the name directly, or the extension is silently left behind.
    const sdl = [
      "type Concept implements Node {",
      "  id: ID!",
      "}",
      "",
      "extend type Concept {",
      "  children: [Concept!]!",
      "}",
      "",
    ].join("\n");

    const result = flattenTypeExtensions(sdl);

    expect(result).not.toContain("extend type");
    expect(result).toContain("  children: [Concept!]!");
  });

  test("folds extends of Mutation, interfaces, inputs and enums alike", () => {
    const sdl = [
      "type Mutation {",
      "  _empty: Boolean",
      "}",
      "",
      "extend type Mutation {",
      "  createBundle(input: CreateBundleInput!): Bundle!",
      "}",
      "",
      "input Filter {",
      "  q: String",
      "}",
      "",
      "extend input Filter {",
      "  limit: Int",
      "}",
      "",
    ].join("\n");

    const result = flattenTypeExtensions(sdl);

    expect(result).not.toContain("extend type");
    expect(result).not.toContain("extend input");
    expect(result).toContain("  createBundle(input: CreateBundleInput!): Bundle!");
    expect(result).toContain("  limit: Int");
  });

  test("preserves field descriptions and comments inside a folded block", () => {
    const sdl = [
      "type Query {",
      "  node(id: ID!): Node",
      "}",
      "",
      "extend type Query {",
      '  """Live presence."""',
      "  presence(conceptId: ID!): [PresenceEntry!]!",
      "}",
      "",
    ].join("\n");

    const result = flattenTypeExtensions(sdl);

    expect(result).toContain('"""Live presence."""');
    expect(result).toContain("  presence(conceptId: ID!): [PresenceEntry!]!");
  });

  test("leaves an extend of a type nothing defines untouched, for the compiler to report", () => {
    const sdl = ["extend type Missing {", "  field: String", "}", ""].join("\n");

    expect(flattenTypeExtensions(sdl)).toContain("extend type Missing {");
  });

  test("is a no-op on SDL with no extensions", () => {
    const sdl = ["type Query {", "  node(id: ID!): Node", "}", ""].join("\n");

    expect(flattenTypeExtensions(sdl)).toBe(sdl);
  });

  test("is a no-op on an empty document", () => {
    expect(flattenTypeExtensions("")).toBe("");
  });

  test("keeps the provenance comments that make the emitted file readable", () => {
    const sdl = [
      "# --- src/graphql/schema.root.graphql ---",
      "",
      "type Query {",
      "  node(id: ID!): Node",
      "}",
      "",
      "# --- src/modules/bundles/bundle-schema.graphql ---",
      "",
      "extend type Query {",
      "  bundle(id: ID!): Bundle",
      "}",
      "",
    ].join("\n");

    const result = flattenTypeExtensions(sdl);

    expect(result).toContain("# --- src/graphql/schema.root.graphql ---");
    expect(result).toContain("# --- src/modules/bundles/bundle-schema.graphql ---");
  });

  test("produces a document the graphql parser still accepts", () => {
    const sdl = [
      "type Query {",
      "  node(id: ID!): Node",
      "}",
      "",
      "extend type Query {",
      "  bundle(id: ID!): Bundle",
      "}",
      "",
      "type Bundle {",
      "  id: ID!",
      "}",
      "",
      "interface Node {",
      "  id: ID!",
      "}",
      "",
    ].join("\n");

    expect(() => parse(flattenTypeExtensions(sdl))).not.toThrow();
  });
});
