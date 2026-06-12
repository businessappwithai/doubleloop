import picomatch from "picomatch";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExitClauseResult, FileAssertionClause } from "@dlo/core";
import type { ClauseContext, ClauseEvaluator } from "../registry.js";

export class FileAssertionClauseEvaluator implements ClauseEvaluator {
  readonly kind = "fileAssertion";

  async evaluate(clause: FileAssertionClause, ctx: ClauseContext): Promise<ExitClauseResult> {
    const start = Date.now();

    let allFiles: string[] = [];
    try {
      allFiles = await this.#walk(ctx.workspace);
    } catch (e) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `Failed to scan workspace: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - start,
      };
    }

    const isMatch = picomatch(clause.glob);
    const matchedFiles = allFiles.filter((file) => {
      const relPath = relative(ctx.workspace, file);
      return isMatch(relPath);
    });

    const durationMs = Date.now() - start;

    if (clause.mustExist && matchedFiles.length === 0) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `File assertion failed: no files matched glob '${clause.glob}' (must exist)`,
        durationMs,
      };
    }

    const findings: string[] = [];
    let passed = true;

    for (const filePath of matchedFiles) {
      const relPath = relative(ctx.workspace, filePath);
      let content = "";
      try {
        content = await readFile(filePath, "utf-8");
      } catch (e) {
        passed = false;
        findings.push(`${relPath}: Failed to read file: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // Check contentMatches
      if (clause.contentMatches) {
        const regex = new RegExp(clause.contentMatches);
        if (!regex.test(content)) {
          passed = false;
          findings.push(`${relPath}: Content does not match pattern '${clause.contentMatches}'`);
        }
      }

      // Check contentForbids
      if (clause.contentForbids) {
        if (content.includes(clause.contentForbids)) {
          passed = false;
          findings.push(`${relPath}: Forbidden content detected: '${clause.contentForbids}'`);
        }
      }
    }

    if (!passed) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `File assertions failed for glob '${clause.glob}':\n${findings.join("\n")}`,
        durationMs,
      };
    }

    return {
      clauseId: clause.clauseId,
      passed: true,
      observed: `Matched ${matchedFiles.length} file(s) for glob '${clause.glob}'. All checks passed.`,
      durationMs,
    };
  }

  async #walk(dir: string): Promise<string[]> {
    const files: string[] = [];
    let list: string[] = [];
    try {
      list = await readdir(dir);
    } catch {
      return [];
    }

    for (const file of list) {
      const filePath = join(dir, file);
      let s;
      try {
        s = await stat(filePath);
      } catch {
        continue;
      }

      if (s.isDirectory()) {
        if (
          file !== "node_modules" &&
          file !== ".git" &&
          file !== "dist" &&
          file !== "build" &&
          file !== ".dlo"
        ) {
          files.push(...(await this.#walk(filePath)));
        }
      } else {
        files.push(filePath);
      }
    }
    return files;
  }
}
