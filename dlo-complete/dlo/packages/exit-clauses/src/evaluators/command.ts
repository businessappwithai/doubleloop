import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { ExitClauseResult, CommandClause } from "@dlo/core";
import type { ClauseContext, ClauseEvaluator } from "../registry.js";

const execFileAsync = promisify(execFile);

export class CommandClauseEvaluator implements ClauseEvaluator {
  readonly kind = "command";

  async evaluate(clause: CommandClause, ctx: ClauseContext): Promise<ExitClauseResult> {
    const start = Date.now();
    const command = clause.argv[0];
    const args = clause.argv.slice(1);

    if (!command) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: "Empty command argv",
        durationMs: Date.now() - start,
      };
    }

    // Verify command is on the allowlist
    const allowlist = ["cargo", "npx", "npm", "psql", "docker", "pg_dump", "tsc", "vitest", "eslint", "prettier"];
    if (!allowlist.includes(command)) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `Forbidden command: '${command}'. Allowed: ${allowlist.join(", ")}`,
        durationMs: Date.now() - start,
      };
    }

    // Resolve and confine CWD
    let relativeCwd = ".";
    if (clause.cwd === "backend") {
      relativeCwd = ctx.backendDir || "backend";
    } else if (clause.cwd === "frontend") {
      relativeCwd = ctx.frontendDir || "frontend";
    }

    const targetCwd = resolve(ctx.workspace, relativeCwd);
    let realCwd: string;
    let realWorkspace: string;

    try {
      realCwd = await realpath(targetCwd);
      realWorkspace = await realpath(ctx.workspace);
    } catch (e) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `Failed to resolve paths: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - start,
      };
    }

    if (!realCwd.startsWith(realWorkspace)) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `CWD escape detected: path '${realCwd}' is outside workspace '${realWorkspace}'`,
        durationMs: Date.now() - start,
      };
    }

    // Compose AbortSignal and timeout
    const timeoutMs = clause.timeoutMs || 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (ctx.signal) {
      ctx.signal.addEventListener("abort", () => {
        controller.abort();
        clearTimeout(timer);
      });
    }

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: realCwd,
        signal: controller.signal,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      clearTimeout(timer);

      const durationMs = Date.now() - start;

      // Check exitCode (promisify returns exit code 0 on success, otherwise throws)
      // Check stdout matches
      if (clause.expect.stdoutMatches) {
        const regex = new RegExp(clause.expect.stdoutMatches);
        if (!regex.test(stdout)) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: this.#truncate(`Stdout does not match pattern. Stdout:\n${stdout}`, ctx.evidenceMaxBytes),
            durationMs,
          };
        }
      }

      // Check stderr max bytes
      if (clause.expect.stderrMaxBytes !== undefined) {
        const stderrBytes = Buffer.byteLength(stderr, "utf-8");
        if (stderrBytes > clause.expect.stderrMaxBytes) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: this.#truncate(`Stderr exceeded limit of ${clause.expect.stderrMaxBytes} bytes (got ${stderrBytes}). Stderr:\n${stderr}`, ctx.evidenceMaxBytes),
            durationMs,
          };
        }
      }

      return {
        clauseId: clause.clauseId,
        passed: true,
        observed: this.#truncate(`Command passed. Stdout:\n${stdout}\nStderr:\n${stderr}`, ctx.evidenceMaxBytes),
        durationMs,
      };
    } catch (e: any) {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      const code = e.code;
      const stdout = e.stdout || "";
      const stderr = e.stderr || "";

      if (controller.signal.aborted) {
        return {
          clauseId: clause.clauseId,
          passed: false,
          observed: `Command timed out after ${timeoutMs}ms`,
          durationMs,
        };
      }

      // Check if exitCode matches expected if e.code is a number
      if (typeof code === "number") {
        const expectedCode = clause.expect.exitCode ?? 0;
        if (code === expectedCode) {
          // Check stdout matches
          if (clause.expect.stdoutMatches) {
            const regex = new RegExp(clause.expect.stdoutMatches);
            if (!regex.test(stdout)) {
              return {
                clauseId: clause.clauseId,
                passed: false,
                observed: this.#truncate(`Exit code matched expected ${expectedCode} but stdout does not match pattern. Stdout:\n${stdout}`, ctx.evidenceMaxBytes),
                durationMs,
              };
            }
          }
          return {
            clauseId: clause.clauseId,
            passed: true,
            observed: this.#truncate(`Command passed with expected exit code ${expectedCode}. Stdout:\n${stdout}\nStderr:\n${stderr}`, ctx.evidenceMaxBytes),
            durationMs,
          };
        }
      }

      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: this.#truncate(`Command failed with code ${code || e.message}.\nStdout:\n${stdout}\nStderr:\n${stderr}`, ctx.evidenceMaxBytes),
        durationMs,
      };
    }
  }

  #truncate(str: string, maxBytes: number = 16384): string {
    const buf = Buffer.from(str, "utf-8");
    if (buf.length <= maxBytes) {
      return str;
    }
    // Preserving head and tail
    const half = Math.floor(maxBytes / 2) - 20;
    const head = buf.subarray(0, half).toString("utf-8");
    const tail = buf.subarray(buf.length - half).toString("utf-8");
    return `${head}\n\n[... TRUNCATED ${buf.length - maxBytes} BYTES ...]\n\n${tail}`;
  }
}
