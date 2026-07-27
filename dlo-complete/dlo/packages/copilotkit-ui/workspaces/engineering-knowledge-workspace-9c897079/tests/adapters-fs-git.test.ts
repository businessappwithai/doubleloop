// tests/adapters-fs-git.test.ts — module m5 (Ports and adapters). Covers the real FsPort adapter
// (node-fs.ts, exercised only against a temp directory created in beforeEach and removed in
// afterEach — never a fixed path outside it), the real GitPort adapter (node-git.ts, exercised
// with node:child_process fully mocked so no git process ever spawns), and the deterministic fakes
// (createMemoryFs, createFakeGit) that every later module's tests inject instead.
import { mkdtemp, rm as rmReal, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigError, ValidationError } from "../src/core/errors";
import { createNodeFs } from "../src/server/adapters/node-fs";
import { createFakeGit, createMemoryFs } from "./helpers/fake-ports";

// node-git.ts is imported after this mock is declared; Vitest hoists `vi.mock` calls to the top
// of the file, before any import, so `createNodeGit` below always sees the mocked module.
// A `default` export is required as well as the named one: Node core modules are
// consumed both ways in this dependency graph, and a factory without it makes Vitest
// throw "No default export is defined on the node:child_process mock" before any test runs.
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});

import { execFile, type ExecFileException } from "node:child_process";
import { createNodeGit } from "../src/server/adapters/node-git";

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// createNodeFs — real temp directory, never a real path outside it
// ---------------------------------------------------------------------------

describe("createNodeFs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ekw-node-fs-"));
  });

  afterEach(async () => {
    await rmReal(root, { recursive: true, force: true });
  });

  test("writeFile creates parent directories and the file", async () => {
    const fs = createNodeFs(root);
    await fs.writeFile("nested/dir/note.md", "# hello");
    await expect(fs.readFile("nested/dir/note.md")).resolves.toBe("# hello");
  });

  test("writeFile overwrites an existing file", async () => {
    const fs = createNodeFs(root);
    await fs.writeFile("note.md", "first");
    await fs.writeFile("note.md", "second");
    await expect(fs.readFile("note.md")).resolves.toBe("second");
  });

  test("mkdirp creates a directory that did not exist", async () => {
    const fs = createNodeFs(root);
    await fs.mkdirp("a/b/c");
    const stats = await stat(join(root, "a/b/c"));
    expect(stats.isDirectory()).toBe(true);
  });

  test("rm removes a file", async () => {
    const fs = createNodeFs(root);
    await fs.writeFile("gone.md", "bye");
    await fs.rm("gone.md");
    await expect(stat(join(root, "gone.md"))).rejects.toThrow();
  });

  test("rm on a path that does not exist does not throw", async () => {
    const fs = createNodeFs(root);
    await expect(fs.rm("never-existed.md")).resolves.toBeUndefined();
  });

  test("readFile on a missing file rejects", async () => {
    const fs = createNodeFs(root);
    await expect(fs.readFile("missing.md")).rejects.toThrow();
  });

  test("rejects a '..' escape with ValidationError('fs.pathEscape')", async () => {
    const fs = createNodeFs(root);
    await expect(fs.writeFile("../escape.md", "x")).rejects.toThrow(ValidationError);
    try {
      await fs.readFile("../escape.md");
      throw new Error("expected readFile to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details["reason"]).toBe("fs.pathEscape");
    }
  });

  test("rejects an absolute path outside the root", async () => {
    const fs = createNodeFs(root);
    await expect(fs.readFile("/etc/passwd")).rejects.toThrow(ValidationError);
  });

  test("performs no I/O before rejecting a path escape", async () => {
    const fs = createNodeFs(root);
    await expect(fs.writeFile("../../../../tmp/ekw-escape-should-not-exist.md", "x")).rejects.toThrow(
      ValidationError,
    );
    await expect(stat("/tmp/ekw-escape-should-not-exist.md")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createNodeGit — node:child_process fully mocked, no git process ever spawns
// ---------------------------------------------------------------------------

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

function queueSuccess(stdout: string, stderr = ""): void {
  mockedExecFile.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(null, stdout, stderr);
    },
  );
}

function queueFailure(error: ExecFileException, stderr = ""): void {
  mockedExecFile.mockImplementationOnce(
    (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(error, "", stderr);
    },
  );
}

describe("createNodeGit", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  test("status() invokes 'git status --porcelain' via an argv array and parses dirty files", async () => {
    queueSuccess(" M src/a.ts\n?? src/b.ts\n");
    const git = createNodeGit();

    const result = await git.status("/repo");

    expect(mockedExecFile).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
    expect(result).toEqual({ dirty: true, files: ["src/a.ts", "src/b.ts"] });
  });

  test("status() reports a clean tree as not dirty with no files", async () => {
    queueSuccess("");
    const git = createNodeGit();

    expect(await git.status("/repo")).toEqual({ dirty: false, files: [] });
  });

  test("add() invokes 'git add --' with every path in the argv array", async () => {
    queueSuccess("");
    const git = createNodeGit();

    await git.add("/repo", ["src/a.ts", "src/b.ts"]);

    expect(mockedExecFile).toHaveBeenCalledWith(
      "git",
      ["add", "--", "src/a.ts", "src/b.ts"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
  });

  test("add() with an empty path list never spawns a process", async () => {
    const git = createNodeGit();

    await git.add("/repo", []);

    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  test("commit() commits with the given author via -c flags, then resolves the sha via rev-parse", async () => {
    queueSuccess("");
    queueSuccess("abc123def456\n");
    const git = createNodeGit();

    const result = await git.commit("/repo", "sync bundle", { name: "Ada Lovelace", email: "ada@example.test" });

    expect(mockedExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      [
        "-c",
        "user.name=Ada Lovelace",
        "-c",
        "user.email=ada@example.test",
        "commit",
        "-m",
        "sync bundle",
      ],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
    expect(mockedExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
    expect(result).toEqual({ sha: "abc123def456" });
  });

  test("push() invokes 'git push <remote> <branch>' with an argv array", async () => {
    queueSuccess("");
    const git = createNodeGit();

    await git.push("/repo", "origin", "main");

    expect(mockedExecFile).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "main"],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
  });

  test("maps a non-zero exit to ConfigError('git.commandFailed') with the argv and exit code", async () => {
    const error = Object.assign(new Error("Command failed"), { code: 128 }) as ExecFileException;
    queueFailure(error, "fatal: unable to access remote");
    const git = createNodeGit();

    try {
      await git.push("/repo", "origin", "main");
      throw new Error("expected push to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      expect(configError.code).toBe("git.commandFailed");
      expect(configError.details["argv"]).toEqual(["git", "push", "origin", "main"]);
      expect(configError.details["exitCode"]).toBe(128);
      expect(configError.details["stderr"]).toBe("fatal: unable to access remote");
      expect(configError.cause).toBe(error);
    }
  });
});

// ---------------------------------------------------------------------------
// createMemoryFs — the in-memory FsPort fake
// ---------------------------------------------------------------------------

describe("createMemoryFs", () => {
  test("writeFile then readFile round-trips content", async () => {
    const fs = createMemoryFs("/workspace");
    await fs.writeFile("notes/a.md", "hello");
    await expect(fs.readFile("notes/a.md")).resolves.toBe("hello");
  });

  test("mkdirp does not throw and requires no prior writeFile", async () => {
    const fs = createMemoryFs("/workspace");
    await expect(fs.mkdirp("empty/dir")).resolves.toBeUndefined();
  });

  test("rm removes a single file", async () => {
    const fs = createMemoryFs("/workspace");
    await fs.writeFile("a.md", "x");
    await fs.rm("a.md");
    expect(fs.files.has("/workspace/a.md")).toBe(false);
  });

  test("rm removes every file nested under a directory prefix", async () => {
    const fs = createMemoryFs("/workspace");
    await fs.writeFile("dir/a.md", "a");
    await fs.writeFile("dir/sub/b.md", "b");
    await fs.writeFile("dir-sibling.md", "unrelated");
    await fs.rm("dir");
    expect(Array.from(fs.files.keys())).toEqual(["/workspace/dir-sibling.md"]);
  });

  test("readFile on a missing file throws NotFoundError", async () => {
    const fs = createMemoryFs("/workspace");
    await expect(fs.readFile("missing.md")).rejects.toThrow("file not found: missing.md");
  });

  test("rejects a '..' escape with ValidationError('fs.pathEscape')", async () => {
    const fs = createMemoryFs("/workspace");
    try {
      await fs.writeFile("../escape.md", "x");
      throw new Error("expected writeFile to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details["reason"]).toBe("fs.pathEscape");
    }
  });

  test("rejects an absolute path outside the root", async () => {
    const fs = createMemoryFs("/workspace");
    await expect(fs.readFile("/etc/passwd")).rejects.toThrow(ValidationError);
  });

  test("exposes the raw files map for direct assertions", async () => {
    const fs = createMemoryFs("/workspace");
    await fs.writeFile("a.md", "content");
    expect(fs.files.get("/workspace/a.md")).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// createFakeGit — the recording GitPort fake
// ---------------------------------------------------------------------------

describe("createFakeGit", () => {
  test("status() defaults to clean with no files for an unconfigured repo", async () => {
    const git = createFakeGit();
    expect(await git.status("/repo")).toEqual({ dirty: false, files: [] });
  });

  test("setStatus() configures the result of the next status() call for that repoDir", async () => {
    const git = createFakeGit();
    git.setStatus("/repo", { dirty: true, files: ["a.md"] });
    expect(await git.status("/repo")).toEqual({ dirty: true, files: ["a.md"] });
  });

  test("records every call in order on .calls", async () => {
    const git = createFakeGit();
    await git.status("/repo");
    await git.add("/repo", ["a.md"]);
    expect(git.calls.map((call) => call.method)).toEqual(["status", "add"]);
  });

  test("commit() returns a sha and records the commit on .commits", async () => {
    const git = createFakeGit();
    const author = { name: "Ada Lovelace", email: "ada@example.test" };
    const result = await git.commit("/repo", "sync", author);
    expect(result.sha).toMatch(/^fakesha\d{4}$/);
    expect(git.commits).toEqual([{ repoDir: "/repo", message: "sync", author, sha: result.sha }]);
  });

  test("commit() issues a distinct sha per call", async () => {
    const git = createFakeGit();
    const author = { name: "Ada Lovelace", email: "ada@example.test" };
    const first = await git.commit("/repo", "one", author);
    const second = await git.commit("/repo", "two", author);
    expect(first.sha).not.toBe(second.sha);
  });

  test("push() succeeds by default", async () => {
    const git = createFakeGit();
    await expect(git.push("/repo", "origin", "main")).resolves.toBeUndefined();
  });

  test("failNextPush() rejects exactly the next push, then pushes succeed again", async () => {
    const git = createFakeGit();
    const failure = new Error("network unreachable");
    git.failNextPush(failure);

    await expect(git.push("/repo", "origin", "main")).rejects.toBe(failure);
    await expect(git.push("/repo", "origin", "main")).resolves.toBeUndefined();
  });
});
