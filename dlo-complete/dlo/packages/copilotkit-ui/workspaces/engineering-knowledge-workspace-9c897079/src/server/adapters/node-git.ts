// src/server/adapters/node-git.ts — the real GitPort adapter. Every invocation goes through
// `execFile` with an argv array — never a shell string — so a branch name, commit message, or file
// path containing shell metacharacters can never be interpreted by a shell. A non-zero exit or a
// spawn failure is mapped to `ConfigError('git.commandFailed')`: errors.ts's own doc comment on
// `ConfigError` names `git.credentialMissing` as a worked example of namespacing a git failure
// under this class, since "configuration" there means "something about the environment this
// process runs in is wrong" — including "git exited non-zero" — not narrowly env-var parsing.
import { execFile, type ExecFileException } from "node:child_process";
import { ConfigError } from "../../core/errors";
import type { GitPort } from "../ports";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      { cwd, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          rejectPromise(
            new ConfigError("git.commandFailed", `git ${args.join(" ")} failed: ${error.message}`, {
              details: {
                argv: ["git", ...args],
                cwd,
                exitCode: error.code ?? null,
                stderr: stderr || null,
              },
              cause: error,
            }),
          );
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

export function createNodeGit(): GitPort {
  return {
    async status(repoDir) {
      const { stdout } = await runGit(repoDir, ["status", "--porcelain"]);
      const files = stdout
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .map((line) => line.slice(3));
      return { dirty: files.length > 0, files };
    },

    async add(repoDir, paths) {
      if (paths.length === 0) {
        return;
      }
      await runGit(repoDir, ["add", "--", ...paths]);
    },

    async commit(repoDir, message, author) {
      await runGit(repoDir, [
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "-m",
        message,
      ]);
      const { stdout } = await runGit(repoDir, ["rev-parse", "HEAD"]);
      return { sha: stdout.trim() };
    },

    async push(repoDir, remote, branch) {
      await runGit(repoDir, ["push", remote, branch]);
    },
  };
}
