// @vitest-environment node
//
// tests/seed-runner.test.ts — scripts/seed.ts, the `npm run db:seed` runner.
//
// sql/seed/001_dev_seed.sql's header promised a runner that "refuses to run when
// NODE_ENV === 'production'". No module ever built it, so a freshly migrated database had no
// workspace, no users and no bundles, and the picker could only render its empty state. These
// tests pin the production guard (including the unset-NODE_ENV case, which is refused on purpose),
// file discovery and ordering, application order, and the failure modes — all against injected
// fakes: no filesystem, no database.
import { describe, expect, test } from "vitest";
import { ConfigError } from "../src/core/errors";
import {
  applySeedFiles,
  assertSeedable,
  readSeedFiles,
  runSeed,
  type SeedDb,
  type SeedFile,
} from "../scripts/seed";

/** A SeedDb that records every statement it is handed. */
function recordingDb(onQuery?: (sql: string) => void): SeedDb & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    async query(sql: string) {
      statements.push(sql);
      onQuery?.(sql);
      return { rows: [], rowCount: 0 };
    },
  };
}

/** A `readdirSync` stand-in returning `names`, and a `readFileSync` stand-in over `contents`. */
function fakeFs(contents: Record<string, string>) {
  const list = ((_dir: string) => Object.keys(contents)) as unknown as typeof import("node:fs").readdirSync;
  const read = ((path: string) => {
    const name = String(path).split("/").pop() as string;
    const body = contents[name];
    if (body === undefined) {
      throw new Error(`unexpected read of ${String(path)}`);
    }
    return body;
  }) as unknown as typeof import("node:fs").readFileSync;
  return { list, read };
}

describe("assertSeedable", () => {
  test("permits an explicitly non-production environment", () => {
    expect(() => assertSeedable("development")).not.toThrow();
    expect(() => assertSeedable("test")).not.toThrow();
    expect(() => assertSeedable("staging")).not.toThrow();
  });

  test("refuses production", () => {
    expect(() => assertSeedable("production")).toThrow(ConfigError);
  });

  test("throws ConfigError('seed.refusedInProduction') with the env in details", () => {
    try {
      assertSeedable("production");
      throw new Error("expected assertSeedable to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("seed.refusedInProduction");
      expect((err as ConfigError).details["env"]).toBe("production");
    }
  });

  test("refuses an unset NODE_ENV rather than assuming development", () => {
    // The dangerous case is also the one where the variable is most likely missing, so an absent
    // value must never be read as "probably a dev box".
    expect(() => assertSeedable(undefined)).toThrow(ConfigError);
    expect((() => {
      try {
        assertSeedable(undefined);
        return null;
      } catch (err) {
        return (err as ConfigError).details["env"];
      }
    })()).toBeNull();
  });

  test("refuses an empty NODE_ENV", () => {
    expect(() => assertSeedable("")).toThrow(ConfigError);
  });
});

describe("readSeedFiles", () => {
  test("returns every .sql file with its contents", () => {
    const { list, read } = fakeFs({ "001_a.sql": "SELECT 1", "002_b.sql": "SELECT 2" });

    expect(readSeedFiles("/seed", read, list)).toEqual([
      { filename: "001_a.sql", sql: "SELECT 1" },
      { filename: "002_b.sql", sql: "SELECT 2" },
    ]);
  });

  test("sorts by filename so numeric prefixes define the order", () => {
    const { list, read } = fakeFs({ "010_c.sql": "c", "002_b.sql": "b", "001_a.sql": "a" });

    expect(readSeedFiles("/seed", read, list).map((f) => f.filename)).toEqual([
      "001_a.sql",
      "002_b.sql",
      "010_c.sql",
    ]);
  });

  test("ignores files that are not .sql", () => {
    const { list, read } = fakeFs({ "001_a.sql": "a", "README.md": "x", ".keep": "" });

    expect(readSeedFiles("/seed", read, list).map((f) => f.filename)).toEqual(["001_a.sql"]);
  });

  test("throws ConfigError('seed.noSeedFiles') when the directory holds none", () => {
    const { list, read } = fakeFs({ "README.md": "x" });

    try {
      readSeedFiles("/seed", read, list);
      throw new Error("expected readSeedFiles to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("seed.noSeedFiles");
      expect((err as ConfigError).details["dir"]).toBe("/seed");
    }
  });

  test("throws when the directory is empty", () => {
    const { list, read } = fakeFs({});

    expect(() => readSeedFiles("/seed", read, list)).toThrow(ConfigError);
  });
});

describe("applySeedFiles", () => {
  test("issues each file's SQL in order and reports what it applied", async () => {
    const db = recordingDb();
    const files: SeedFile[] = [
      { filename: "001_a.sql", sql: "INSERT A" },
      { filename: "002_b.sql", sql: "INSERT B" },
    ];

    await expect(applySeedFiles(db, files)).resolves.toEqual(["001_a.sql", "002_b.sql"]);
    expect(db.statements).toEqual(["INSERT A", "INSERT B"]);
  });

  test("applies nothing and reports nothing for an empty list", async () => {
    const db = recordingDb();

    await expect(applySeedFiles(db, [])).resolves.toEqual([]);
    expect(db.statements).toEqual([]);
  });

  test("stops at the first failing file rather than continuing past it", async () => {
    const failure = new Error("duplicate key");
    const db = recordingDb((sql) => {
      if (sql === "INSERT B") {
        throw failure;
      }
    });
    const files: SeedFile[] = [
      { filename: "001_a.sql", sql: "INSERT A" },
      { filename: "002_b.sql", sql: "INSERT B" },
      { filename: "003_c.sql", sql: "INSERT C" },
    ];

    await expect(applySeedFiles(db, files)).rejects.toBe(failure);
    expect(db.statements).toEqual(["INSERT A", "INSERT B"]);
  });
});

describe("runSeed", () => {
  test("guards, reads, and applies", async () => {
    const db = recordingDb();
    const { list, read } = fakeFs({
      "001_dev_seed.sql": "BEGIN; INSERT A; COMMIT;",
      "002_more.sql": "BEGIN; INSERT B; COMMIT;",
    });

    await expect(runSeed({ db, seedDir: "/seed", env: "development", read, list })).resolves.toEqual([
      "001_dev_seed.sql",
      "002_more.sql",
    ]);
    expect(db.statements).toEqual(["BEGIN; INSERT A; COMMIT;", "BEGIN; INSERT B; COMMIT;"]);
  });

  test("surfaces ConfigError('seed.noSeedFiles') without touching the database", async () => {
    const db = recordingDb();
    const { list, read } = fakeFs({ "README.md": "x" });

    await expect(
      runSeed({ db, seedDir: "/seed", env: "development", read, list }),
    ).rejects.toMatchObject({ code: "seed.noSeedFiles" });
    expect(db.statements).toEqual([]);
  });

  test("refuses before touching the database when NODE_ENV is production", async () => {
    const db = recordingDb();

    await expect(runSeed({ db, seedDir: "/seed", env: "production" })).rejects.toMatchObject({
      code: "seed.refusedInProduction",
    });
    expect(db.statements).toEqual([]);
  });

  test("refuses before touching the database when NODE_ENV is unset", async () => {
    const db = recordingDb();

    await expect(runSeed({ db, seedDir: "/seed", env: undefined })).rejects.toMatchObject({
      code: "seed.refusedInProduction",
    });
    expect(db.statements).toEqual([]);
  });
});
