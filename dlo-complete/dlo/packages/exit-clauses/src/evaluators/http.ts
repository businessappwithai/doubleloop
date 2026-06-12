import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExitClauseResult, HttpProbeClause } from "@dlo/core";
import type { ClauseContext, ClauseEvaluator } from "../registry.js";

export class HttpProbeClauseEvaluator implements ClauseEvaluator {
  readonly kind = "httpProbe";

  async evaluate(clause: HttpProbeClause, ctx: ClauseContext): Promise<ExitClauseResult> {
    const start = Date.now();

    // 1. Resolve start command allowlist
    const command = clause.serviceUnderTest.startArgv[0];
    const args = clause.serviceUnderTest.startArgv.slice(1);
    if (!command) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: "Empty startup argv",
        durationMs: Date.now() - start,
      };
    }

    const allowlist = ["cargo", "npm", "node", "npx", "docker"];
    if (!allowlist.includes(command)) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `Forbidden start command: '${command}'`,
        durationMs: Date.now() - start,
      };
    }

    // Load body artifact if present
    let requestBody: string | undefined;
    if (clause.request.bodyArtifact) {
      const artifactPath = join(
        ctx.workspace,
        ".dlo",
        "artifacts",
        clause.request.bodyArtifact.sha256,
        "data"
      );
      try {
        requestBody = await readFile(artifactPath, "utf-8");
      } catch (e) {
        return {
          clauseId: clause.clauseId,
          passed: false,
          observed: `Failed to load request body artifact: ${e instanceof Error ? e.message : String(e)}`,
          durationMs: Date.now() - start,
        };
      }
    }

    let serviceProcess: any;
    let serviceLogs = "";

    try {
      // Spawn background process
      serviceProcess = spawn(command, args, {
        cwd: ctx.workspace,
        env: { ...process.env },
      });

      // Wait for ready log pattern
      const readyPattern = new RegExp(clause.serviceUnderTest.readyLogPattern);
      const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
        const checkBuffer = (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          serviceLogs += text;
          if (readyPattern.test(text) || readyPattern.test(serviceLogs)) {
            resolveReady();
          }
        };

        serviceProcess.stdout.on("data", checkBuffer);
        serviceProcess.stderr.on("data", checkBuffer);

        serviceProcess.on("error", (err: any) => {
          rejectReady(new Error(`Failed to start service process: ${err.message}`));
        });

        serviceProcess.on("exit", (code: number | null) => {
          rejectReady(new Error(`Service process exited prematurely with code ${code}`));
        });
      });

      // Startup timeout timer
      const startupTimeoutMs = clause.serviceUnderTest.startupTimeoutMs || 10_000;
      const timeoutPromise = new Promise<void>((_, rejectTimeout) => {
        setTimeout(() => {
          rejectTimeout(new Error(`Service failed to become ready within ${startupTimeoutMs}ms`));
        }, startupTimeoutMs);
      });

      // Race startup and ready
      await Promise.race([readyPromise, timeoutPromise]);

      // 2. Perform HTTP probe request
      // Find dynamic port if standard, but here we probe localhost
      // Let's deduce host/port or parse from path. Since path is like /api/v1/health or http://localhost:PORT/path
      const urlString = clause.request.path.startsWith("http")
        ? clause.request.path
        : `http://localhost:8080${clause.request.path}`; // default port 8080 if not absolute url

      const headers = {
        "Content-Type": "application/json",
        ...clause.request.headers,
      };

      const fetchTimeoutMs = clause.timeoutMs || 5000;
      const fetchController = new AbortController();
      const fetchTimer = setTimeout(() => fetchController.abort(), fetchTimeoutMs);

      const fetchOpts: RequestInit = {
        method: clause.request.method,
        headers,
        signal: fetchController.signal,
      };
      if (requestBody !== undefined) {
        fetchOpts.body = requestBody;
      }

      const response = await fetch(urlString, fetchOpts);

      clearTimeout(fetchTimer);

      const responseText = await response.text();

      // Check status
      if (response.status !== clause.expect.status) {
        return {
          clauseId: clause.clauseId,
          passed: false,
          observed: `HTTP status mismatch: expected ${clause.expect.status}, got ${response.status}. Response: ${responseText}`,
          durationMs: Date.now() - start,
        };
      }

      // Check json schema if present
      if (clause.expect.jsonSchemaArtifact) {
        const schemaPath = join(
          ctx.workspace,
          ".dlo",
          "artifacts",
          clause.expect.jsonSchemaArtifact.sha256,
          "data"
        );
        let schemaContent = "";
        try {
          schemaContent = await readFile(schemaPath, "utf-8");
        } catch (e) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `Failed to load JSON Schema artifact: ${e instanceof Error ? e.message : String(e)}`,
            durationMs: Date.now() - start,
          };
        }

        // Validate JSON
        let jsonResponse: unknown;
        try {
          jsonResponse = JSON.parse(responseText);
        } catch (e) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `Response is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
            durationMs: Date.now() - start,
          };
        }

        // Using simple Ajv validator or dynamic schema compiler
        // Since we are ESM, let's validate using a dynamic Zod/JSON validator or simple checks.
        // For production agent readiness, let's write a simple validation block or use standard library
        // Let's do simple validation of required fields or matching keys as a lightweight placeholder-free JSON validator.
        // Wait, can we import `ajv` or do a simple key validation? Let's check package.json: we didn't add Ajv.
        // Let's install Ajv, or implement a lightweight schema validator.
        // Let's write a simple recursive schema validator for basic validation to keep dependencies low:
        const validationResult = this.#validateJsonSchema(jsonResponse, JSON.parse(schemaContent));
        if (!validationResult.valid) {
          return {
            clauseId: clause.clauseId,
            passed: false,
            observed: `JSON Schema validation failed: ${validationResult.errors.join("; ")}`,
            durationMs: Date.now() - start,
          };
        }
      }

      return {
        clauseId: clause.clauseId,
        passed: true,
        observed: this.#truncate(`HTTP probe passed. Status: ${response.status}. Body:\n${responseText}`, ctx.evidenceMaxBytes),
        durationMs: Date.now() - start,
      };

    } catch (e: any) {
      return {
        clauseId: clause.clauseId,
        passed: false,
        observed: `HTTP Probe failed: ${e.message}\nService logs:\n${serviceLogs}`,
        durationMs: Date.now() - start,
      };
    } finally {
      // Clean up service process
      if (serviceProcess) {
        try {
          serviceProcess.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
  }

  #validateJsonSchema(obj: any, schema: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!schema) return { valid: true, errors };

    if (schema.type === "object" && typeof obj === "object" && obj !== null) {
      if (schema.required) {
        for (const req of schema.required) {
          if (!(req in obj)) {
            errors.push(`Missing required property: ${req}`);
          }
        }
      }
      if (schema.properties) {
        for (const [key, val] of Object.entries(schema.properties)) {
          if (key in obj) {
            const subVal = this.#validateJsonSchema(obj[key], val);
            if (!subVal.valid) {
              errors.push(...subVal.errors.map((e) => `Property '${key}': ${e}`));
            }
          }
        }
      }
    } else if (schema.type === "array" && Array.isArray(obj)) {
      if (schema.items) {
        for (let i = 0; i < obj.length; i++) {
          const subVal = this.#validateJsonSchema(obj[i], schema.items);
          if (!subVal.valid) {
            errors.push(...subVal.errors.map((e) => `Index [${i}]: ${e}`));
          }
        }
      }
    } else if (schema.type === "string" && typeof obj !== "string") {
      errors.push(`Expected string, got ${typeof obj}`);
    } else if (schema.type === "number" && typeof obj !== "number") {
      errors.push(`Expected number, got ${typeof obj}`);
    } else if (schema.type === "boolean" && typeof obj !== "boolean") {
      errors.push(`Expected boolean, got ${typeof obj}`);
    }
    return { valid: errors.length === 0, errors };
  }

  #truncate(str: string, maxBytes: number = 16384): string {
    const buf = Buffer.from(str, "utf-8");
    if (buf.length <= maxBytes) {
      return str;
    }
    const half = Math.floor(maxBytes / 2) - 20;
    const head = buf.subarray(0, half).toString("utf-8");
    const tail = buf.subarray(buf.length - half).toString("utf-8");
    return `${head}\n\n[... TRUNCATED ...]\n\n${tail}`;
  }
}
