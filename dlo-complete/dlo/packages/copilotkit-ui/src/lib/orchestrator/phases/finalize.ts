/**
 * orchestrator/phases/finalize.ts
 * Phases IV/V — the execute-and-test subagent: build the app, provision
 * PostgreSQL, run the tests, deploy. Each step sits behind a
 * TERMINAL_PERMISSION gate, as before.
 *
 * New in the enhancement pass:
 *  - Fix loop: build or test failures are handed to a fixer subagent
 *    (Claude Code, cheap model) with the failing output, then retried
 *    (up to 3 rounds) before the result is accepted as failed.
 *  - Database.md's ```sql DDL block is the migration source of truth when
 *    the generated app ships no migrations of its own.
 */

import { join } from "node:path";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import {
  type PipelineState,
  getPipeline,
  savePipeline,
  pushPhaseHistory,
  writeWorkspaceMarkdown,
} from "../state";
import { spawnClaudeAgent, claudeAuthFromConfig } from "../subagents/claude";

const execFileAsync = promisify(execFile);
const MAX_FIX_ROUNDS = 3;

// ─── Fixer subagent ──────────────────────────────────────────────────────────

async function runFixerSubagent(
  state: PipelineState,
  failureKind: "build" | "test",
  failureOutput: string
): Promise<void> {
  const { auth, apiKey } = claudeAuthFromConfig(state.config);
  const model = state.config?.providers?.executor?.model || "claude-haiku-4-5-20251001";
  console.log(`[Fixer] Repairing ${failureKind} failure with ${model}`);
  await spawnClaudeAgent({
    prompt: `You are the Fixer subagent of the Double-Loop Orchestrator. The application in this workspace
failed its ${failureKind} step. Diagnose the failure from the output below, fix the code (NOT the tests'
intent — fix the application unless a test is objectively wrong), and make the ${failureKind} pass.

${failureKind === "build" ? "Build" : "Test"} output (tail):
${failureOutput.slice(-4000)}

Rules:
- Make the smallest correct fix; do not refactor unrelated code.
- No placeholders or skipped tests.
- Verify your fix compiles if a quick check is possible.`,
    model,
    cwd: state.workspaceDir,
    permissionMode: "acceptEdits",
    auth,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: 15 * 60_000,
  });
}

// ─── Required tool checks (CodeWhale path only) ──────────────────────────────

export async function runToolInstallScript(): Promise<{ success: boolean; log: string }> {
  const scriptPath = join(process.cwd(), "scripts/install-ai-tools.sh");
  let log = "";
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
      timeout: 300_000,
      env: { ...process.env, HOME: process.env.HOME || "/tmp" },
    });
    log = stdout + stderr;

    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const provider = deepseekKey ? "deepseek" : openaiKey ? "openai" : openrouterKey ? "openrouter" : null;
    const apiKey = deepseekKey || openaiKey || openrouterKey;

    if (provider && apiKey) {
      try {
        const { stdout: authOut } = await execFileAsync(
          "codewhale",
          ["auth", "set", "--provider", provider, "--api-key", apiKey],
          { timeout: 15_000, env: process.env }
        );
        log += `\n[DLO] Configured CodeWhale provider: ${provider}\n${authOut}`;
      } catch (e: any) {
        log += `\n[DLO] CodeWhale provider config failed: ${e.message}`;
      }
    } else {
      log += "\n[DLO] No provider API key found for CodeWhale (DEEPSEEK_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY).";
    }

    return { success: true, log };
  } catch (err: any) {
    return { success: false, log: (err.stdout || "") + (err.stderr || "") + err.message };
  }
}

// ─── Infrastructure scaffold (last-resort; module 1 should have done this) ──

export async function scaffoldMissingInfrastructure(workspaceDir: string, projectName: string): Promise<void> {
  const pkgPath = join(workspaceDir, "package.json");
  let hasPkg = false;
  try { await readFile(pkgPath, "utf-8"); hasPkg = true; } catch { /* missing */ }
  if (hasPkg) return;

  const allFiles: string[] = [];
  const collectFiles = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await collectFiles(full);
      else allFiles.push(full.replace(workspaceDir + "/", ""));
    }
  };
  await collectFiles(workspaceDir);

  const hasTs = allFiles.some(f => f.endsWith(".tsx") || f.endsWith(".ts"));
  const hasCss = allFiles.some(f => f.endsWith(".css"));
  const hasReact = allFiles.some(f => f.includes("App") || f.includes("component"));
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  if (hasReact || hasTs) {
    console.warn(`[Scaffold] package.json missing after execution — module 1 should have scaffolded it. Applying fallback Vite scaffold.`);
    const pkg = {
      name: slug,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc -b && vite build",
        preview: "vite preview",
        test: "vitest run --passWithNoTests",
      },
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: {
        "@types/react": "^18.3.5",
        "@types/react-dom": "^18.3.0",
        "@vitejs/plugin-react": "^4.3.1",
        typescript: "^5.5.3",
        vite: "^5.4.2",
        vitest: "^2.0.5",
      },
    };
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");

    const indexPath = join(workspaceDir, "index.html");
    if (!existsSync(indexPath)) {
      await writeFile(indexPath, `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${projectName}</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>`, "utf-8");
    }
    const vitePath = join(workspaceDir, "vite.config.ts");
    if (!existsSync(vitePath)) {
      await writeFile(vitePath, `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()] })
`, "utf-8");
    }
    const tscPath = join(workspaceDir, "tsconfig.json");
    if (!existsSync(tscPath)) {
      await writeFile(tscPath, JSON.stringify({
        compilerOptions: { target: "ES2020", useDefineForClassFields: true, lib: ["ES2020", "DOM", "DOM.Iterable"], module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true, strict: true, jsx: "react-jsx" },
        include: ["src"],
      }, null, 2), "utf-8");
    }
    const mainPath = join(workspaceDir, "src/main.tsx");
    if (!existsSync(mainPath)) {
      await mkdir(join(workspaceDir, "src"), { recursive: true });
      await writeFile(mainPath, `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
${hasCss ? "import './index.css'" : ""}
import App from './App'
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
`, "utf-8");
    }
  }
}

// ─── Detection helpers ───────────────────────────────────────────────────────

export async function detectDatabaseNeeded(workspaceDir: string, domainDocument?: string): Promise<boolean> {
  const dbKeywords = /\b(?:postgres|postgresql|mysql|mongodb|redis|pg|prisma|typeorm|sequelize|drizzle|mongoose)\b/i;
  const dbImports = /from ['"](?:pg|mysql|mysql2|sqlite3|mongoose|prisma|@prisma\/client|typeorm|sequelize|drizzle-orm|knex|better-sqlite3)/;
  const dbEnvVars = /process\.env\.(?:DATABASE_URL|DB_URL|POSTGRES_URL|MYSQL_URL)/;

  const androidSignals = ["build.gradle.kts", "build.gradle", "AndroidManifest.xml", "gradle.properties"];
  const isAndroid = androidSignals.some((f) => existsSync(join(workspaceDir, f)));
  if (isAndroid) return false;

  if (domainDocument && dbKeywords.test(domainDocument)) return true;

  try {
    const pkgPath = join(workspaceDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const dbPkgs = ["pg", "mysql", "mysql2", "sqlite3", "mongoose", "prisma", "@prisma/client", "typeorm", "sequelize", "drizzle-orm", "knex", "better-sqlite3"];
      if (dbPkgs.some((p) => allDeps[p])) return true;
    }

    const files = (await readdir(workspaceDir, { recursive: true }) as string[]);
    const codeFiles = files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)).slice(0, 30);
    for (const file of codeFiles) {
      const content = await readFile(join(workspaceDir, file), "utf-8").catch(() => "");
      if (dbImports.test(content) || dbEnvVars.test(content)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** Extract the ```sql DDL block from Database.md, if the pipeline has one. */
function databaseMdDdl(state: PipelineState): string | null {
  const dbMd = state.designDocs?.database?.markdown;
  if (!dbMd) return null;
  const m = dbMd.match(/```sql\s*\n([\s\S]*?)```/i);
  return m?.[1]?.trim() || null;
}

async function runMigrations(state: PipelineState, dbUrl: string, containerId: string): Promise<string> {
  const workspaceDir = state.workspaceDir;
  const prismaSchema = join(workspaceDir, "prisma/schema.prisma");
  if (existsSync(prismaSchema)) {
    try {
      await execFileAsync("npx", ["prisma", "migrate", "deploy"], {
        cwd: workspaceDir,
        env: { ...process.env, DATABASE_URL: dbUrl },
        timeout: 60_000,
      });
      return "Prisma migrations applied";
    } catch (e: any) {
      console.warn("[DB] Prisma migrate failed:", e.message);
    }
  }

  const migrationDirs = ["migrations", "db/migrations", "src/migrations", "database/migrations"];
  for (const mDir of migrationDirs) {
    const fullDir = join(workspaceDir, mDir);
    if (!existsSync(fullDir)) continue;
    const files = (await readdir(fullDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const sqlFile of files) {
      const sql = await readFile(join(fullDir, sqlFile), "utf-8");
      try {
        await execFileAsync("docker", ["exec", "-i", containerId, "psql", "-U", "dlo", "-d", "dlo_app", "-c", sql], {
          timeout: 30_000,
        });
        console.log(`[DB] Applied migration: ${sqlFile}`);
      } catch (e: any) {
        console.warn(`[DB] Migration ${sqlFile} failed:`, e.message);
      }
    }
    return `Applied ${files.length} SQL migrations from ${mDir}`;
  }

  // No migrations in the generated app → Database.md DDL is the source of truth.
  const ddl = databaseMdDdl(state);
  if (ddl) {
    try {
      await execFileAsync("docker", ["exec", "-i", containerId, "psql", "-U", "dlo", "-d", "dlo_app", "-c", ddl], {
        timeout: 60_000,
      });
      return "Applied schema from Database.md DDL block";
    } catch (e: any) {
      console.warn("[DB] Database.md DDL apply failed:", e.message);
      return `Database.md DDL apply failed: ${e.message.slice(0, 300)}`;
    }
  }

  return "No migration files found";
}

export async function detectTestCommand(workspaceDir: string): Promise<{ cmd: string; args: string[] } | null> {
  if (existsSync(join(workspaceDir, "gradlew"))) {
    return { cmd: "./gradlew", args: ["testDebugUnitTest", "--continue"] };
  }
  if (existsSync(join(workspaceDir, "build.gradle.kts")) || existsSync(join(workspaceDir, "build.gradle"))) {
    return { cmd: "gradle", args: ["testDebugUnitTest", "--continue"] };
  }
  try {
    const pkg = JSON.parse(await readFile(join(workspaceDir, "package.json"), "utf-8"));
    const noOpTest = /^echo.*no test/i;
    if (pkg.scripts?.test && !noOpTest.test(pkg.scripts.test)) {
      return { cmd: "npm", args: ["test", "--", "--passWithNoTests"] };
    }
    if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) {
      return { cmd: "npx", args: ["vitest", "run", "--passWithNoTests"] };
    }
    if (pkg.devDependencies?.jest || pkg.dependencies?.jest) {
      return { cmd: "npx", args: ["jest", "--passWithNoTests"] };
    }
  } catch { /* no package.json */ }
  return null;
}

export async function detectLaunchCommand(workspaceDir: string): Promise<{ cmd: string; args: string[]; port: number } | null> {
  if (existsSync(join(workspaceDir, "build.gradle.kts")) || existsSync(join(workspaceDir, "build.gradle"))) {
    return null;
  }
  try {
    const pkg = JSON.parse(await readFile(join(workspaceDir, "package.json"), "utf-8"));
    if (pkg.scripts?.dev) return { cmd: "npm", args: ["run", "dev"], port: 3001 };
    if (pkg.scripts?.start) return { cmd: "npm", args: ["start"], port: 3001 };
  } catch { /* no package.json */ }
  return null;
}

export async function detectBuildCommand(workspaceDir: string): Promise<{ cmd: string; args: string[]; outputDir: string } | null> {
  if (existsSync(join(workspaceDir, "gradlew"))) {
    return { cmd: "./gradlew", args: ["assembleDebug", "--continue"], outputDir: "app/build/outputs/apk/debug" };
  }
  if (existsSync(join(workspaceDir, "build.gradle.kts")) || existsSync(join(workspaceDir, "build.gradle"))) {
    return { cmd: "gradle", args: ["assembleDebug", "--continue"], outputDir: "app/build/outputs/apk/debug" };
  }
  try {
    const pkg = JSON.parse(await readFile(join(workspaceDir, "package.json"), "utf-8"));
    if (pkg.scripts?.build) {
      // TanStack Start builds to .output (vinxi/nitro); classic Vite to dist.
      const outputDir = existsSync(join(workspaceDir, "app.config.ts")) ? ".output" : "dist";
      return { cmd: "npm", args: ["run", "build"], outputDir };
    }
  } catch { /* no package.json */ }
  return null;
}

// ─── Supervisor: reviews test output ─────────────────────────────────────────

async function supervisorReviewTestOutput(
  testOutput: string,
  state: PipelineState
): Promise<{ passed: boolean; override: boolean; reasoning: string }> {
  try {
    const supervisorModel = state.config?.providers?.supervisor?.model || "claude-haiku-4-5-20251001";
    const { auth, apiKey } = claudeAuthFromConfig(state.config);
    const raw = await spawnClaudeAgent({
      prompt: `You are the Claude Code Supervisor reviewing automated test output for the DLO pipeline.

Project: ${state.projectName}
Test Output (last 3000 chars):
${testOutput.slice(-3000)}

Determine if the tests passed. You may OVERRIDE a failure if it's caused by:
- Missing environment setup (not an app bug)
- Known flaky test patterns
- Missing test fixtures or seeds

Respond ONLY with valid JSON: {"passed":boolean,"override":boolean,"reasoning":"string"}`,
      model: supervisorModel,
      cwd: state.workspaceDir,
      auth,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: 5 * 60_000,
    });
    const jsonMatch = raw.match(/\{[\s\S]*?"passed"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { passed: !!parsed.passed, override: !!parsed.override, reasoning: parsed.reasoning || "" };
    }
  } catch (e) {
    console.warn("[Supervisor] Test review failed:", e);
  }
  return { passed: true, override: false, reasoning: "supervisor review unavailable" };
}

// ─── Handoff document ────────────────────────────────────────────────────────

async function writeHandoff(state: PipelineState): Promise<void> {
  const notes = (state.contextNotes || [])
    .map((n: any) => `- [${n.timestamp?.slice(0, 19) ?? ""}] ${n.note}`)
    .join("\n");
  const modules = (state.board?.modules || [])
    .map((m: any) => `- **${m.title || m.moduleId}** — ${m.status}  \n  Attempts: ${m.attempts}`)
    .join("\n");
  const content =
    `# Handoff — ${state.projectName}\n\n` +
    `> Completed: ${new Date().toISOString()}\n\n` +
    `## App URL\n\n${state.appUrl || "Not launched"}\n\n` +
    `## Workspace\n\n\`${state.workspaceDir}\`\n\n` +
    `## Modules\n\n${modules || "—"}\n\n` +
    `## Steering Notes\n\n${notes || "None"}\n\n` +
    `## Files\n\nSee \`RESEARCH.md\`, \`Architecture.md\`, \`Database.md\`, and \`Implementation.md\` in this workspace.\n`;
  await writeWorkspaceMarkdown(state.workspaceDir, "HANDOFF.md", content);
}

// ─── Build phase (with fix loop) ─────────────────────────────────────────────

export async function runBuildBackground(pipelineId: string, hasPermission: boolean): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const buildCmd = await detectBuildCommand(state.workspaceDir);

    if (!buildCmd) {
      state.phase = "DB_PROVISIONING_RUNNING";
      pushPhaseHistory(state, "DB_PROVISIONING_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[Build] No build command for ${pipelineId}, skipping to DB provisioning`);
      void runDbProvisioningBackground(pipelineId, false);
      return;
    }

    const buildCommands = [
      `cd ${state.workspaceDir}`,
      ...(buildCmd.cmd === "npm" ? ["npm install"] : []),
      `${buildCmd.cmd} ${buildCmd.args.join(" ")}`,
      `# Artifacts will be in: ${buildCmd.outputDir}`,
    ];

    if (!hasPermission) {
      state.activeGate = {
        gateId: `gate-${crypto.randomUUID()}`,
        kind: "TERMINAL_PERMISSION",
        exhibits: [
          "Build Application",
          `Permission needed to build the generated application (failures are auto-repaired by the Fixer subagent, up to ${MAX_FIX_ROUNDS} rounds):\n\n${buildCommands.join("\n")}`,
          "Approve to build the application, or Reject to skip build and proceed to testing.",
        ],
        context: { nextAction: "build-app" },
      };
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[Build] Waiting for permission to build ${pipelineId}`);
      return;
    }

    const startTime = Date.now();
    let buildOutput = "";
    let buildPassed = false;
    let fixRounds = 0;

    if (buildCmd.cmd === "npm" || buildCmd.cmd === "npx") {
      try {
        const { stdout, stderr } = await execFileAsync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
          cwd: state.workspaceDir,
          timeout: 300_000,
          env: { ...process.env },
        });
        buildOutput += stdout + stderr;
      } catch (e: any) {
        buildOutput += (e.stdout || "") + (e.stderr || "");
        console.warn("[Build] npm install warning:", e.message?.slice(0, 200));
      }
    }

    // Build → on failure, fixer subagent → rebuild (up to MAX_FIX_ROUNDS).
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      console.log(`[Build] Running: ${buildCmd.cmd} ${buildCmd.args.join(" ")} (round ${round + 1})`);
      try {
        const { stdout, stderr } = await execFileAsync(buildCmd.cmd, buildCmd.args, {
          cwd: state.workspaceDir,
          timeout: 600_000,
          env: { ...process.env, CI: "true" },
        });
        buildOutput += stdout + stderr;
        buildPassed = true;
        break;
      } catch (err: any) {
        const failOut = (err.stdout || "") + (err.stderr || "");
        buildOutput += failOut;
        buildPassed = false;
        if (round < MAX_FIX_ROUNDS) {
          fixRounds++;
          try {
            await runFixerSubagent(state, "build", failOut || err.message);
            // Fixer may add deps — reinstall cheaply before retrying.
            await execFileAsync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
              cwd: state.workspaceDir, timeout: 300_000, env: { ...process.env },
            }).catch(() => { /* ignore */ });
          } catch (fixErr: any) {
            console.warn(`[Build] Fixer round ${fixRounds} failed:`, fixErr.message?.slice(0, 200));
            break;
          }
        }
      }
    }

    const artifacts: string[] = [];
    const artifactDir = join(state.workspaceDir, buildCmd.outputDir);
    if (existsSync(artifactDir)) {
      const artifactFiles = await readdir(artifactDir).catch(() => []);
      artifacts.push(...artifactFiles.map((f) => join(buildCmd.outputDir, f)));
    }

    const fresh = await getPipeline(pipelineId);
    if (!fresh) return;
    fresh.buildResults = { passed: buildPassed, output: buildOutput.slice(-5000), durationMs: Date.now() - startTime, artifacts, fixRounds };
    fresh.phase = "DB_PROVISIONING_RUNNING";
    pushPhaseHistory(fresh, "DB_PROVISIONING_RUNNING");
    fresh.activeGate = null;
    fresh.lastTransitionAt = new Date().toISOString();
    await savePipeline(fresh);

    console.log(`[Build] Build ${buildPassed ? "passed" : "failed"} for ${pipelineId} after ${fixRounds} fix round(s)`);
    void runDbProvisioningBackground(pipelineId, false);
  } catch (err: any) {
    const s = await getPipeline(pipelineId);
    if (s) {
      s.phase = "FAILED";
      pushPhaseHistory(s, "FAILED");
      s.error = `Build phase failed: ${err.message}`;
      s.lastTransitionAt = new Date().toISOString();
      await savePipeline(s);
    }
  }
}

// ─── DB Provisioning phase ───────────────────────────────────────────────────

export async function runDbProvisioningBackground(
  pipelineId: string,
  hasPermission: boolean
): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const needsDb = await detectDatabaseNeeded(
      state.workspaceDir,
      state.designDocs?.database?.markdown ?? state.domainDocument?.markdown ?? state.objectivesMarkdown
    );

    if (!needsDb) {
      console.log(`[DB] No database needed for ${pipelineId}, proceeding to testing`);
      state.phase = "TESTING_RUNNING";
      pushPhaseHistory(state, "TESTING_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runTestingBackground(pipelineId, false);
      return;
    }

    const containerId = `dlo-pg-${pipelineId.slice(0, 8)}`;
    const dockerCommands = [
      `docker run -d --name ${containerId} \\`,
      `  -e POSTGRES_PASSWORD=dlopassword \\`,
      `  -e POSTGRES_DB=dlo_app \\`,
      `  -e POSTGRES_USER=dlo \\`,
      `  -p 5433:5432 postgres:17-alpine`,
      `# Wait for PostgreSQL to be ready (~10s)`,
      `# Apply migrations (generated app's, or Database.md DDL)`,
    ];

    if (!hasPermission) {
      state.activeGate = {
        gateId: `gate-${crypto.randomUUID()}`,
        kind: "TERMINAL_PERMISSION",
        exhibits: [
          "Database Provisioning",
          `The generated application requires a PostgreSQL database.\n\nCommands that will run:\n\n${dockerCommands.join("\n")}`,
          "Approve to provision the database and continue, or Reject to skip database setup.",
        ],
        context: { nextAction: "provision-db", containerId },
      };
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[DB] Waiting for user permission to provision database for ${pipelineId}`);
      return;
    }

    console.log(`[DB] Provisioning PostgreSQL container ${containerId}...`);
    try {
      await execFileAsync("docker", ["rm", "-f", containerId], { timeout: 15_000 });
    } catch { /* ignore */ }

    await execFileAsync(
      "docker",
      [
        "run", "-d",
        "--name", containerId,
        "-e", "POSTGRES_PASSWORD=dlopassword",
        "-e", "POSTGRES_DB=dlo_app",
        "-e", "POSTGRES_USER=dlo",
        "-p", "5433:5432",
        "postgres:17-alpine",
      ],
      { timeout: 60_000 }
    );

    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await execFileAsync("docker", ["exec", containerId, "pg_isready", "-U", "dlo"], { timeout: 5_000 });
        ready = true;
        break;
      } catch { /* not ready yet */ }
    }

    if (!ready) throw new Error("PostgreSQL did not become ready within 60 seconds");
    console.log(`[DB] PostgreSQL ${containerId} is ready`);

    const dbUrl = `postgresql://dlo:dlopassword@localhost:5433/dlo_app`;
    const migrationResult = await runMigrations(state, dbUrl, containerId);
    console.log(`[DB] Migrations: ${migrationResult}`);

    state.dbConnectionString = dbUrl;
    state.dbContainerId = containerId;
    state.phase = "TESTING_RUNNING";
    pushPhaseHistory(state, "TESTING_RUNNING");
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);

    void runTestingBackground(pipelineId, false);
  } catch (err: any) {
    const s = await getPipeline(pipelineId);
    if (s) {
      s.phase = "FAILED";
      pushPhaseHistory(s, "FAILED");
      s.error = `DB provisioning failed: ${err.message}`;
      s.lastTransitionAt = new Date().toISOString();
      await savePipeline(s);
    }
  }
}

// ─── Testing phase (with fix loop) ───────────────────────────────────────────

export async function runTestingBackground(
  pipelineId: string,
  hasPermission: boolean
): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const testCmd = await detectTestCommand(state.workspaceDir);

    if (!testCmd) {
      console.log(`[Test] No test framework detected for ${pipelineId}, skipping to deploy`);
      state.phase = "DEPLOY_RUNNING";
      pushPhaseHistory(state, "DEPLOY_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runDeployBackground(pipelineId, false);
      return;
    }

    const testCommands = [
      `cd ${state.workspaceDir}`,
      `npm install`,
      `${testCmd.cmd} ${testCmd.args.join(" ")}`,
    ];

    if (!hasPermission) {
      state.activeGate = {
        gateId: `gate-${crypto.randomUUID()}`,
        kind: "TERMINAL_PERMISSION",
        exhibits: [
          "Run Test Suite",
          `Permission needed to install dependencies and run the test suite (failures are auto-repaired by the Fixer subagent, up to ${MAX_FIX_ROUNDS} rounds):\n\n${testCommands.join("\n")}`,
          "Approve to run tests, or Reject to skip testing and proceed to app launch.",
        ],
        context: { nextAction: "run-tests" },
      };
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[Test] Waiting for user permission to run tests for ${pipelineId}`);
      return;
    }

    const startTime = Date.now();
    const dbEnv = {
      ...process.env,
      DATABASE_URL: state.dbConnectionString || "",
      DB_URL: state.dbConnectionString || "",
      CI: "true",
    };

    console.log(`[Test] Installing dependencies in ${state.workspaceDir}...`);
    try {
      await execFileAsync("npm", ["install"], { cwd: state.workspaceDir, env: dbEnv, timeout: 300_000 });
    } catch (e: any) {
      console.warn("[Test] npm install warning:", e.message);
    }

    let testOutput = "";
    let rawPassed = false;
    let fixRounds = 0;

    // Test → on failure, fixer subagent → retest (up to MAX_FIX_ROUNDS).
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      console.log(`[Test] Running: ${testCmd.cmd} ${testCmd.args.join(" ")} (round ${round + 1})`);
      try {
        const result = await execFileAsync(testCmd.cmd, testCmd.args, {
          cwd: state.workspaceDir,
          env: dbEnv,
          timeout: 300_000,
        });
        testOutput = result.stdout + result.stderr;
        rawPassed = true;
        break;
      } catch (err: any) {
        testOutput = (err.stdout || "") + (err.stderr || "");
        rawPassed = false;
        if (round < MAX_FIX_ROUNDS) {
          fixRounds++;
          try {
            await runFixerSubagent(state, "test", testOutput || err.message);
            await execFileAsync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
              cwd: state.workspaceDir, timeout: 300_000, env: dbEnv,
            }).catch(() => { /* ignore */ });
          } catch (fixErr: any) {
            console.warn(`[Test] Fixer round ${fixRounds} failed:`, fixErr.message?.slice(0, 200));
            break;
          }
        }
      }
    }

    const durationMs = Date.now() - startTime;

    const supervisorResult = await supervisorReviewTestOutput(testOutput, state);
    const finalPassed = rawPassed || supervisorResult.override;

    state.testResults = {
      passed: finalPassed,
      output: testOutput.slice(-5000),
      durationMs,
      supervisorReasoning: supervisorResult.reasoning,
      fixRounds,
    };
    state.phase = "DEPLOY_RUNNING";
    pushPhaseHistory(state, "DEPLOY_RUNNING");
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);

    console.log(`[Test] Tests ${finalPassed ? "passed" : "failed"} for ${pipelineId} (${durationMs}ms, ${fixRounds} fix round(s))`);
    void runDeployBackground(pipelineId, false);
  } catch (err: any) {
    const s = await getPipeline(pipelineId);
    if (s) {
      s.phase = "FAILED";
      pushPhaseHistory(s, "FAILED");
      s.error = `Testing failed: ${err.message}`;
      s.lastTransitionAt = new Date().toISOString();
      await savePipeline(s);
    }
  }
}

// ─── Deploy phase ────────────────────────────────────────────────────────────

/**
 * Bootstrap for TanStack Start's srvx build target: dist/server/server.js
 * default-exports a fetch handler, so we serve it with srvx and handle the
 * dist/client static assets ourselves.
 */
const SRVX_BOOTSTRAP = `// DLO deploy bootstrap for TanStack Start (srvx build target).
import { serve } from "srvx";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import server from "./dist/server/server.js";

const CLIENT_DIR = join(process.cwd(), "dist/client");
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

serve({
  port: Number(process.env.PORT) || 3001,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/" && !url.pathname.endsWith("/")) {
      const filePath = join(CLIENT_DIR, url.pathname);
      try {
        const s = await stat(filePath);
        if (s.isFile()) {
          const body = await readFile(filePath);
          return new Response(body, { headers: { "content-type": TYPES[extname(filePath)] || "application/octet-stream", "cache-control": "public, max-age=31536000" } });
        }
      } catch { /* fall through to SSR */ }
    }
    return server.fetch(req);
  },
});
console.log("[DLO] app serving on :" + (Number(process.env.PORT) || 3001));
`;

export async function runDeployBackground(pipelineId: string, hasPermission: boolean): Promise<void> {
  let state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const isAndroid =
      existsSync(join(state.workspaceDir, "build.gradle.kts")) ||
      existsSync(join(state.workspaceDir, "build.gradle")) ||
      existsSync(join(state.workspaceDir, "AndroidManifest.xml"));

    if (isAndroid) {
      const apkPath = join(state.workspaceDir, "app/build/outputs/apk/debug/app-debug.apk");
      const apkExists = existsSync(apkPath);

      const deployCommands = apkExists
        ? [`adb install -r ${apkPath}`, `# Ensure a device is connected: adb devices`]
        : [`# No APK found at: ${apkPath}`, `# Ensure the Build phase completed successfully.`];

      if (!hasPermission) {
        state.activeGate = {
          gateId: `gate-${crypto.randomUUID()}`,
          kind: "TERMINAL_PERMISSION",
          exhibits: [
            "Deploy Android Application",
            apkExists
              ? `Deploy APK to a connected Android device via ADB:\n\n${deployCommands.join("\n")}`
              : `No APK artifact found. Build phase must complete first.\n\nExpected: app/build/outputs/apk/debug/app-debug.apk`,
            "Approve to install APK on connected device, or Reject to complete without deploying.",
          ],
          context: { nextAction: "deploy-android", apkPath: apkExists ? apkPath : null },
        };
        state.lastTransitionAt = new Date().toISOString();
        await savePipeline(state);
        console.log(`[Deploy] Waiting for permission to deploy Android app for ${pipelineId}`);
        return;
      }

      let deployOutput = "";
      let deployed = false;
      if (apkExists) {
        try {
          const { stdout, stderr } = await execFileAsync("adb", ["install", "-r", apkPath], { timeout: 120_000 });
          deployOutput = stdout + stderr;
          deployed = deployOutput.toLowerCase().includes("success");
        } catch (e: any) {
          deployOutput = (e.stdout || "") + (e.stderr || "") + e.message;
          console.warn("[Deploy] ADB install failed:", e.message?.slice(0, 200));
        }
      }

      state = (await getPipeline(pipelineId))!;
      state.deployResults = { deployed, output: deployOutput.slice(0, 2000), ...(apkExists ? { artifactPath: apkPath } : {}) };
      state.phase = "COMPLETED";
      pushPhaseHistory(state, "COMPLETED");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      await writeHandoff(state);
      return;
    }

    // Web deployment: serve production build or fall back to dev server.
    const launchCmd = await detectLaunchCommand(state.workspaceDir);

    if (!launchCmd) {
      state.phase = "COMPLETED";
      pushPhaseHistory(state, "COMPLETED");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      await writeHandoff(state);
      return;
    }

    // TanStack Start production output: dist/server/server.js (srvx, current)
    // or .output/server/index.mjs (nitro, older). Classic Vite SPAs build a
    // static dist/ with an index.html.
    const srvxEntry = join(state.workspaceDir, "dist/server/server.js");
    const nitroEntry = join(state.workspaceDir, ".output/server/index.mjs");
    const distDir = join(state.workspaceDir, "dist");
    const hasSrvxBuild = existsSync(srvxEntry);
    const hasNitroBuild = !hasSrvxBuild && existsSync(nitroEntry);
    const hasStaticBuild = !hasSrvxBuild && !hasNitroBuild && existsSync(join(distDir, "index.html"));
    const hasProdBuild = hasSrvxBuild || hasNitroBuild || hasStaticBuild;
    const port = launchCmd.port;
    const appUrl = `http://localhost:${port}`;

    const deployCommands = hasSrvxBuild
      ? [`cd ${state.workspaceDir}`, `PORT=${port} node .dlo-serve.mjs  # srvx bootstrap for dist/server/server.js`, `# Production app → ${appUrl}`]
      : hasNitroBuild
      ? [`cd ${state.workspaceDir}`, `PORT=${port} node .output/server/index.mjs`, `# Production app → ${appUrl}`]
      : hasStaticBuild
      ? [`cd ${state.workspaceDir}`, `npx serve -s dist -p ${port}`, `# Production app → ${appUrl}`]
      : [`cd ${state.workspaceDir}`, `${launchCmd.cmd} ${launchCmd.args.join(" ")}`, `# Dev server → ${appUrl}`];

    if (!hasPermission) {
      state.activeGate = {
        gateId: `gate-${crypto.randomUUID()}`,
        kind: "TERMINAL_PERMISSION",
        exhibits: [
          hasProdBuild ? "Deploy Production Build" : "Launch Application",
          `Permission needed to ${hasProdBuild ? "serve the production build" : "start the dev server"}:\n\n${deployCommands.join("\n")}`,
          "Approve to deploy the application, or Reject to complete without deploying.",
        ],
        context: { nextAction: "deploy-web", useProductionBuild: hasProdBuild },
      };
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[Deploy] Waiting for permission to deploy web app for ${pipelineId}`);
      return;
    }

    if (hasSrvxBuild) {
      // dist/server/server.js is a fetch-handler module (srvx build target),
      // not a self-starting server — write a bootstrap that serves it plus
      // the dist/client static assets.
      await writeFile(join(state.workspaceDir, ".dlo-serve.mjs"), SRVX_BOOTSTRAP, "utf-8");
    }
    if (hasSrvxBuild || hasNitroBuild) {
      const entry = hasSrvxBuild ? ".dlo-serve.mjs" : ".output/server/index.mjs";
      const child = spawn("node", [entry], {
        cwd: state.workspaceDir,
        env: { ...process.env, PORT: String(port), DATABASE_URL: state.dbConnectionString || "" },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else if (hasStaticBuild) {
      const child = spawn("npx", ["serve", "-s", "dist", "-p", String(port)], {
        cwd: state.workspaceDir,
        env: process.env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      try {
        await execFileAsync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
          cwd: state.workspaceDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: "development" },
        });
      } catch (e: any) {
        console.warn("[Deploy] npm install warning:", e.message?.slice(0, 200));
      }
      const child = spawn(launchCmd.cmd, launchCmd.args, {
        cwd: state.workspaceDir,
        env: { ...process.env, DATABASE_URL: state.dbConnectionString || "", PORT: String(port) },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

    let appReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(appUrl, { signal: AbortSignal.timeout(3000) });
        if (res.status < 500) { appReady = true; break; }
      } catch { /* not ready yet */ }
    }

    state = (await getPipeline(pipelineId))!;
    state.appUrl = appReady ? appUrl : `${appUrl} (starting up)`;
    state.deployResults = { deployed: appReady, output: "", ...(appReady ? { deployUrl: appUrl } : {}) };
    state.phase = "COMPLETED";
    pushPhaseHistory(state, "COMPLETED");
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);
    await writeHandoff(state);
    console.log(`[Deploy] Web app ${appReady ? "ready" : "launched"} at ${appUrl} for ${pipelineId}`);
  } catch (err: any) {
    const s = await getPipeline(pipelineId);
    if (s) {
      s.phase = "COMPLETED";
      pushPhaseHistory(s, "COMPLETED");
      s.activeGate = null;
      s.error = `Warning: Deploy issue: ${err.message}`;
      s.lastTransitionAt = new Date().toISOString();
      await savePipeline(s);
      await writeHandoff(s);
    }
  }
}

/** Backward-compat alias. */
export async function runAppLaunchBackground(
  pipelineId: string,
  hasPermission: boolean
): Promise<void> {
  return runDeployBackground(pipelineId, hasPermission);
}
