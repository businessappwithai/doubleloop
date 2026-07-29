// tests/graphql-errors.test.ts — module m15 (src/server/graphql-errors.ts). Covers `toGraphQLError`
// mapping every `AppError` subclass to its own `extensions.code`/`message`/`details`, an unknown
// throwable (an `Error`, a thrown string, and a thrown plain object) mapping to a fixed
// `"Internal server error"` message with `extensions.code = "internal"` while the real cause is
// logged — never placed on the returned `GraphQLError` — and `remapExecutionError` re-mapping a
// `graphql`-produced `GraphQLError` (preserving `path`/`nodes`/`source`/`positions`) through the
// same classification, both when `.originalError` is an `AppError` and when it is absent (a pure
// syntax/validation error, which intentionally becomes a generic `InternalError` here — see the
// file's own header comment on why `orchestrator.ts` never calls this for those).
import { describe, expect, test, vi } from "vitest";
import { GraphQLError } from "graphql";
import { remapExecutionError, toGraphQLError } from "../src/server/graphql-errors";
import {
  ConfigError,
  ConflictError,
  ForbiddenError,
  InternalError,
  MigrationError,
  NotFoundError,
  ValidationError,
} from "../src/core/errors";
import type { Logger } from "../src/server/ports";

function createSpyLogger(): Logger & { errorCalls: Array<[string, Record<string, unknown> | undefined]> } {
  const errorCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const logger: Logger & { errorCalls: typeof errorCalls } = {
    errorCalls,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((msg: string, fields?: Record<string, unknown>) => {
      errorCalls.push([msg, fields]);
    }),
    child: () => logger,
  };
  return logger;
}

describe("toGraphQLError — AppError subclasses", () => {
  test.each([
    ["NotFoundError", () => new NotFoundError("bundle not found", { details: { bundleId: "b1" } }), "not_found"],
    ["ValidationError", () => new ValidationError("title is required", { details: { field: "title" } }), "validation"],
    ["ConflictError", () => new ConflictError("stale version", { details: { expected: 1, actual: 2 } }), "conflict"],
    ["ForbiddenError", () => new ForbiddenError("not permitted", { details: {} }), "forbidden"],
    ["InternalError", () => new InternalError("boom", { details: {} }), "internal"],
    ["ConfigError", () => new ConfigError("config.invalid", "bad config", { details: { key: "PORT" } }), "config.invalid"],
    ["MigrationError", () => new MigrationError("migration.gap", "gap detected", { details: { version: 3 } }), "migration.gap"],
  ] as const)("%s maps to a GraphQLError with the error's own message and extensions.code", (_name, build, expectedCode) => {
    const logger = createSpyLogger();
    const appError = build();

    const result = toGraphQLError(appError, logger);

    expect(result).toBeInstanceOf(GraphQLError);
    expect(result.message).toBe(appError.message);
    expect(result.extensions["code"]).toBe(expectedCode);
    expect(result.extensions["details"]).toEqual(appError.details);
    expect(logger.errorCalls).toHaveLength(0);
  });

  test("details survive round-trip exactly, including nested values", () => {
    const logger = createSpyLogger();
    const err = new ConflictError("bundle.slugTaken", {
      details: { slug: "onboarding", existingId: "b1", nested: { a: 1 } },
    });

    const result = toGraphQLError(err, logger);

    expect(result.extensions["details"]).toEqual({ slug: "onboarding", existingId: "b1", nested: { a: 1 } });
  });
});

describe("toGraphQLError — unknown throwables never leak", () => {
  test("a plain Error becomes a generic InternalError message and code, and is logged in full", () => {
    const logger = createSpyLogger();
    const raw = new Error("the pg pool exploded with a stack trace and a connection string");

    const result = toGraphQLError(raw, logger);

    expect(result.message).toBe("Internal server error");
    expect(result.message).not.toContain("exploded");
    expect(result.extensions["code"]).toBe("internal");
    expect(result.extensions["details"]).toBeUndefined();

    expect(logger.errorCalls).toHaveLength(1);
    const [logMsg, fields] = logger.errorCalls[0]!;
    expect(logMsg).toBe("graphql.unhandledError");
    expect(fields?.["message"]).toBe("the pg pool exploded with a stack trace and a connection string");
    expect(fields?.["name"]).toBe("Error");
  });

  test("a thrown string is logged as its own message with a null stack, and never leaked", () => {
    const logger = createSpyLogger();

    const result = toGraphQLError("raw string throw with secret=abc123", logger);

    expect(result.message).toBe("Internal server error");
    expect(result.extensions["code"]).toBe("internal");
    expect(logger.errorCalls[0]?.[1]).toEqual({
      message: "raw string throw with secret=abc123",
      stack: null,
      name: null,
    });
  });

  test("a thrown plain object is stringified for the log and never leaked", () => {
    const logger = createSpyLogger();

    const result = toGraphQLError({ reason: "weird" }, logger);

    expect(result.message).toBe("Internal server error");
    expect(result.extensions["code"]).toBe("internal");
    expect(logger.errorCalls[0]?.[1]?.["message"]).toBe(String({ reason: "weird" }));
  });

  test("a subclassed AppError not explicitly listed above is still treated as an AppError, not logged", () => {
    class CustomAppError extends ConfigError {}
    const logger = createSpyLogger();
    const err = new CustomAppError("config.custom", "custom failure");

    const result = toGraphQLError(err, logger);

    expect(result.extensions["code"]).toBe("config.custom");
    expect(logger.errorCalls).toHaveLength(0);
  });
});

describe("remapExecutionError", () => {
  test("unwraps an AppError from .originalError and preserves path/nodes/source/positions", () => {
    const logger = createSpyLogger();
    const domainError = new NotFoundError("concept not found", { details: { conceptId: "c1" } });
    const executionError = new GraphQLError("concept not found", {
      path: ["concept"],
      originalError: domainError,
    });

    const result = remapExecutionError(executionError, logger);

    expect(result.message).toBe("concept not found");
    expect(result.extensions["code"]).toBe("not_found");
    expect(result.extensions["details"]).toEqual({ conceptId: "c1" });
    expect(result.path).toEqual(["concept"]);
    expect(logger.errorCalls).toHaveLength(0);
  });

  test("a GraphQLError with no .originalError (a pure syntax/validation error) becomes a generic InternalError", () => {
    const logger = createSpyLogger();
    const syntaxError = new GraphQLError("Cannot query field \"bogus\" on type \"Query\".", { path: ["bogus"] });

    const result = remapExecutionError(syntaxError, logger);

    expect(result.message).toBe("Internal server error");
    expect(result.extensions["code"]).toBe("internal");
    expect(logger.errorCalls).toHaveLength(1);
  });

  test("an unwrapped non-AppError .originalError is logged and reported generically, with path preserved", () => {
    const logger = createSpyLogger();
    const executionError = new GraphQLError("driver exploded", {
      path: ["bundle", "title"],
      originalError: new Error("connection reset by peer"),
    });

    const result = remapExecutionError(executionError, logger);

    expect(result.message).toBe("Internal server error");
    expect(result.extensions["code"]).toBe("internal");
    expect(result.path).toEqual(["bundle", "title"]);
    expect(logger.errorCalls[0]?.[1]?.["message"]).toBe("connection reset by peer");
  });
});
