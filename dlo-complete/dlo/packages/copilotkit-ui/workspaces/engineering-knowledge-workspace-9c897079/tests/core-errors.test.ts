// tests/core-errors.test.ts — module m3 (Core domain). Every AppError subclass's `code` and
// `httpStatus`, `cause`/`details` preservation, and `isAppError`/`toErrorExtensions` against
// both AppErrors and non-AppErrors.
import { describe, test, expect } from "vitest";
import {
  AppError,
  ConfigError,
  ConflictError,
  ForbiddenError,
  InternalError,
  MigrationError,
  NotFoundError,
  ValidationError,
  isAppError,
  toErrorExtensions,
} from "../src/core/errors";

describe("fixed-code AppError subclasses", () => {
  const FIXED_CODE_SUBCLASSES = [
    { name: "NotFoundError", Ctor: NotFoundError, code: "not_found", httpStatus: 404 },
    { name: "ValidationError", Ctor: ValidationError, code: "validation", httpStatus: 400 },
    { name: "ConflictError", Ctor: ConflictError, code: "conflict", httpStatus: 409 },
    { name: "ForbiddenError", Ctor: ForbiddenError, code: "forbidden", httpStatus: 403 },
    { name: "InternalError", Ctor: InternalError, code: "internal", httpStatus: 500 },
  ] as const;

  describe.each(FIXED_CODE_SUBCLASSES)("$name", ({ name, Ctor, code, httpStatus }) => {
    test("carries its fixed code and httpStatus", () => {
      const err = new Ctor("something went wrong");
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(httpStatus);
      expect(err.message).toBe("something went wrong");
      expect(err.name).toBe(name);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
    });

    test("defaults details to a frozen empty object", () => {
      const err = new Ctor("no details supplied");
      expect(err.details).toEqual({});
      expect(Object.isFrozen(err.details)).toBe(true);
    });

    test("freezes a copy of supplied details, independent of the source object", () => {
      const source = { field: "title", reason: "too long" };
      const err = new Ctor("bad input", { details: source });

      expect(err.details).toEqual(source);
      expect(Object.isFrozen(err.details)).toBe(true);
      expect(() => {
        (err.details as Record<string, unknown>)["field"] = "mutated";
      }).toThrow(TypeError);

      source.field = "mutated-source";
      expect(err.details["field"]).toBe("title");
    });

    test("preserves cause", () => {
      const original = new Error("driver failure");
      const err = new Ctor("wrapped", { cause: original });
      expect(err.cause).toBe(original);
    });

    test("leaves cause undefined when none is supplied", () => {
      const err = new Ctor("no cause");
      expect(err.cause).toBeUndefined();
    });
  });
});

describe("ConfigError", () => {
  test("carries the caller-supplied namespaced code and a 500 httpStatus", () => {
    const err = new ConfigError("db.unsupportedVersion", "PostgreSQL server version too old");
    expect(err.code).toBe("db.unsupportedVersion");
    expect(err.httpStatus).toBe(500);
    expect(err.message).toBe("PostgreSQL server version too old");
    expect(err.name).toBe("ConfigError");
    expect(err).toBeInstanceOf(AppError);
  });

  test("two instances carry independent codes", () => {
    const first = new ConfigError("config.invalidDbUrl", "bad url");
    const second = new ConfigError("git.credentialMissing", "missing credential");
    expect(first.code).toBe("config.invalidDbUrl");
    expect(second.code).toBe("git.credentialMissing");
  });

  test("preserves details and cause", () => {
    const original = new Error("zod parse failure");
    const err = new ConfigError("config.invalid", "invalid configuration", {
      details: { issues: ["DATABASE_URL missing"] },
      cause: original,
    });
    expect(err.details).toEqual({ issues: ["DATABASE_URL missing"] });
    expect(err.cause).toBe(original);
  });
});

describe("MigrationError", () => {
  test("carries the caller-supplied namespaced code and a 500 httpStatus", () => {
    const err = new MigrationError("migration.checksumMismatch", "checksum mismatch for 003");
    expect(err.code).toBe("migration.checksumMismatch");
    expect(err.httpStatus).toBe(500);
    expect(err.name).toBe("MigrationError");
    expect(err).toBeInstanceOf(AppError);
  });

  test("distinguishes gap vs checksum-mismatch codes", () => {
    const gap = new MigrationError("migration.gap", "migration 004 is missing");
    const mismatch = new MigrationError("migration.checksumMismatch", "003 was edited");
    expect(gap.code).toBe("migration.gap");
    expect(mismatch.code).toBe("migration.checksumMismatch");
  });
});

describe("isAppError", () => {
  test("is true for every AppError subclass instance", () => {
    expect(isAppError(new NotFoundError("x"))).toBe(true);
    expect(isAppError(new ValidationError("x"))).toBe(true);
    expect(isAppError(new ConflictError("x"))).toBe(true);
    expect(isAppError(new ForbiddenError("x"))).toBe(true);
    expect(isAppError(new InternalError("x"))).toBe(true);
    expect(isAppError(new ConfigError("config.x", "x"))).toBe(true);
    expect(isAppError(new MigrationError("migration.x", "x"))).toBe(true);
  });

  test("is false for a plain Error", () => {
    expect(isAppError(new Error("plain"))).toBe(false);
  });

  test("is false for non-error values", () => {
    expect(isAppError("a string")).toBe(false);
    expect(isAppError(404)).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError({ code: "not_found", httpStatus: 404 })).toBe(false);
  });
});

describe("toErrorExtensions", () => {
  test("projects code and details from an AppError", () => {
    const err = new NotFoundError("bundle not found", { details: { bundleId: "abc" } });
    expect(toErrorExtensions(err)).toEqual({ code: "not_found", details: { bundleId: "abc" } });
  });

  test("returns a frozen object", () => {
    const extensions = toErrorExtensions(new ValidationError("bad input"));
    expect(Object.isFrozen(extensions)).toBe(true);
  });

  test("reflects a ConfigError's dynamic code", () => {
    const err = new ConfigError("module.cycle", "cyclic module graph");
    expect(toErrorExtensions(err)).toEqual({ code: "module.cycle", details: {} });
  });
});
