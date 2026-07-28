// src/modules/git-sync/git-sync-module.ts — the Git-sync worker (Implementation.md m14;
// Architecture.md "10. GitSyncModule"). `syncBundle` is the whole run: opens one `repeatable
// read`, `readOnly` transaction to read a consistent snapshot of the bundle (concepts +
// documents + frontmatter, mirroring Database.md Query Pattern 5) and the previous run's file
// state, hands the snapshot to the pure `planExport` (exporter.ts), diffs the plan against that
// baseline by content hash, writes only the created/updated files and removes the deleted ones
// through `FsPort`, stages the touched paths and asks `GitPort.status` whether the working tree
// is actually dirty, and only then resolves the remote's credential env var, commits and pushes.
// A run that touches nothing (our own diff shows no changes, or Git itself reports a clean tree)
// is recorded `skipped` and never calls `git.add`/`commit`/`push`. Every step after the run row
// is inserted is wrapped in one try/catch: on any failure the run row is updated to `failed` with
// a redacted `error_message` and a `GitSyncError` (Architecture.md "Errors": `code = "git_sync"`,
// carrying a `stage` detail) is rethrown — never swallowed.
//
// `GitSyncError` is declared here, not in `src/core/errors.ts`: Architecture.md's own sketch
// places it in `core`, but this module's file list does not include `core/errors.ts`, and that
// file is owned by module m3. Subclassing the exported `AppError` from this file is the
// non-invasive way to honour the documented shape without touching a file this module does not
// own.
//
// Like `hierarchy-repository.ts` (m10) and `document-repository.ts` (m11), this module reads
// `concepts`/`concept_documents`/`concept_frontmatter` directly by SQL rather than depending on
// the `concepts`/`hierarchy`/`documents` modules — Implementation.md's "Depends on. m5, m8, m10,
// m11" names build-order file dependencies, not a `ModuleDescriptor.dependsOn` edge; modules never
// import each other directly (see `collab/index.ts`'s header), and this file's `dependsOn` is `[]`.
//
// Scheduling never uses a module-scope `setInterval`: `GitSyncTimer` is injected (defaulting to
// the real `setInterval`/`clearInterval`), mirroring `src/server/collab-server.ts`'s
// `CollabServerTimer` — so `start()`/`stop()` are deterministic under a fake timer in tests.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Connection, ConnectionArgs, ConnectionRow } from "../../core/connection";
import { buildConnection } from "../../core/connection";
import type { RequestContext } from "../../core/context";
import { createRequestContext } from "../../core/context";
import { AppError, ConfigError, NotFoundError, ValidationError, type AppErrorOptions } from "../../core/errors";
import type { BundleId } from "../../core/ids";
import { asActorId, asBundleId } from "../../core/ids";
import type { Lifecycle, TrustLevel } from "../../core/types";
import { okfProvenanceSchema, type OkfFrontmatter, type OkfProvenance } from "../../core/okf/schema";
import type { Clock, Db, FsPort, GitPort, IdGenerator, Logger } from "../../server/ports";
import { exportedFilePath, planExport, type ExportConcept, type ExportConceptInput, type ExportFile } from "./exporter";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface GitSyncErrorOptions extends AppErrorOptions {
  readonly stage: "snapshot" | "write" | "credential" | "commit" | "push" | "record";
}

/** Architecture.md "Errors": `export class GitSyncError extends AppError { readonly code = "git_sync"; }`. */
export class GitSyncError extends AppError {
  readonly code = "git_sync";
  readonly httpStatus = 500;

  constructor(message: string, options: GitSyncErrorOptions) {
    const { stage, ...rest } = options;
    super(message, { ...rest, details: { ...(rest.details ?? {}), stage } });
  }
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Database.md `git_sync_trigger` enum, verbatim. */
export type GitSyncTrigger = "schedule" | "manual" | "startup";

/** Database.md `git_sync_status` enum, verbatim. */
export type GitSyncRunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/** Database.md `git_file_action` enum, verbatim. */
export type GitFileAction = "created" | "updated" | "deleted" | "unchanged";

export interface GitSyncRun extends ConnectionRow {
  readonly id: string;
  readonly sortKey: string;
  readonly remoteId: string;
  readonly bundleId: BundleId;
  readonly status: GitSyncRunStatus;
  readonly trigger: GitSyncTrigger;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly commitSha: string | null;
  readonly filesWritten: number;
  readonly filesDeleted: number;
  readonly filesUnchanged: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Injected timer (never a module-scope setInterval)
// ---------------------------------------------------------------------------

export type GitSyncTimerHandle = ReturnType<typeof setInterval>;

export interface GitSyncTimer {
  setInterval(handler: () => void, delayMs: number): GitSyncTimerHandle;
  clearInterval(handle: GitSyncTimerHandle): void;
}

const defaultTimer: GitSyncTimer = {
  setInterval: (handler, delayMs) => setInterval(handler, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

// ---------------------------------------------------------------------------
// Module interface
// ---------------------------------------------------------------------------

export interface GitSyncModule {
  /**
   * Full run: read bundle → plan → write → add → commit → push. Throws
   * `NotFoundError('gitSync.remoteNotFound')` when the bundle has no configured `git_remotes` row,
   * and `GitSyncError` (`details.stage`) for every failure after the run row is created — the
   * failure is always recorded on the run row before the error is rethrown.
   */
  syncBundle(ctx: RequestContext, bundleId: BundleId, trigger?: GitSyncTrigger): Promise<GitSyncRun>;
  /** Run history for a bundle, most recent first. */
  runs(bundleId: BundleId, args: ConnectionArgs): Promise<Connection<GitSyncRun>>;
  /** Idempotent: a second call while already started is a no-op. */
  start(): void;
  /** Idempotent: a call while not started is a no-op. */
  stop(): void;
}

export interface CreateGitSyncModuleDeps {
  readonly db: Db;
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** `config.gitSync.repoPath` — the working tree `GitPort` operates on. */
  readonly repoDir: string;
  /** `config.gitSync.intervalMs` — how often `start()` polls for due remotes. */
  readonly intervalMs: number;
  readonly timer?: GitSyncTimer;
  /**
   * Resolves a `git_remotes.credential_ref` environment-variable name to its value. Defaults to
   * `process.env`. Injected so a missing/present credential is deterministic under test —
   * Database.md `git_remotes.credential_ref`: "an unset variable fails the run with
   * `ConfigError('git.credentialMissing')`", resolved "in the worker process at commit time".
   */
  readonly readEnv?: (name: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

const REMOTE_COLUMNS =
  "id, bundle_id, repo_url, branch, subdirectory, credential_ref, commit_author_name, commit_author_email, sync_interval_seconds";

interface RemoteRow {
  readonly id: string;
  readonly bundle_id: string;
  readonly repo_url: string;
  readonly branch: string;
  readonly subdirectory: string;
  readonly credential_ref: string;
  readonly commit_author_name: string;
  readonly commit_author_email: string;
  readonly sync_interval_seconds: number;
}

interface ConceptExportRow {
  readonly id: string;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly is_index: boolean;
  readonly child_count: number;
  readonly body_markdown: string;
  readonly trust: string;
  readonly lifecycle: string;
  readonly provenance: unknown;
  readonly tags: readonly string[];
  readonly extra: unknown;
  readonly frontmatter_updated_at: Date | string;
}

interface BaselineFileRow {
  readonly file_path: string;
  readonly concept_id: string | null;
  readonly content_sha256: string;
}

interface GitSyncRunRow {
  readonly id: string;
  readonly remote_id: string;
  readonly bundle_id: string;
  readonly status: GitSyncRunStatus;
  readonly trigger: GitSyncTrigger;
  readonly started_at: Date | string;
  readonly finished_at: Date | string | null;
  readonly commit_sha: string | null;
  readonly files_written: number;
  readonly files_deleted: number;
  readonly files_unchanged: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
}

// ---------------------------------------------------------------------------
// DB ↔ OKF frontmatter translation
// ---------------------------------------------------------------------------

/** `trust_level` uses underscores; the OKF domain `TrustLevel` union uses hyphens (bundle-module.ts's own mismatch, repeated here because modules never import each other's private maps). */
const DB_TRUST_TO_OKF: Readonly<Record<string, TrustLevel>> = {
  unverified: "unverified",
  machine_confirmed: "machine-confirmed",
  human_reviewed: "human-reviewed",
};

/** Throws `ValidationError('gitSync.corruptTrust')` for a value outside the `trust_level` enum. */
function trustFromDb(value: string): TrustLevel {
  const mapped = DB_TRUST_TO_OKF[value];
  if (mapped === undefined) {
    throw new ValidationError("gitSync.corruptTrust", { details: { value } });
  }
  return mapped;
}

/**
 * `lifecycle_state` has five states (draft/review/published/deprecated/archived); the OKF domain
 * `Lifecycle` union has four (core/types.ts's own documented mismatch). `review` collapses onto
 * `draft` (still pre-publication, not yet authoritative) and `published` onto `active` (the live
 * state) — a deliberate, lossy, one-way export mapping.
 */
const DB_LIFECYCLE_TO_OKF: Readonly<Record<string, Lifecycle>> = {
  draft: "draft",
  review: "draft",
  published: "active",
  deprecated: "deprecated",
  archived: "archived",
};

/** Throws `ValidationError('gitSync.corruptLifecycle')` for a value outside the `lifecycle_state` enum. */
function lifecycleFromDb(value: string): Lifecycle {
  const mapped = DB_LIFECYCLE_TO_OKF[value];
  if (mapped === undefined) {
    throw new ValidationError("gitSync.corruptLifecycle", { details: { value } });
  }
  return mapped;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the OKF `provenance` block from `concept_frontmatter.provenance`. An empty/absent value
 * (every concept authored directly in the editor — only an OKF import populates this column)
 * defaults to a self-attributed provenance rather than failing the whole export over a concept
 * nobody imported. A non-empty value that does not match `okfProvenanceSchema` is genuinely
 * corrupt data and throws `ValidationError('gitSync.corruptProvenance')` — it is never silently
 * discarded.
 */
function provenanceFromRow(row: Pick<ConceptExportRow, "provenance" | "frontmatter_updated_at">): OkfProvenance {
  const raw = row.provenance;
  const isEmpty = isPlainObject(raw) && Object.keys(raw).length === 0;
  if (raw === null || raw === undefined || isEmpty) {
    return { source: "editor", author: "editor", retrievedAt: toIso(row.frontmatter_updated_at) };
  }
  const parsed = okfProvenanceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("gitSync.corruptProvenance", {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
  return parsed.data;
}

/**
 * Reassembles `OkfFrontmatter` from a `ConceptExportRow`. `links` is always `[]`:
 * `concept_frontmatter` has no `links` column (cross-links live in the body Markdown and are
 * rewritten by `link-rewriter.ts`, not declared in frontmatter) — see Database.md
 * `concept_frontmatter`. `extra`'s keys are spread first so the modelled fields always win a
 * collision, though by `extra`'s own definition ("every frontmatter key the app does not model")
 * one should never occur.
 */
function buildFrontmatter(row: ConceptExportRow): OkfFrontmatter {
  const extra = isPlainObject(row.extra) ? row.extra : {};
  return {
    ...extra,
    id: row.id,
    title: row.title,
    trust: trustFromDb(row.trust),
    lifecycle: lifecycleFromDb(row.lifecycle),
    provenance: provenanceFromRow(row),
    tags: [...row.tags],
    links: [],
    updatedAt: toIso(row.frontmatter_updated_at),
  } as OkfFrontmatter;
}

function toExportConcept(row: ConceptExportRow): ExportConcept {
  return { id: row.id, slug: row.slug, path: row.path, isIndex: row.is_index, childCount: row.child_count };
}

function toExportInput(row: ConceptExportRow): ExportConceptInput {
  return { concept: toExportConcept(row), frontmatter: buildFrontmatter(row), bodyMarkdown: row.body_markdown };
}

// ---------------------------------------------------------------------------
// Diffing against the previous run's recorded file state
// ---------------------------------------------------------------------------

interface FileChange {
  readonly path: string;
  readonly action: GitFileAction;
  readonly conceptId: string | null;
  readonly contentSha256: string | null;
  readonly byteSize: number;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Classifies every file in `files` against `baseline` (the previous succeeded run's recorded,
 * non-deleted files) by content hash, and reports any baseline path missing from `files` as
 * `deleted`. Pure and deterministic — the only non-determinism (`sha256`) is over `file.contents`,
 * not over anything time- or id-derived.
 */
function diffFiles(
  files: readonly ExportFile[],
  conceptIdByPath: ReadonlyMap<string, string>,
  baseline: readonly BaselineFileRow[],
): readonly FileChange[] {
  const baselineByPath = new Map(baseline.map((row) => [row.file_path, row]));
  const currentPaths = new Set(files.map((file) => file.path));
  const changes: FileChange[] = [];

  for (const file of files) {
    const contentSha256 = sha256(file.contents);
    const conceptId = conceptIdByPath.get(file.path) ?? null;
    const byteSize = Buffer.byteLength(file.contents, "utf8");
    const previous = baselineByPath.get(file.path);
    const action: GitFileAction =
      previous === undefined ? "created" : previous.content_sha256 !== contentSha256 ? "updated" : "unchanged";
    changes.push({ path: file.path, action, conceptId, contentSha256, byteSize });
  }

  for (const previous of baseline) {
    if (!currentPaths.has(previous.file_path)) {
      changes.push({
        path: previous.file_path,
        action: "deleted",
        conceptId: previous.concept_id,
        contentSha256: null,
        byteSize: 0,
      });
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Module implementation
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000000";

function systemContext(): RequestContext {
  return createRequestContext({
    requestId: "git-sync-scheduler",
    actor: { id: asActorId(SYSTEM_ACTOR_ID), email: "git-sync@system.local", displayName: "Git Sync Scheduler" },
  });
}

export function createGitSyncModule(deps: CreateGitSyncModuleDeps): GitSyncModule {
  const { db, fs, git, clock, ids, logger, repoDir } = deps;
  const timer = deps.timer ?? defaultTimer;
  const readEnv = deps.readEnv ?? ((name: string) => process.env[name]);

  let timerHandle: GitSyncTimerHandle | null = null;

  async function loadRemote(bundleId: BundleId): Promise<RemoteRow> {
    const result = await db.query<RemoteRow>(`SELECT ${REMOTE_COLUMNS} FROM git_remotes WHERE bundle_id = $1`, [
      bundleId,
    ]);
    const remote = result.rows[0];
    if (remote === undefined) {
      throw new NotFoundError("gitSync.remoteNotFound", { details: { bundleId } });
    }
    return remote;
  }

  async function loadBaseline(tx: Db, remoteId: string): Promise<readonly BaselineFileRow[]> {
    const lastRun = await tx.query<{ id: string }>(
      `SELECT id FROM git_sync_runs
        WHERE remote_id = $1 AND status = 'succeeded'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
      [remoteId],
    );
    const runId = lastRun.rows[0]?.id;
    if (runId === undefined) {
      return [];
    }
    const files = await tx.query<BaselineFileRow>(
      `SELECT file_path, concept_id, content_sha256
         FROM git_sync_files
        WHERE run_id = $1 AND action != 'deleted'`,
      [runId],
    );
    return files.rows;
  }

  async function loadSnapshot(tx: Db, bundleId: BundleId): Promise<readonly ConceptExportRow[]> {
    const result = await tx.query<ConceptExportRow>(
      `SELECT c.id, c.slug, c.path, c.title, c.is_index, c.child_count,
              d.body_markdown,
              f.trust, f.lifecycle, f.provenance, f.tags, f.extra, f.updated_at AS frontmatter_updated_at
         FROM concepts c
         JOIN concept_documents d ON d.concept_id = c.id
         JOIN concept_frontmatter f ON f.concept_id = c.id
        WHERE c.bundle_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.path`,
      [bundleId],
    );
    return result.rows;
  }

  function mapRunRow(row: GitSyncRunRow): GitSyncRun {
    return {
      id: row.id,
      sortKey: toIso(row.started_at),
      remoteId: row.remote_id,
      bundleId: asBundleId(row.bundle_id),
      status: row.status,
      trigger: row.trigger,
      startedAt: toIso(row.started_at),
      finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
      commitSha: row.commit_sha,
      filesWritten: row.files_written,
      filesDeleted: row.files_deleted,
      filesUnchanged: row.files_unchanged,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    };
  }

  async function writeChanges(changes: readonly FileChange[], filesByPath: ReadonlyMap<string, ExportFile>): Promise<void> {
    for (const change of changes) {
      if (change.action === "created" || change.action === "updated") {
        // `change.path` always comes from `plan.files` (see `diffFiles`), so it is always a key here.
        const file = filesByPath.get(change.path)!;
        const dir = posix.dirname(change.path);
        if (dir !== ".") {
          await fs.mkdirp(dir);
        }
        await fs.writeFile(change.path, file.contents);
      } else if (change.action === "deleted") {
        await fs.rm(change.path);
      }
    }
  }

  async function recordFailure(runId: string, stage: GitSyncErrorOptions["stage"], err: unknown, resolvedSecret: string | undefined): Promise<never> {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = resolvedSecret ? rawMessage.split(resolvedSecret).join("[redacted]") : rawMessage;
    const code = err instanceof AppError ? err.code : "internal";
    await db.query(
      `UPDATE git_sync_runs SET status = 'failed', finished_at = $2, error_code = $3, error_message = $4 WHERE id = $1`,
      [runId, clock.now(), code, message],
    );
    throw new GitSyncError(message, { stage, cause: err });
  }

  async function syncBundle(ctx: RequestContext, bundleId: BundleId, trigger: GitSyncTrigger = "manual"): Promise<GitSyncRun> {
    const log = logger.child({ module: "git-sync", requestId: ctx.requestId, bundleId });
    const remote = await loadRemote(bundleId);

    const runId = ids.uuid();
    const startedAt = clock.now();
    await db.query(
      `INSERT INTO git_sync_runs (id, remote_id, bundle_id, status, trigger, started_at)
       VALUES ($1, $2, $3, 'running', $4, $5)`,
      [runId, remote.id, bundleId, trigger, startedAt],
    );

    let resolvedSecret: string | undefined;
    let stage: GitSyncErrorOptions["stage"] = "snapshot";

    try {
      const { rows, baseline } = await db.withTransaction(
        async (tx) => {
          const rows = await loadSnapshot(tx, bundleId);
          const baseline = await loadBaseline(tx, remote.id);
          return { rows, baseline };
        },
        { isolation: "repeatable read", readOnly: true },
      );

      const plan = planExport(rows.map(toExportInput));
      if (plan.brokenLinks.length > 0) {
        log.warn("gitSync.brokenLinks", { count: plan.brokenLinks.length, links: plan.brokenLinks });
      }

      const conceptIdByPath = new Map(rows.map((row) => [exportedFilePath(toExportConcept(row)), row.id]));
      const changes = diffFiles(plan.files, conceptIdByPath, baseline);
      const filesByPath = new Map(plan.files.map((file) => [file.path, file] as const));

      const touched = changes.filter((change) => change.action !== "unchanged");
      const unchangedCount = changes.length - touched.length;

      if (touched.length === 0) {
        const finishedAt = clock.now();
        await db.query(
          `UPDATE git_sync_runs
              SET status = 'skipped', finished_at = $2, files_written = 0, files_deleted = 0, files_unchanged = $3
            WHERE id = $1`,
          [runId, finishedAt, unchangedCount],
        );
        return {
          id: runId,
          sortKey: toIso(startedAt),
          remoteId: remote.id,
          bundleId,
          status: "skipped",
          trigger,
          startedAt: toIso(startedAt),
          finishedAt: toIso(finishedAt),
          commitSha: null,
          filesWritten: 0,
          filesDeleted: 0,
          filesUnchanged: unchangedCount,
          errorCode: null,
          errorMessage: null,
        };
      }

      stage = "write";
      await writeChanges(touched, filesByPath);

      stage = "commit";
      await git.add(repoDir, touched.map((change) => change.path));
      const status = await git.status(repoDir);

      const created = touched.filter((c) => c.action === "created").length;
      const updated = touched.filter((c) => c.action === "updated").length;
      const deleted = touched.filter((c) => c.action === "deleted").length;

      if (!status.dirty) {
        const finishedAt = clock.now();
        await db.query(
          `UPDATE git_sync_runs
              SET status = 'skipped', finished_at = $2, files_written = $3, files_deleted = $4, files_unchanged = $5
            WHERE id = $1`,
          [runId, finishedAt, created + updated, deleted, unchangedCount],
        );
        return {
          id: runId,
          sortKey: toIso(startedAt),
          remoteId: remote.id,
          bundleId,
          status: "skipped",
          trigger,
          startedAt: toIso(startedAt),
          finishedAt: toIso(finishedAt),
          commitSha: null,
          filesWritten: created + updated,
          filesDeleted: deleted,
          filesUnchanged: unchangedCount,
          errorCode: null,
          errorMessage: null,
        };
      }

      stage = "credential";
      const credential = readEnv(remote.credential_ref);
      if (credential === undefined || credential.length === 0) {
        throw new ConfigError(
          "git.credentialMissing",
          `git credential environment variable "${remote.credential_ref}" is not set`,
          { details: { credentialRef: remote.credential_ref } },
        );
      }
      resolvedSecret = credential;

      stage = "commit";
      const message = `git-sync: ${created} created, ${updated} updated, ${deleted} deleted`;
      const commit = await git.commit(repoDir, message, {
        name: remote.commit_author_name,
        email: remote.commit_author_email,
      });

      stage = "push";
      await git.push(repoDir, "origin", remote.branch);

      stage = "record";
      const finishedAt = clock.now();
      await db.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE git_sync_runs
              SET status = 'succeeded', finished_at = $2, commit_sha = $3,
                  files_written = $4, files_deleted = $5, files_unchanged = $6
            WHERE id = $1`,
          [runId, finishedAt, commit.sha, created + updated, deleted, unchangedCount],
        );
        for (const change of changes) {
          await tx.query(
            `INSERT INTO git_sync_files (run_id, file_path, concept_id, action, content_sha256, byte_size)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [runId, change.path, change.conceptId, change.action, change.contentSha256, change.byteSize],
          );
        }
        await tx.query(`UPDATE git_remotes SET last_synced_at = $2, last_commit_sha = $3 WHERE id = $1`, [
          remote.id,
          finishedAt,
          commit.sha,
        ]);
      });

      return {
        id: runId,
        sortKey: toIso(startedAt),
        remoteId: remote.id,
        bundleId,
        status: "succeeded",
        trigger,
        startedAt: toIso(startedAt),
        finishedAt: toIso(finishedAt),
        commitSha: commit.sha,
        filesWritten: created + updated,
        filesDeleted: deleted,
        filesUnchanged: unchangedCount,
        errorCode: null,
        errorMessage: null,
      };
    } catch (err) {
      return recordFailure(runId, stage, err, resolvedSecret);
    }
  }

  async function runs(bundleId: BundleId, args: ConnectionArgs): Promise<Connection<GitSyncRun>> {
    const result = await db.query<GitSyncRunRow>(
      `SELECT id, remote_id, bundle_id, status, trigger, started_at, finished_at, commit_sha,
              files_written, files_deleted, files_unchanged, error_code, error_message
         FROM git_sync_runs
        WHERE bundle_id = $1
        ORDER BY started_at DESC, id DESC
        LIMIT 500`,
      [bundleId],
    );
    return buildConnection(result.rows.map(mapRunRow), args);
  }

  async function tick(): Promise<void> {
    const due = await db.query<{ bundle_id: string }>(
      `SELECT bundle_id FROM git_remotes
        WHERE enabled
          AND (last_synced_at IS NULL OR last_synced_at < $1 - make_interval(secs => sync_interval_seconds))`,
      [clock.now()],
    );
    for (const row of due.rows) {
      try {
        await syncBundle(systemContext(), asBundleId(row.bundle_id), "schedule");
      } catch (err) {
        logger.error("gitSync.scheduledSyncFailed", {
          bundleId: row.bundle_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    syncBundle,
    runs,
    start() {
      if (timerHandle !== null) {
        return;
      }
      timerHandle = timer.setInterval(tick, deps.intervalMs);
    },
    stop() {
      if (timerHandle === null) {
        return;
      }
      timer.clearInterval(timerHandle);
      timerHandle = null;
    },
  };
}
