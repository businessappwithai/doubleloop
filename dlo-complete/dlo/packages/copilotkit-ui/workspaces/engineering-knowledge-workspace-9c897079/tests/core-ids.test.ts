// tests/core-ids.test.ts — module m3 (Core domain). Covers every branded-id constructor
// identically via a table, since they share one validation routine: a valid v4 UUID is
// branded and returned unchanged; anything else throws ValidationError with the offending
// value and type name attached.
import { describe, test, expect } from "vitest";
import { asActorId, asBundleId, asConceptId, asRevisionId } from "../src/core/ids";
import { ValidationError } from "../src/core/errors";

const VALID_V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const VALID_V4_UPPERCASE = "F47AC10B-58CC-4372-A567-0E02B2C3D479";
const WRONG_VERSION_V1 = "f47ac10b-58cc-1372-a567-0e02b2c3d479";
const WRONG_VARIANT = "f47ac10b-58cc-4372-c567-0e02b2c3d479";
const MALFORMED = "not-a-uuid";
const EMPTY = "";
const WHITESPACE = "   ";
const TRUNCATED = "f47ac10b-58cc-4372-a567-0e02b2c3d47";

const CONSTRUCTORS = [
  { typeName: "BundleId", make: asBundleId },
  { typeName: "ConceptId", make: asConceptId },
  { typeName: "ActorId", make: asActorId },
  { typeName: "RevisionId", make: asRevisionId },
] as const;

describe.each(CONSTRUCTORS)("as$typeName", ({ typeName, make }) => {
  test("accepts a valid v4 UUID and returns it branded", () => {
    expect(make(VALID_V4)).toBe(VALID_V4);
  });

  test("accepts an uppercase v4 UUID", () => {
    expect(make(VALID_V4_UPPERCASE)).toBe(VALID_V4_UPPERCASE);
  });

  test("rejects an empty string", () => {
    expect(() => make(EMPTY)).toThrow(ValidationError);
    try {
      make(EMPTY);
      throw new Error("expected make() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const validationError = err as ValidationError;
      expect(validationError.code).toBe("validation");
      expect(validationError.httpStatus).toBe(400);
      expect(validationError.message).toBe(`${typeName} must be a non-empty UUID string`);
      expect(validationError.details).toEqual({ typeName, value: EMPTY });
    }
  });

  test("rejects a whitespace-only string as malformed", () => {
    expect(() => make(WHITESPACE)).toThrow(ValidationError);
  });

  test("rejects malformed input that is not UUID-shaped at all", () => {
    expect(() => make(MALFORMED)).toThrow(ValidationError);
    try {
      make(MALFORMED);
      throw new Error("expected make() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe(`${typeName} must be a v4 UUID`);
      expect((err as ValidationError).details).toEqual({ typeName, value: MALFORMED });
    }
  });

  test("rejects a wrong-version UUID (v1 instead of v4)", () => {
    expect(() => make(WRONG_VERSION_V1)).toThrow(ValidationError);
  });

  test("rejects a UUID with an invalid variant nibble", () => {
    expect(() => make(WRONG_VARIANT)).toThrow(ValidationError);
  });

  test("rejects a truncated UUID", () => {
    expect(() => make(TRUNCATED)).toThrow(ValidationError);
  });

  test("rejects a non-string value smuggled past the type system", () => {
    expect(() => make(null as unknown as string)).toThrow(ValidationError);
    expect(() => make(undefined as unknown as string)).toThrow(ValidationError);
    expect(() => make(12345 as unknown as string)).toThrow(ValidationError);
  });
});

describe("branded id constructors are independent per type", () => {
  test("each constructor stamps its own type name into the rejection details", () => {
    const failures = CONSTRUCTORS.map(({ typeName, make }) => {
      try {
        make(EMPTY);
        return null;
      } catch (err) {
        return { typeName, details: (err as ValidationError).details };
      }
    });

    expect(failures).toEqual(
      CONSTRUCTORS.map(({ typeName }) => ({ typeName, details: { typeName, value: EMPTY } })),
    );
  });
});
