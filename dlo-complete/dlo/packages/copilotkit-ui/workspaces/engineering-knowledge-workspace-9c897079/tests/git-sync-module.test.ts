// tests/git-sync-module.test.ts — module m14 (git-sync). Exercises the Git-sync worker in
// `src/modules/git-sync/git-sync-module.ts` end to end against the fake `Ports` from
// tests/helpers/fake-ports.ts: a succeeded run (snapshot → plan → write → add → commit → push →
// record), the two distinct "nothing to do" skip paths (our own diff shows no changes; git itself
// reports a clean tree after `add`), `NotFoundError` when a bundle has no `git_remotes` row, a
// missing credential, a `GitPort.push` failure, a path-traversal write rejected by the confined
// `FsPort`, broken-link warnings that do not fail the run, `runs()` history, and the injected
// `GitSyncTimer` driving `start`/`stop`/`tick`. No real Postgres, filesystem, or git process is
// touched anywhere in this file.
import { describe, test, expect, vi } from "vitest";
import {
  createGitSyncModule,
  GitSyncError,
  type CreateGitSyncModuleDeps,
  type GitSyncTimer,
  type GitSyncTimerHandle,
} from "../src/modules/git-sync/git-sync-module";
import { createRequestContext } from "../src/core/context";
import { asActorId, asBundleId } from "../src/core/ids";
import { NotFoundError } from "../src/core/errors";
import {
  createFakeClock,
  createFakeDb,
  createFakeGit,
  createMemoryFs,
  createSeqIds,
} from "./helpers/fake-ports";
import type { Logger } from "../src/server/ports";

const BUNDLE_ID = asBundleId("10000000-0000-4000-8000-000000000001");
const ACTOR_ID = asActorId("20000000-0000-4000-8000-000000000001");
const REMOTE_ID = "30000000-0000-4000-8000-000000000001";
const CONCEPT_ID = "40000000-0000-4000-8000-000000000001";
const REPO_DIR = "/workspace";
const CREDENTIAL_REF = "GIT_SYNC_TOKEN";
const CREDENTIAL_VALUE = "s3cr3t-token-value";

const ctx = createRequestContext({
  requestId: "req-1",
  actor: { id: ACTOR_ID, email: "actor@example.com", displayName: "Actor" },
});

function createSpyLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function makeRemoteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: REMOTE_ID,
    bundle_id: BUNDLE_ID,
    repo_url: "https://github.com/example/okf-bundle.git",
    branch: "main",
    subdirectory: "",
    credential_ref: CREDENTIAL_REF,
    commit_author_name: "Git Sync Bot",
    commit_author_email: "git-sync@example.com",
    sync_interval_seconds: 300,
    ...overrides,
  };
}

function makeConceptRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CONCEPT_ID,
    slug: "getting-started",
    path: "getting-started",
    title: "Getting Started",
    is_index: false,
    child_count: 0,
    body_markdown: "Hello world.",
    trust: "unverified",
    lifecycle: "draft",
    provenance: {},
    tags: [],
    extra: {},
    frontmatter_updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRunRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    remote_id: REMOTE_ID,
    bundle_id: BUNDLE_ID,
    status: "succeeded",
    trigger: "manual",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    commit_sha: "fakesha0001",
    files_written: 1,
    files_deleted: 0,
    files_unchanged: 0,
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

function setup(depsOverrides: Partial<CreateGitSyncModuleDeps> = {}) {
  const db = createFakeDb();
  const fs = createMemoryFs(REPO_DIR);
  const git = createFakeGit();
  const clock = createFakeClock();
  const ids = createSeqIds();
  const logger = createSpyLogger();
  const readEnv = (name: string): string | undefined => (name === CREDENTIAL_REF ? CREDENTIAL_VALUE : undefined);

  const module = createGitSyncModule({
    db,
    fs,
    git,
    clock,
    ids,
    logger,
    repoDir: REPO_DIR,
    intervalMs: 60_000,
    readEnv,
    ...depsOverrides,
  });

  return { module, db, fs, git, clock, ids, logger };
}

function findCall(db: ReturnType<typeof createFakeDb>, substring: string) {
  return db.calls.filter((call) => call.sql.includes(substring));
}

describe("createGitSyncModule.syncBundle — happy path", () => {
  test("writes, commits and pushes a newly created file and records a succeeded run", async () => {
    const { module, db, fs, git } = setup();

    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [makeRemoteRow()] });
    db.when("INSERT INTO git_sync_runs", { rows: [] });
    db.when("AND status = 'succeeded'", { rows: [] });
    db.when("FROM concepts c", { rows: [makeConceptRow()] });
    db.when("SET status = 'succeeded'", { rows: [] });
    db.when("INSERT INTO git_sync_files", { rows: [] });
    db.when("UPDATE git_remotes SET last_synced_at", { rows: [] });
    git.setStatus(REPO_DIR, { dirty: true, files: ["getting-started.md"] });

    const run = await module.syncBundle(ctx, BUNDLE_ID, "manual");

    expect(run.status).toBe("succeeded");
    expect(run.commitSha).toBe("fakesha0001");
    expect(run.filesWritten).toBe(1);
    expect(run.filesDeleted).toBe(0);
    expect(run.filesUnchanged).toBe(0);
    expect(run.errorCode).toBeNull();
    expect(run.errorMessage).toBeNull();

    expect(Array.from(fs.files.values())).toHaveLength(1);
    const written = Array.from(fs.files.values())[0]!;
    expect(written).toContain("title: Getting Started");
    expect(written).toContain("Hello world.");

    expect(git.calls.map((c) => c.method)).toEqual(["add", "status", "commit", "push"]);
    const addCall = git.calls.find((c) => c.method === "add")!;
    expect(addCall.args[0]).toEqual(["getting-started.md"]);
    const commitCall = git.calls.find((c) => c.method === "commit")!;
    expect(commitCall.args[0]).toBe("git-sync: 1 created, 0 updated, 0 deleted");
    expect(commitCall.args[1]).toEqual({ name: "Git Sync Bot", email: "git-sync@example.com" });
    const pushCall = git.calls.find((c) => c.method === "push")!;
    expect(pushCall.args).toEqual(["origin", "main"]);

    expect(db.transactions).toHaveLength(2);
    expect(db.transactions[0]!.opts).toEqual({ isolation: "repeatable read", readOnly: true });
    expect(db.transactions[0]!.outcome).toBe("commit");
    expect(db.transactions[1]!.opts).toBeUndefined();
    expect(db.transactions[1]!.outcome).toBe("commit");

    const fileInsert = findCall(db, "INSERT INTO git_sync_files")[0]!;
    expect(fileInsert.params).toEqual([
      run.id,
      "getting-started.md",
      CONCEPT_ID,
      "created",
      expect.any(String),
      expect.any(Number),
    ]);
  });

  test("logs a warning but still succeeds when the export plan has a broken link", async () => {
    const { module, db, git, logger } = setup();

    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [makeRemoteRow()] });
    db.when("INSERT INTO git_sync_runs", { rows: [] });
    db.when("AND status = 'succeeded'", { rows: [] });
    db.when("FROM concepts c", {
      rows: [makeConceptRow({ body_markdown: "See [ghost](/missing/ghost.md)." })],
    });
    db.when("SET status = 'succeeded'", { rows: [] });
    db.when("INSERT INTO git_sync_files", { rows: [] });
    db.when("UPDATE git_remotes SET last_synced_at", { rows: [] });
    git.setStatus(REPO_DIR, { dirty: true, files: ["getting-started.md"] });

    const run = await module.syncBundle(ctx, BUNDLE_ID, "manual");

    expect(run.status).toBe("succeeded");
    expect(logger.warn).toHaveBeenCalledWith(
      "gitSync.brokenLinks",
      expect.objectContaining({ count: 1 }),
    );
  });
});

describe("createGitSyncModule.syncBundle — no configured remote", () => {
  test("throws NotFoundError('gitSync.remoteNotFound') and never creates a run row", async () => {
    const { module, db } = setup();
    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [] });

    try {
      await module.syncBundle(ctx, BUNDLE_ID, "manual");
      throw new Error("expected syncBundle to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toBe("gitSync.remoteNotFound");
      expect((err as NotFoundError).details["bundleId"]).toBe(BUNDLE_ID);
    }

    expect(findCall(db, "INSERT INTO git_sync_runs")).toHaveLength(0);
  });
});

describe("createGitSyncModule.syncBundle — skipped runs", () => {
  test("an empty bundle with no baseline is recorded skipped with zero files and never calls git", async () => {
    const { module, db, git } = setup();
    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [makeRemoteRow()] });
    db.when("INSERT INTO git_sync_runs", { rows: [] });
    db.when("AND status = 'succeeded'", { rows: [] });
    db.when("FROM concepts c", { rows: [] });
    db.when("SET status = 'skipped'", { rows: [] });

    const run = await module.syncBundle(ctx, BUNDLE_ID, "manual");

    expect(run.status).toBe("skipped");
    expect(run.filesWritten).toBe(0);
    expect(run.filesDeleted).toBe(0);
    expect(run.filesUnchanged).toBe(0);
    expect(run.commitSha).toBeNull();
    expect(git.calls).toHaveLength(0);
    expect(db.transactions).toHaveLength(1);
    expect(db.transactions[0]!.opts).toEqual({ isolation: "repeatable read", readOnly: true });
    expect(findCall(db, "INSERT INTO git_sync_files")).toHaveLength(0);
  });

  test("a diff with changes but a clean working tree after add is skipped without a commit or push", async () => {
    const { module, db, fs, git } = setup();
    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [makeRemoteRow()] });
    db.when("INSERT INTO git_sync_runs", { rows: [] });
    db.when("AND status = 'succeeded'", { rows: [] });
    db.when("FROM concepts c", { rows: [makeConceptRow()] });
    db.when("SET status = 'skipped'", { rows: [] });
    // git.status defaults to { dirty: false, files: [] } — no setStatus call needed.

    const run = await module.syncBundle(ctx, BUNDLE_ID, "manual");

    expect(run.status).toBe("skipped");
    expect(run.filesWritten).toBe(1);
    expect(run.filesDeleted).toBe(0);
    expect(run.commitSha).toBeNull();
    expect(git.calls.map((c) => c.method)).toEqual(["add", "status"]);
    expect(Array.from(fs.files.values())).toHaveLength(1);
  });
});

describe("createGitSyncModule.syncBundle — failure modes", () => {
  test("a missing credential raises a typed GitSyncError at stage 'credential' and records a failed run", async () => {
    const { module, db, git } = setup({ readEnv: () => undefined });
    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [makeRemoteRow()] });
    db.when("INSERT INTO git_sync_runs", { rows: [] });
    db.when("AND status = 'succeeded'", { rows: [] });
    db.when("FROM concepts c", { rows: [makeConceptRow()] });
    db.when("SET status = 'failed'", { rows: [] });
    git.setStatus(REPO_DIR, { dirty: true, files: ["getting-started.md"] });

    try {
      await module.syncBundle(ctx, BUNDLE_ID, "manual");
      throw new Error("expected syncBundle to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitSyncError);
      expect((err as GitSyncError).details["stage"]).toBe("credential");
    }

    expect(git.calls.map((c) => c.method)).toEqual(["add", "status"]);
    const failedUpdate = findCall(db, "SET status = 'failed'")[0]!;
    expect(failedUpdate.params[2]).toBe("git.credentialMissing");
    expect(String(failedUpdate.params[3])).toContain(CREDENTIAL_REF);
  });

  test("a GitPort push failure raises a typed GitSyncError at stage 'push', redacts the credential and records a failed run", async () => {
    const { module, db, git } = setup();
    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [makeRemoteRow()] });
    db.when("INSERT INTO git_sync_runs", { rows: [] });
    db.when("AND status = 'succeeded'", { rows: [] });
    db.when("FROM concepts c", { rows: [makeConceptRow()] });
    db.when("SET status = 'failed'", { rows: [] });
    git.setStatus(REPO_DIR, { dirty: true, files: ["getting-started.md"] });
    git.failNextPush(new Error(`remote rejected: token ${CREDENTIAL_VALUE} is invalid`));

    try {
      await module.syncBundle(ctx, BUNDLE_ID, "manual");
      throw new Error("expected syncBundle to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitSyncError);
      expect((err as GitSyncError).details["stage"]).toBe("push");
    }

    expect(git.calls.map((c) => c.method)).toEqual(["add", "status", "commit", "push"]);
    const failedUpdate = findCall(db, "SET status = 'failed'")[0]!;
    expect(failedUpdate.params[2]).toBe("internal");
    const message = String(failedUpdate.params[3]);
    expect(message).not.toContain(CREDENTIAL_VALUE);
    expect(message).toBe("remote rejected: token [redacted] is invalid");
  });

  test("a path escaping the repo root is rejected by the confined FsPort at stage 'write' and records a failed run", async () => {
    const { module, db, git, fs } = setup();
    db.when("FROM git_remotes WHERE bundle_id = $1", { rows: [makeRemoteRow()] });
    db.when("INSERT INTO git_sync_runs", { rows: [] });
    db.when("AND status = 'succeeded'", { rows: [] });
    db.when("FROM concepts c", {
      rows: [makeConceptRow({ path: "../escape", slug: "escape" })],
    });
    db.when("SET status = 'failed'", { rows: [] });

    try {
      await module.syncBundle(ctx, BUNDLE_ID, "manual");
      throw new Error("expected syncBundle to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitSyncError);
      expect((err as GitSyncError).details["stage"]).toBe("write");
    }

    expect(git.calls).toHaveLength(0);
    expect(fs.files.size).toBe(0);
    const failedUpdate = findCall(db, "SET status = 'failed'")[0]!;
    expect(failedUpdate.params[2]).toBe("validation");
  });
});

describe("createGitSyncModule.runs", () => {
  test("returns the run history mapped from the query's row order", async () => {
    const { module, db } = setup();
    db.when("LIMIT 500", {
      rows: [
        makeRunRow({ id: "r1" }),
        makeRunRow({ id: "r2", status: "failed", commit_sha: null, error_code: "internal", error_message: "boom" }),
      ],
    });

    const connection = await module.runs(BUNDLE_ID, {});

    expect(connection.totalCount).toBe(2);
    expect(connection.edges.map((e) => e.node.id)).toEqual(["r1", "r2"]);
    expect(connection.edges[1]!.node.status).toBe("failed");
    expect(connection.edges[1]!.node.errorCode).toBe("internal");

    const call = findCall(db, "LIMIT 500")[0]!;
    expect(call.params).toEqual([BUNDLE_ID]);
  });
});

describe("createGitSyncModule — start/stop/tick", () => {
  function createFakeTimer() {
    let captured: (() => void) | undefined;
    const setIntervalSpy = vi.fn((handler: () => void) => {
      captured = handler;
      return 1 as unknown as GitSyncTimerHandle;
    });
    const clearIntervalSpy = vi.fn();
    const timer: GitSyncTimer = { setInterval: setIntervalSpy, clearInterval: clearIntervalSpy };
    return { timer, setIntervalSpy, clearIntervalSpy, getHandler: () => captured };
  }

  test("start() schedules exactly one interval even when called twice", () => {
    const { timer, setIntervalSpy } = createFakeTimer();
    const { module } = setup({ timer });

    module.start();
    module.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  test("stop() clears the interval and is a no-op both before start() and after the first stop()", () => {
    const { timer, setIntervalSpy, clearIntervalSpy } = createFakeTimer();
    const { module } = setup({ timer });

    module.stop();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    module.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    module.stop();
    module.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  test("tick() catches a per-remote failure and logs it instead of throwing", async () => {
    const { timer, getHandler } = createFakeTimer();
    const { module, db, logger } = setup({ timer });

    db.when("WHERE enabled", { rows: [{ bundle_id: BUNDLE_ID }] });
    // "FROM git_remotes WHERE bundle_id = $1" is deliberately left unstubbed so loadRemote throws.

    module.start();
    const handler = getHandler()!;

    await expect(handler()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "gitSync.scheduledSyncFailed",
      expect.objectContaining({ bundleId: BUNDLE_ID }),
    );
  });
});
