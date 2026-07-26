// src/config/config.ts — the one place environment variables are read (Architecture.md
// "Configuration": "Environment only. Never a config file, never a commit, never a log line.").
// `loadConfig` is pure over its `env` argument — it never touches `process.env` itself, which is
// what lets every other module (and this module's own tests) exercise every branch with a
// literal object instead of mutating the real process environment. Field-level zod issues are
// deliberately re-mapped to a small, stable set of dotted `ConfigError` codes (`config.invalidDbUrl`,
// `config.invalidPoolMax`, …) rather than surfacing zod's own issue codes, because those codes are
// a public contract other modules and the CLI startup banner match against.
import { z } from "zod";
import { ConfigError } from "../core/errors";

export type Env = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

/** The fully validated, immutable application configuration. */
export interface AppConfig {
  readonly env: Env;
  readonly instanceId: string;
  readonly port: number;
  readonly db: Readonly<{
    url: string;
    poolMax: number;
    ssl: boolean;
    autoMigrate: boolean;
  }>;
  readonly collab: Readonly<{
    wsUrl: string;
    port: number;
  }>;
  readonly gitSync: Readonly<{
    repoPath: string;
    branch: string;
    intervalMs: number;
  }>;
  readonly logLevel: LogLevel;
}

/** The raw environment map `loadConfig` accepts — a plain record, never `NodeJS.ProcessEnv` itself. */
export type EnvRecord = Record<string, string | undefined>;

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

const RawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  INSTANCE_ID: z.string().trim().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(isPostgresUrl, { message: "must be a postgres:// or postgresql:// URL" }),
  DB_POOL_MAX: z.coerce.number().int().min(2).default(10),
  DB_SSL: z.enum(["true", "false"]).default("false"),
  DB_AUTO_MIGRATE: z.enum(["true", "false"]).default("false"),
  COLLAB_WS_URL: z
    .string()
    .min(1)
    .refine(isWebSocketUrl, { message: "must be a ws:// or wss:// URL" }),
  COLLAB_WS_PORT: z.coerce.number().int().positive().default(1234),
  GIT_SYNC_REPO_PATH: z.string().trim().min(1),
  GIT_SYNC_BRANCH: z.string().trim().min(1).default("main"),
  GIT_SYNC_INTERVAL_MS: z.coerce.number().int().min(1000).default(300_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

type RawEnv = z.infer<typeof RawEnvSchema>;

/**
 * Order controls which code wins when several fields are invalid at once: the first offending
 * field in this list is the one `ConfigError.code`/`message` describe, and every offending field
 * is still reported in `details.keys`, so no failure is silently dropped.
 */
const FIELD_CODES: ReadonlyArray<readonly [keyof RawEnv, string]> = [
  ["NODE_ENV", "config.invalidEnv"],
  ["INSTANCE_ID", "config.invalidInstanceId"],
  ["PORT", "config.invalidPort"],
  ["DATABASE_URL", "config.invalidDbUrl"],
  ["DB_POOL_MAX", "config.invalidPoolMax"],
  ["DB_SSL", "config.invalidDbSsl"],
  ["DB_AUTO_MIGRATE", "config.invalidDbAutoMigrate"],
  ["COLLAB_WS_URL", "config.invalidCollabWsUrl"],
  ["COLLAB_WS_PORT", "config.invalidCollabPort"],
  ["GIT_SYNC_REPO_PATH", "config.invalidGitSyncRepoPath"],
  ["GIT_SYNC_BRANCH", "config.invalidGitSyncBranch"],
  ["GIT_SYNC_INTERVAL_MS", "config.invalidGitSyncIntervalMs"],
  ["LOG_LEVEL", "config.invalidLogLevel"],
];

const CODE_BY_FIELD = new Map(FIELD_CODES);
const FIELD_ORDER = FIELD_CODES.map(([field]) => field);

function throwFromIssues(issues: readonly z.ZodIssue[]): never {
  const offendingFields = Array.from(new Set(issues.map((issue) => String(issue.path[0]))));
  const sortedFields = [...offendingFields].sort(
    (a, b) => FIELD_ORDER.indexOf(a as keyof RawEnv) - FIELD_ORDER.indexOf(b as keyof RawEnv),
  );
  const primaryField = sortedFields[0] as keyof RawEnv | undefined;
  const code = (primaryField && CODE_BY_FIELD.get(primaryField)) ?? "config.invalid";
  const primaryIssue = issues.find((issue) => String(issue.path[0]) === primaryField);
  const message = primaryField
    ? `Invalid configuration for ${primaryField}: ${primaryIssue?.message ?? "invalid value"}`
    : "Invalid configuration";

  throw new ConfigError(code, message, {
    details: {
      keys: sortedFields,
      issues: issues.map((issue) => ({ key: String(issue.path[0]), message: issue.message })),
    },
  });
}

/**
 * Parses and validates `env` into an {@link AppConfig}. Pure: never reads `process.env`, so the
 * caller (the composition root) decides what environment is actually in force, and every branch
 * here is exercisable from a test with a literal object.
 */
export function loadConfig(env: EnvRecord): AppConfig {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throwFromIssues(parsed.error.issues);
  }

  const raw = parsed.data;

  if (raw.DB_AUTO_MIGRATE === "true" && raw.NODE_ENV !== "development") {
    throw new ConfigError(
      "config.autoMigrateForbidden",
      `db.autoMigrate may only be enabled when env is "development" (got "${raw.NODE_ENV}")`,
      { details: { keys: ["DB_AUTO_MIGRATE"], env: raw.NODE_ENV } },
    );
  }

  return Object.freeze({
    env: raw.NODE_ENV,
    instanceId: raw.INSTANCE_ID,
    port: raw.PORT,
    db: Object.freeze({
      url: raw.DATABASE_URL,
      poolMax: raw.DB_POOL_MAX,
      ssl: raw.DB_SSL === "true",
      autoMigrate: raw.DB_AUTO_MIGRATE === "true",
    }),
    collab: Object.freeze({
      wsUrl: raw.COLLAB_WS_URL,
      port: raw.COLLAB_WS_PORT,
    }),
    gitSync: Object.freeze({
      repoPath: raw.GIT_SYNC_REPO_PATH,
      branch: raw.GIT_SYNC_BRANCH,
      intervalMs: raw.GIT_SYNC_INTERVAL_MS,
    }),
    logLevel: raw.LOG_LEVEL,
  });
}
