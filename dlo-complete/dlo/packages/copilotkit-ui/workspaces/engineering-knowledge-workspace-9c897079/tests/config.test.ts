// tests/config.test.ts — module m4 (Configuration and structured logging). Covers a complete
// valid environment, every required key missing individually (and two at once), every malformed
// field, the poolMax boundary (1 rejected, 2 accepted), autoMigrate forbidden outside development,
// applied defaults, frozen output, and that loadConfig never reads process.env.
import { describe, test, expect, vi } from "vitest";
import { loadConfig, type EnvRecord } from "../src/config/config";
import { ConfigError } from "../src/core/errors";

const VALID_ENV: EnvRecord = {
  NODE_ENV: "development",
  INSTANCE_ID: "local-dev",
  PORT: "3000",
  DATABASE_URL: "postgres://ekw:ekw@localhost:5432/ekw",
  DB_POOL_MAX: "10",
  DB_SSL: "false",
  DB_AUTO_MIGRATE: "true",
  COLLAB_WS_URL: "ws://localhost:1234",
  COLLAB_WS_PORT: "1234",
  GIT_SYNC_REPO_PATH: "./data/git-sync",
  GIT_SYNC_BRANCH: "main",
  GIT_SYNC_INTERVAL_MS: "300000",
  LOG_LEVEL: "info",
};

function withOverride(overrides: EnvRecord): EnvRecord {
  return { ...VALID_ENV, ...overrides };
}

function withoutKey(key: keyof typeof VALID_ENV): EnvRecord {
  const clone = { ...VALID_ENV };
  delete clone[key];
  return clone;
}

function expectConfigError(fn: () => unknown, code: string): ConfigError {
  try {
    fn();
    throw new Error(`expected loadConfig to throw ConfigError with code "${code}"`);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const configError = err as ConfigError;
    expect(configError.code).toBe(code);
    return configError;
  }
}

describe("loadConfig — valid environment", () => {
  test("parses a complete valid environment into a nested AppConfig", () => {
    const config = loadConfig(VALID_ENV);

    expect(config).toEqual({
      env: "development",
      instanceId: "local-dev",
      port: 3000,
      db: { url: "postgres://ekw:ekw@localhost:5432/ekw", poolMax: 10, ssl: false, autoMigrate: true },
      collab: { wsUrl: "ws://localhost:1234", port: 1234 },
      gitSync: { repoPath: "./data/git-sync", branch: "main", intervalMs: 300_000 },
      logLevel: "info",
    });
  });

  test("returns a deeply frozen object", () => {
    const config = loadConfig(VALID_ENV);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.db)).toBe(true);
    expect(Object.isFrozen(config.collab)).toBe(true);
    expect(Object.isFrozen(config.gitSync)).toBe(true);
    expect(() => {
      (config as { port: number }).port = 9999;
    }).toThrow(TypeError);
  });

  test("applies every default when optional keys are omitted", () => {
    const minimal: EnvRecord = {
      INSTANCE_ID: "local-dev",
      DATABASE_URL: "postgres://ekw:ekw@localhost:5432/ekw",
      COLLAB_WS_URL: "ws://localhost:1234",
      GIT_SYNC_REPO_PATH: "./data/git-sync",
    };

    const config = loadConfig(minimal);

    expect(config.env).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.db.poolMax).toBe(10);
    expect(config.db.ssl).toBe(false);
    expect(config.db.autoMigrate).toBe(false);
    expect(config.collab.port).toBe(1234);
    expect(config.gitSync.branch).toBe("main");
    expect(config.gitSync.intervalMs).toBe(300_000);
    expect(config.logLevel).toBe("info");
  });

  test("never reads process.env — only the injected env record is consulted", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INSTANCE_ID", "process-env-instance");
    vi.stubEnv("DATABASE_URL", "postgres://process-env-user:pw@process-env-host/db");

    const config = loadConfig(VALID_ENV);

    expect(config.env).toBe("development");
    expect(config.instanceId).toBe("local-dev");
    expect(config.db.url).toBe("postgres://ekw:ekw@localhost:5432/ekw");
  });
});

describe("loadConfig — each missing required key", () => {
  const REQUIRED_KEYS = [
    { key: "INSTANCE_ID" as const, code: "config.invalidInstanceId" },
    { key: "DATABASE_URL" as const, code: "config.invalidDbUrl" },
    { key: "COLLAB_WS_URL" as const, code: "config.invalidCollabWsUrl" },
    { key: "GIT_SYNC_REPO_PATH" as const, code: "config.invalidGitSyncRepoPath" },
  ];

  test.each(REQUIRED_KEYS)("throws ConfigError($code) when $key is missing", ({ key, code }) => {
    const env = withoutKey(key);
    const err = expectConfigError(() => loadConfig(env), code);
    expect(err.details).toEqual({
      keys: [key],
      issues: [{ key, message: expect.any(String) }],
    });
  });

  test("reports every offending key, ordered, when several required keys are missing", () => {
    const env = withoutKey("DATABASE_URL");
    delete env["INSTANCE_ID"];

    const err = expectConfigError(() => loadConfig(env), "config.invalidInstanceId");
    expect(err.details["keys"]).toEqual(["INSTANCE_ID", "DATABASE_URL"]);
  });
});

describe("loadConfig — malformed fields", () => {
  test("rejects an unknown NODE_ENV value", () => {
    expectConfigError(() => loadConfig(withOverride({ NODE_ENV: "staging" })), "config.invalidEnv");
  });

  test("rejects a non-numeric PORT", () => {
    expectConfigError(() => loadConfig(withOverride({ PORT: "not-a-number" })), "config.invalidPort");
  });

  test("rejects a non-positive PORT", () => {
    expectConfigError(() => loadConfig(withOverride({ PORT: "-1" })), "config.invalidPort");
  });

  test("rejects a DATABASE_URL that is not a URL at all", () => {
    expectConfigError(() => loadConfig(withOverride({ DATABASE_URL: "not-a-url" })), "config.invalidDbUrl");
  });

  test("rejects a DATABASE_URL with the wrong protocol", () => {
    expectConfigError(
      () => loadConfig(withOverride({ DATABASE_URL: "mysql://ekw:ekw@localhost:3306/ekw" })),
      "config.invalidDbUrl",
    );
  });

  test("accepts a postgresql:// scheme, not only postgres://", () => {
    const config = loadConfig(withOverride({ DATABASE_URL: "postgresql://ekw:ekw@localhost:5432/ekw" }));
    expect(config.db.url).toBe("postgresql://ekw:ekw@localhost:5432/ekw");
  });

  test("rejects poolMax of 1 (below the minimum of 2)", () => {
    expectConfigError(() => loadConfig(withOverride({ DB_POOL_MAX: "1" })), "config.invalidPoolMax");
  });

  test("accepts poolMax of 2 (the minimum)", () => {
    const config = loadConfig(withOverride({ DB_POOL_MAX: "2" }));
    expect(config.db.poolMax).toBe(2);
  });

  test("rejects a non-boolean DB_SSL value", () => {
    expectConfigError(() => loadConfig(withOverride({ DB_SSL: "yes" })), "config.invalidDbSsl");
  });

  test("rejects a non-boolean DB_AUTO_MIGRATE value", () => {
    expectConfigError(
      () => loadConfig(withOverride({ DB_AUTO_MIGRATE: "yes" })),
      "config.invalidDbAutoMigrate",
    );
  });

  test("rejects a COLLAB_WS_URL with the wrong protocol", () => {
    expectConfigError(
      () => loadConfig(withOverride({ COLLAB_WS_URL: "http://localhost:1234" })),
      "config.invalidCollabWsUrl",
    );
  });

  test("rejects a non-positive COLLAB_WS_PORT", () => {
    expectConfigError(() => loadConfig(withOverride({ COLLAB_WS_PORT: "0" })), "config.invalidCollabPort");
  });

  test("rejects an empty GIT_SYNC_REPO_PATH", () => {
    expectConfigError(() => loadConfig(withOverride({ GIT_SYNC_REPO_PATH: "   " })), "config.invalidGitSyncRepoPath");
  });

  test("rejects an empty GIT_SYNC_BRANCH", () => {
    expectConfigError(() => loadConfig(withOverride({ GIT_SYNC_BRANCH: "" })), "config.invalidGitSyncBranch");
  });

  test("rejects a GIT_SYNC_INTERVAL_MS below the 1000ms minimum", () => {
    expectConfigError(
      () => loadConfig(withOverride({ GIT_SYNC_INTERVAL_MS: "500" })),
      "config.invalidGitSyncIntervalMs",
    );
  });

  test("rejects an unknown LOG_LEVEL value", () => {
    expectConfigError(() => loadConfig(withOverride({ LOG_LEVEL: "verbose" })), "config.invalidLogLevel");
  });
});

describe("loadConfig — autoMigrate is permitted only in development", () => {
  test("accepts DB_AUTO_MIGRATE=true when NODE_ENV=development", () => {
    const config = loadConfig(withOverride({ NODE_ENV: "development", DB_AUTO_MIGRATE: "true" }));
    expect(config.db.autoMigrate).toBe(true);
  });

  test("rejects DB_AUTO_MIGRATE=true when NODE_ENV=production", () => {
    const err = expectConfigError(
      () => loadConfig(withOverride({ NODE_ENV: "production", DB_AUTO_MIGRATE: "true" })),
      "config.autoMigrateForbidden",
    );
    expect(err.details).toEqual({ keys: ["DB_AUTO_MIGRATE"], env: "production" });
  });

  test("rejects DB_AUTO_MIGRATE=true when NODE_ENV=test", () => {
    expectConfigError(
      () => loadConfig(withOverride({ NODE_ENV: "test", DB_AUTO_MIGRATE: "true" })),
      "config.autoMigrateForbidden",
    );
  });

  test("accepts DB_AUTO_MIGRATE=false in production", () => {
    const config = loadConfig(withOverride({ NODE_ENV: "production", DB_AUTO_MIGRATE: "false" }));
    expect(config.db.autoMigrate).toBe(false);
  });
});
