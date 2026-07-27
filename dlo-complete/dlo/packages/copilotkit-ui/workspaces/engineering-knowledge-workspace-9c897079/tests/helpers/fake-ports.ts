// tests/helpers/fake-ports.ts — the in-memory Ports every later module's tests inject instead of
// touching Postgres, the real clock, real ids, a real logger, the real filesystem, or a real git
// binary (Database.md "Unit-test fixtures": "No unit test touches PostgreSQL. This is a hard
// rule, and it is why the Db port exists.").
//
// `createFakeDb` is a scriptable matcher, not a mock of `pg`: tests register `sql -> rows`
// expectations with `.when`/`.whenError` and assert on `.calls`. An unstubbed query throws
// immediately — a silently-empty result would hide a missing expectation as a false green.
// `withTransaction` runs `fn` against a child `FakeDb` that shares the parent's `calls` and
// `expectations` arrays and records "commit" or "rollback" per call — including nested ones — on
// `.transactions`, so rollback-on-error is directly assertable without inspecting SQL text.
import { relative, resolve } from "node:path";
import { NotFoundError, ValidationError } from "../../src/core/errors";
import type {
  Clock,
  Db,
  FsPort,
  GitPort,
  IdGenerator,
  Isolation,
  Logger,
  Ports,
} from "../../src/server/ports";

// ---------------------------------------------------------------------------
// createFakeDb
// ---------------------------------------------------------------------------

export interface FakeDbCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface FakeDbTransaction {
  readonly depth: number;
  readonly opts: { isolation?: Isolation; readOnly?: boolean } | undefined;
  outcome: "commit" | "rollback";
}

export interface FakeDbResponse<TRow = Record<string, unknown>> {
  readonly rows?: TRow[];
  readonly rowCount?: number;
}

type Matcher = string | RegExp;

interface RowsExpectation {
  readonly matcher: Matcher;
  readonly kind: "rows";
  readonly respond: (params: readonly unknown[]) => FakeDbResponse;
}

interface ErrorExpectation {
  readonly matcher: Matcher;
  readonly kind: "error";
  readonly error: unknown;
}

type Expectation = RowsExpectation | ErrorExpectation;

interface FakeDbState {
  readonly calls: FakeDbCall[];
  readonly transactions: FakeDbTransaction[];
  readonly expectations: Expectation[];
}

function matches(matcher: Matcher, sql: string): boolean {
  return typeof matcher === "string" ? sql.includes(matcher) : matcher.test(sql);
}

export interface FakeDb extends Db {
  readonly calls: FakeDbCall[];
  readonly transactions: FakeDbTransaction[];
  /** Registers a response for the next (and every subsequent) query matching `matcher`. */
  when(matcher: Matcher, response: FakeDbResponse | ((params: readonly unknown[]) => FakeDbResponse)): void;
  /** Registers an error to throw for the next (and every subsequent) query matching `matcher`. */
  whenError(matcher: Matcher, error: unknown): void;
}

function buildFakeDb(state: FakeDbState, depth: number): FakeDb {
  async function query<TRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: TRow[]; rowCount: number }> {
    state.calls.push({ sql, params });
    const expectation = [...state.expectations].reverse().find((candidate) => matches(candidate.matcher, sql));
    if (!expectation) {
      throw new Error(`FakeDb: no expectation registered for query: ${sql}`);
    }
    if (expectation.kind === "error") {
      throw expectation.error;
    }
    const response = expectation.respond(params);
    const rows = (response.rows ?? []) as TRow[];
    return { rows, rowCount: response.rowCount ?? rows.length };
  }

  async function withTransaction<T>(
    fn: (tx: Db) => Promise<T>,
    opts?: { isolation?: Isolation; readOnly?: boolean },
  ): Promise<T> {
    const record: FakeDbTransaction = { depth: depth + 1, opts, outcome: "rollback" };
    state.transactions.push(record);
    const child = buildFakeDb(state, depth + 1);
    try {
      const result = await fn(child);
      record.outcome = "commit";
      return result;
    } catch (err) {
      record.outcome = "rollback";
      throw err;
    }
  }

  return {
    query,
    withTransaction,
    calls: state.calls,
    transactions: state.transactions,
    when(matcher, response) {
      state.expectations.push({
        matcher,
        kind: "rows",
        respond: typeof response === "function" ? response : () => response,
      });
    },
    whenError(matcher, error) {
      state.expectations.push({ matcher, kind: "error", error });
    },
  };
}

export function createFakeDb(): FakeDb {
  return buildFakeDb({ calls: [], transactions: [], expectations: [] }, 0);
}

// ---------------------------------------------------------------------------
// createFakeClock
// ---------------------------------------------------------------------------

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(date: Date): void;
}

const DEFAULT_FAKE_CLOCK_INSTANT = "2026-01-01T00:00:00.000Z";

export function createFakeClock(initial: Date = new Date(DEFAULT_FAKE_CLOCK_INSTANT)): FakeClock {
  let currentMillis = initial.getTime();
  return {
    now: () => new Date(currentMillis),
    advance: (ms: number) => {
      currentMillis += ms;
    },
    set: (date: Date) => {
      currentMillis = date.getTime();
    },
  };
}

// ---------------------------------------------------------------------------
// createSeqIds
// ---------------------------------------------------------------------------

export interface SeqIds extends IdGenerator {
  readonly issued: readonly string[];
}

/**
 * Issues deterministic, sequential ids shaped like a valid v4 UUID — the same reserved namespace
 * Database.md's dev seed uses (`00000000-0000-4000-8000-0000000000NN`) — so a value from this
 * generator round-trips through `asBundleId`/`asConceptId`/etc. in `src/core/ids.ts`.
 */
export function createSeqIds(): SeqIds {
  const issued: string[] = [];
  let counter = 0;
  return {
    issued,
    uuid: () => {
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      issued.push(id);
      return id;
    },
  };
}

// ---------------------------------------------------------------------------
// createMemoryFs
// ---------------------------------------------------------------------------

export interface MemoryFs extends FsPort {
  readonly files: Map<string, string>;
}

function confine(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith("..")) {
    throw new ValidationError(`path "${path}" escapes the configured root "${root}"`, {
      details: { reason: "fs.pathEscape", root: resolvedRoot, path },
    });
  }
  return resolvedPath;
}

export function createMemoryFs(root = "/workspace"): MemoryFs {
  const files = new Map<string, string>();
  return {
    files,

    async writeFile(path, contents) {
      files.set(confine(root, path), contents);
    },

    async mkdirp() {
      // Directories are implicit in this in-memory model; writeFile materialises any path directly.
    },

    async rm(path) {
      const target = confine(root, path);
      const prefix = `${target}/`;
      for (const key of Array.from(files.keys())) {
        if (key === target || key.startsWith(prefix)) {
          files.delete(key);
        }
      }
    },

    async readFile(path) {
      const target = confine(root, path);
      const contents = files.get(target);
      if (contents === undefined) {
        throw new NotFoundError(`file not found: ${path}`, { details: { path: target } });
      }
      return contents;
    },
  };
}

// ---------------------------------------------------------------------------
// createFakeGit
// ---------------------------------------------------------------------------

export interface FakeGitCall {
  readonly method: "status" | "add" | "commit" | "push";
  readonly repoDir: string;
  readonly args: readonly unknown[];
}

export interface FakeGitCommit {
  readonly repoDir: string;
  readonly message: string;
  readonly author: { name: string; email: string };
  readonly sha: string;
}

export interface FakeGit extends GitPort {
  readonly calls: FakeGitCall[];
  readonly commits: FakeGitCommit[];
  setStatus(repoDir: string, status: { dirty: boolean; files: readonly string[] }): void;
  /** The next `push()` call rejects with `error`; every call after that succeeds again. */
  failNextPush(error: unknown): void;
}

export function createFakeGit(): FakeGit {
  const calls: FakeGitCall[] = [];
  const commits: FakeGitCommit[] = [];
  const statuses = new Map<string, { dirty: boolean; files: readonly string[] }>();
  let pendingPushFailure: { error: unknown } | undefined;
  let shaCounter = 0;

  return {
    calls,
    commits,

    setStatus(repoDir, status) {
      statuses.set(repoDir, status);
    },

    failNextPush(error) {
      pendingPushFailure = { error };
    },

    async status(repoDir) {
      calls.push({ method: "status", repoDir, args: [] });
      return statuses.get(repoDir) ?? { dirty: false, files: [] };
    },

    async add(repoDir, paths) {
      calls.push({ method: "add", repoDir, args: [paths] });
    },

    async commit(repoDir, message, author) {
      calls.push({ method: "commit", repoDir, args: [message, author] });
      shaCounter += 1;
      const sha = `fakesha${String(shaCounter).padStart(4, "0")}`;
      commits.push({ repoDir, message, author, sha });
      return { sha };
    },

    async push(repoDir, remote, branch) {
      calls.push({ method: "push", repoDir, args: [remote, branch] });
      if (pendingPushFailure) {
        const { error } = pendingPushFailure;
        pendingPushFailure = undefined;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// createFakePorts
// ---------------------------------------------------------------------------

export interface FakePortsOverrides {
  db?: Db;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  fs?: FsPort;
  git?: GitPort;
}

function createSilentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

export function createFakePorts(overrides: FakePortsOverrides = {}): Ports {
  return {
    db: overrides.db ?? createFakeDb(),
    clock: overrides.clock ?? createFakeClock(),
    ids: overrides.ids ?? createSeqIds(),
    logger: overrides.logger ?? createSilentLogger(),
    fs: overrides.fs ?? createMemoryFs(),
    git: overrides.git ?? createFakeGit(),
  };
}
