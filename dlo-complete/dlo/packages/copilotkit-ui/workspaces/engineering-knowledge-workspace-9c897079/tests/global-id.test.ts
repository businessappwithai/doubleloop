// tests/global-id.test.ts — module m7 (Relay conventions). Round-trips every NODE_TYPES entry
// through toGlobalId/fromGlobalId, and covers every malformed-id case fromGlobalId must reject:
// non-base64, missing separator, empty parts, and an unknown type name.
import { Buffer } from "node:buffer";
import { describe, test, expect } from "vitest";
import { NODE_TYPES, fromGlobalId, toGlobalId, type NodeTypeName, localIdOfType } from "../src/core/global-id";
import { ValidationError } from "../src/core/errors";

const LOCAL_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function base64Of(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64");
}

function expectMalformed(thunk: () => unknown): ValidationError {
  expect(thunk).toThrow(ValidationError);
  try {
    thunk();
    throw new Error("expected fromGlobalId to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    const validationError = err as ValidationError;
    expect(validationError.message).toBe("globalId.malformed");
    expect(validationError.code).toBe("validation");
    expect(validationError.httpStatus).toBe(400);
    return validationError;
  }
}

describe("NODE_TYPES", () => {
  test("is a non-empty, de-duplicated tuple", () => {
    expect(NODE_TYPES.length).toBeGreaterThan(0);
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length);
  });
});

describe.each(NODE_TYPES)("toGlobalId/fromGlobalId round-trip for %s", (typeName) => {
  test("encodes and decodes back to the original type and local id", () => {
    const encoded = toGlobalId(typeName as NodeTypeName, LOCAL_ID);
    expect(fromGlobalId(encoded)).toEqual({ typeName, localId: LOCAL_ID });
  });

  test("produces an opaque base64 string, not the raw 'type:id' text", () => {
    const encoded = toGlobalId(typeName as NodeTypeName, LOCAL_ID);
    expect(encoded).not.toContain(":");
    expect(encoded).toBe(base64Of(`${typeName}:${LOCAL_ID}`));
  });
});

describe("fromGlobalId", () => {
  test("different type names with the same local id encode to different global ids", () => {
    const encoded = NODE_TYPES.map((typeName) => toGlobalId(typeName, LOCAL_ID));
    expect(new Set(encoded).size).toBe(NODE_TYPES.length);
  });

  test("rejects a non-base64 string", () => {
    const err = expectMalformed(() => fromGlobalId("not-valid-base64!!!"));
    expect(err.details).toEqual({ id: "not-valid-base64!!!", reason: "not valid base64" });
  });

  test("rejects an empty string", () => {
    expectMalformed(() => fromGlobalId(""));
  });

  test("rejects base64 that decodes without a ':' separator", () => {
    const id = base64Of("NoSeparatorHere");
    const err = expectMalformed(() => fromGlobalId(id));
    expect(err.details).toEqual({ id, reason: "missing ':' separator" });
  });

  test("rejects an empty type name", () => {
    const id = base64Of(`:${LOCAL_ID}`);
    const err = expectMalformed(() => fromGlobalId(id));
    expect(err.details).toEqual({ id, reason: "empty type or local id" });
  });

  test("rejects an empty local id", () => {
    const id = base64Of("Concept:");
    const err = expectMalformed(() => fromGlobalId(id));
    expect(err.details).toEqual({ id, reason: "empty type or local id" });
  });

  test("rejects an unknown type name", () => {
    const id = base64Of(`Unicorn:${LOCAL_ID}`);
    const err = expectMalformed(() => fromGlobalId(id));
    expect(err.details).toEqual({ id, reason: 'unknown node type "Unicorn"' });
  });

  test("rejects a non-string value smuggled past the type system", () => {
    expectMalformed(() => fromGlobalId(null as unknown as string));
    expectMalformed(() => fromGlobalId(undefined as unknown as string));
    expectMalformed(() => fromGlobalId(12345 as unknown as string));
  });
});

// ---------------------------------------------------------------------------
// localIdOfType
//
// Every GraphQL argument typed `ID!` carries a GLOBAL id — that is what a client holds, because it
// is what `Node.id` returns. Several resolvers passed one straight to `asConceptId`/`asBundleId`
// (`conceptDocument`, `saveConceptDocument`, `search`, `gitSyncRuns`, `syncBundle`), which failed
// with "must be a v4 UUID" against the base64 string. Those fields could only ever be called with
// a raw uuid no client ever has — opening any concept showed "ConceptId must be a v4 UUID".
// ---------------------------------------------------------------------------

describe("localIdOfType", () => {
  const CONCEPT_UUID = "50000000-0000-4000-8000-000000000001";
  const BUNDLE_UUID = "60000000-0000-4000-8000-000000000002";

  test("returns the local id of a matching global id", () => {
    expect(localIdOfType(toGlobalId("Concept", CONCEPT_UUID), "Concept")).toBe(CONCEPT_UUID);
    expect(localIdOfType(toGlobalId("Bundle", BUNDLE_UUID), "Bundle")).toBe(BUNDLE_UUID);
  });

  test("round-trips with toGlobalId for both node types", () => {
    for (const [typeName, uuid] of [["Concept", CONCEPT_UUID], ["Bundle", BUNDLE_UUID]] as const) {
      expect(localIdOfType(toGlobalId(typeName, uuid), typeName)).toBe(uuid);
    }
  });

  test("throws ValidationError('globalId.wrongType') when the id encodes a different type", () => {
    try {
      localIdOfType(toGlobalId("Bundle", BUNDLE_UUID), "Concept");
      throw new Error("expected localIdOfType to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("globalId.wrongType");
      expect((err as ValidationError).details["expected"]).toBe("Concept");
      expect((err as ValidationError).details["actual"]).toBe("Bundle");
    }
  });

  test("propagates ValidationError('globalId.malformed') for a non-global id", () => {
    // A raw uuid is exactly what the broken resolvers were being handed instead.
    expect(() => localIdOfType(CONCEPT_UUID, "Concept")).toThrow(ValidationError);
  });

  test("rejects an empty string", () => {
    expect(() => localIdOfType("", "Concept")).toThrow(ValidationError);
  });

  test("rejects a base64 string with no type separator", () => {
    expect(() => localIdOfType(Buffer.from("nope", "utf8").toString("base64"), "Concept")).toThrow(
      ValidationError,
    );
  });
});
