// src/lib/logger.ts — the hand-rolled structured JSON logger (Architecture.md "Logging": "~60
// lines, injectable, no transport side effects in tests. A dependency here would be larger than
// the code."). `clock` and `sink` are both injected so every call site — including this module's
// own tests — controls time and output instead of touching the real clock or stdout. Redaction
// runs on every field (and on `msg`) unconditionally, not just when a caller remembers to scrub:
// a key named `password`/`token`/`apiKey`/`authorization`/`credentials` is replaced outright, and
// any string anywhere in the payload that embeds `scheme://user:pass@host` credentials (e.g. a
// raw `DATABASE_URL`) has just the userinfo blanked out. Never log `DATABASE_URL`, tokens, or full
// document bodies unredacted — ids and counts only (Architecture.md "Logging").

export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Readonly<Record<Level, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** The clock port: `Date.now`-equivalent, injected so log timestamps are deterministic in tests. */
export interface Clock {
  now(): Date;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a new {@link Logger} that merges `bindings` into every subsequent line's fields. */
  child(bindings: LogFields): Logger;
}

export interface CreateLoggerOptions {
  level: Level;
  clock: Clock;
  /** Receives one already-serialized JSON line per log call. Defaults to `process.stdout.write`. */
  sink?: (line: string) => void;
  /** Bindings merged into every line emitted by this logger (and inherited by its children). */
  base?: LogFields;
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set(["password", "token", "apikey", "authorization", "credentials"]);
const URL_CREDENTIALS_PATTERN = /:\/\/[^/\s:@]+:[^/\s@]+@/g;

function redactUrlCredentials(value: string): string {
  return value.replace(URL_CREDENTIALS_PATTERN, "://[REDACTED]@");
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEYS.has(key.toLowerCase())) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactUrlCredentials(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactValue(v, k);
    }
    return result;
  }
  return value;
}

function redactFields(fields: LogFields): LogFields {
  const result: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    result[k] = redactValue(v, k);
  }
  return result;
}

function defaultSink(line: string): void {
  process.stdout.write(line + "\n");
}

/** Builds a {@link Logger}. See the module header for the redaction and level-filtering rules. */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const sink = opts.sink ?? defaultSink;
  const base = opts.base ?? {};

  const emit = (level: Level, msg: string, fields?: LogFields): void => {
    if (LEVELS[level] < LEVELS[opts.level]) {
      return;
    }
    const merged = redactFields({ ...base, ...(fields ?? {}) });
    const record = {
      ts: opts.clock.now().toISOString(),
      level,
      msg: redactUrlCredentials(msg),
      ...merged,
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bindings) => createLogger({ ...opts, base: { ...base, ...bindings } }),
  };
}
