// tests/core-context.test.ts — module m3 (Core domain). createRequestContext's happy path,
// its two ValidationError branches (blank requestId, missing actor), and that the returned
// context is frozen and carries the actor through by reference.
import { describe, test, expect } from "vitest";
import { createRequestContext, type Actor } from "../src/core/context";
import { asActorId } from "../src/core/ids";
import { ValidationError } from "../src/core/errors";

const ACTOR: Actor = {
  id: asActorId("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
  email: "jane@example.com",
  displayName: "Jane Doe",
};

describe("createRequestContext", () => {
  test("builds a context from a requestId and actor", () => {
    const ctx = createRequestContext({ requestId: "req-123", actor: ACTOR });
    expect(ctx.requestId).toBe("req-123");
    expect(ctx.actor).toBe(ACTOR);
  });

  test("returns a frozen object", () => {
    const ctx = createRequestContext({ requestId: "req-123", actor: ACTOR });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as { requestId: string }).requestId = "mutated";
    }).toThrow(TypeError);
  });

  test("rejects an empty requestId", () => {
    expect(() => createRequestContext({ requestId: "", actor: ACTOR })).toThrow(ValidationError);
  });

  test("rejects a whitespace-only requestId", () => {
    expect(() => createRequestContext({ requestId: "   ", actor: ACTOR })).toThrow(ValidationError);
  });

  test("rejects a non-string requestId smuggled past the type system", () => {
    expect(() =>
      createRequestContext({ requestId: 42 as unknown as string, actor: ACTOR }),
    ).toThrow(ValidationError);
  });

  test("the requestId ValidationError carries the offending value and a 400 httpStatus", () => {
    try {
      createRequestContext({ requestId: "", actor: ACTOR });
      throw new Error("expected createRequestContext to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const validationError = err as ValidationError;
      expect(validationError.code).toBe("validation");
      expect(validationError.httpStatus).toBe(400);
      expect(validationError.details).toEqual({ requestId: "" });
    }
  });

  test("rejects a null actor", () => {
    expect(() =>
      createRequestContext({ requestId: "req-123", actor: null as unknown as Actor }),
    ).toThrow(ValidationError);
  });

  test("rejects an undefined actor", () => {
    expect(() =>
      createRequestContext({ requestId: "req-123", actor: undefined as unknown as Actor }),
    ).toThrow(ValidationError);
  });

  test("the missing-actor ValidationError reports its code", () => {
    try {
      createRequestContext({ requestId: "req-123", actor: null as unknown as Actor });
      throw new Error("expected createRequestContext to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("RequestContext requires an actor");
    }
  });
});
