// src/server/ports.ts — the only four things in this codebase that touch the outside world
// (Architecture.md "Central Orchestrator" rule 4: "Nothing above the orchestrator knows about
// `pg`, `ws`, `child_process`, `fs`, or `Date`."). Every repository, module and service depends on
// these interfaces, never on the adapters in `src/server/adapters/` that implement them — that is
// what makes the rest of the codebase's tests hermetic. The orchestrator (a later module) is the
// only place allowed to construct an adapter and assemble a `Ports`; everywhere else receives one
// by injection.
//
// `Db.withTransaction` is the one non-obvious contract here: a nested call (one made from inside
// an already-running `fn`) must reuse the *same* physical connection and open a `SAVEPOINT` rather
// than a new `BEGIN`, per Database.md ("Nested calls reuse the same connection and open a
// SAVEPOINT"). `isolation`/`readOnly` are meaningful only for the outermost call — PostgreSQL
// fixes them for the life of the transaction — so the adapter rejects a nested call that supplies
// either rather than silently ignoring them.

/** The three PostgreSQL transaction isolation levels this codebase ever requests explicitly. */
export type Isolation = "read committed" | "repeatable read" | "serializable";

export interface Db {
  /**
   * Parameterised query. `sql` must contain only `$1`..`$n` placeholders; string interpolation
   * of values is a review-blocking defect. `pg-db.ts`'s adapter enforces this at runtime too.
   */
  query<TRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: TRow[]; rowCount: number }>;

  /**
   * Runs `fn` inside a transaction on a single pinned connection. Commits on resolve, rolls back
   * on reject (rethrowing the original error unchanged), and always releases the connection.
   * Nested calls reuse the same connection and open a `SAVEPOINT` instead of a new `BEGIN`; a
   * nested call that supplies `opts` throws, since isolation/read-only can only be requested once,
   * on the outermost call.
   */
  withTransaction<T>(
    fn: (tx: Db) => Promise<T>,
    opts?: { isolation?: Isolation; readOnly?: boolean },
  ): Promise<T>;
}

/** The wall clock, injected so every caller of `now()` is deterministic under test. */
export interface Clock {
  now(): Date;
}

/** Id generation, injected so every caller of `uuid()` is deterministic under test. */
export interface IdGenerator {
  uuid(): string;
}

/** Structured logging. `child` returns a new {@link Logger} that merges `fields` into every line. */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/**
 * Filesystem access confined to a single root directory (the Git-sync worker's
 * `config.gitSync.repoPath`). Every implementation must reject a `path` that resolves outside
 * that root before performing any I/O.
 */
export interface FsPort {
  writeFile(path: string, contents: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

/** Git operations against a working tree at `repoDir`, used only by the Git-sync worker. */
export interface GitPort {
  status(repoDir: string): Promise<{ dirty: boolean; files: readonly string[] }>;
  add(repoDir: string, paths: readonly string[]): Promise<void>;
  commit(repoDir: string, message: string, author: { name: string; email: string }): Promise<{ sha: string }>;
  push(repoDir: string, remote: string, branch: string): Promise<void>;
}

/** Every side-effecting dependency the orchestrator assembles once and injects everywhere. */
export interface Ports {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly fs: FsPort;
  readonly git: GitPort;
}
