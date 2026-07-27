// src/server/adapters/node-fs.ts — the real FsPort adapter, confined to a single root directory
// (the Git-sync worker's `config.gitSync.repoPath`). Every path is resolved against `root` and
// re-checked with node:path's `relative()`; on POSIX any path outside `root` — however it got
// there, a literal `..` segment or an absolute path like `/etc/passwd` that `path.resolve` would
// otherwise honour outright — makes `relative(root, resolved)` start with `..`, because every
// absolute path shares the single `/` ancestor. Checking the *resolved result* rather than
// pattern-matching the input string is what catches both cases with one rule.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { ValidationError } from "../../core/errors";
import type { FsPort } from "../ports";

/** Resolves `path` against `root`, throwing `ValidationError('fs.pathEscape')` if it lands outside. */
export function resolveWithinRoot(root: string, path: string): string {
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

export function createNodeFs(root: string): FsPort {
  return {
    async writeFile(path, contents) {
      const target = resolveWithinRoot(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    },

    async mkdirp(path) {
      await mkdir(resolveWithinRoot(root, path), { recursive: true });
    },

    async rm(path) {
      await rm(resolveWithinRoot(root, path), { recursive: true, force: true });
    },

    async readFile(path) {
      return readFile(resolveWithinRoot(root, path), "utf8");
    },
  };
}
