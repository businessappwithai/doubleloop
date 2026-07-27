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
import { spawnClaudeAgent, claudeAuthFromConfig, claudePermissionModeFromConfig, BUILDER_ALLOWED_TOOLS } from "../subagents/claude";
import { installDependencies } from "../npm";
import { appendLog } from "../logStore";

const execFileAsync = promisify(execFile);
const MAX_FIX_ROUNDS = 3;
/** How many times the Test Author subagent may be asked to build the suite. */
const MAX_TEST_AUTHOR_ROUNDS = 2;

/**
 * Shared by the repair subagents (Fixer, Test Author). Same lesson as the build
 * fleet's: these are agents with a shell and web access, and a prompt that reads
 * like a code-generation request gets code-generation behavior — guessed
 * versions and unverified fixes.
 */
const REPAIR_TOOLING_MANDATE = `- You are an agent with tools. Check rather than assume:
  read the failing file, run the failing command, inspect node_modules/<pkg> for a library's real
  API, and fetch its documentation on the web when the local files do not settle it.
- Never invent a dependency version. Confirm with \`npm view <pkg> versions --json\` and
  \`npm view <pkg> peerDependencies\` before pinning anything.
- Read the WHOLE error, including the indented detail under the first line — that is where the
  cause usually is (a duplicated dependency, a missing polyfill, a resolution mismatch).
- Fix environmental failures in configuration, not by weakening code: a missing global belongs in
  the test setup file, a version disagreement in package.json. Never delete a test, loosen an
  assertion, add a blanket \`any\`, or \`@ts-ignore\` past a real error.`;

// ─── Fixer subagent ──────────────────────────────────────────────────────────

async function runFixerSubagent(
  state: PipelineState,
  failureKind: "build" | "test",
  failureOutput: string
): Promise<void> {
  const { auth, apiKey } = claudeAuthFromConfig(state.config);
  const permissionMode = claudePermissionModeFromConfig(state.config, "executor", "acceptEdits");
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

${REPAIR_TOOLING_MANDATE}
- Re-run the ${failureKind} yourself and keep going until it passes. Do not finish while it fails;
  if you truly cannot fix it, state exactly what you tried and what the remaining error is.`,
    model,
    cwd: state.workspaceDir,
    permissionMode,
    auth,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: 15 * 60_000,
    allowedTools: BUILDER_ALLOWED_TOOLS,
  });
}

// ─── Test-author subagent ────────────────────────────────────────────────────

/**
 * Builds the missing test suite for a generated application.
 *
 * Runs when TESTING_RUNNING finds no test command at all, or finds one that
 * executes zero tests. Both are defects in what the fleet produced, so the
 * pipeline repairs them here instead of reporting a green run over an empty
 * suite. Claude Code only — the fleet's coding harness for this pipeline.
 */
export async function runTestAuthorSubagent(
  state: PipelineState,
  reason: "no-test-command" | "empty-suite"
): Promise<void> {
  const { auth, apiKey } = claudeAuthFromConfig(state.config);
  const permissionMode = claudePermissionModeFromConfig(state.config, "executor", "acceptEdits");
  const model = state.config?.providers?.executor?.model || "claude-haiku-4-5-20251001";
  const architecture = state.designDocs?.architecture?.markdown ?? "";
  const testingStrategy =
    architecture.match(/##\s*Testing Strategy[\s\S]*?(?=\n##\s|$)/i)?.[0]?.slice(0, 3000) ?? "";

  const situation =
    reason === "no-test-command"
      ? `This application has NO usable test command: package.json has no real \`test\` script and no test runner is installed.`
      : `This application has a test command, but running it executed ZERO tests — the suite is empty or matches no files.`;

  await spawnClaudeAgent({
    prompt: `You are the Test Author subagent of the Double-Loop Orchestrator, working in the generated
application at the current working directory.

Project: ${state.projectName}

${situation}

Your job is to make this application genuinely tested. Do ALL of the following:

1. Install and configure the test harness if it is missing: the runner, the assertion/DOM testing
   libraries, the config file and the setup file. For a Vite/React/TanStack project that means vitest,
   @testing-library/react, @testing-library/jest-dom, jsdom, a vitest.config.ts with the jsdom
   environment and the setup file registered, and a vitest.setup.ts.
2. Set package.json's \`test\` script to run the WHOLE suite non-interactively (e.g. "vitest run").
   It must NOT contain --passWithNoTests, --watch, or any flag under which an empty suite succeeds.
3. Read the application's actual source and write extensive unit tests for every unit of behavior that
   exists: each exported function, data-access module, service, reducer, route handler and React
   component. For each unit cover the happy path asserted on real return values, every branch, boundary
   and empty inputs, and the failure modes (assert the specific error, not merely that something threw).
4. Keep tests deterministic and hermetic — fake the network, database, child processes, clock and
   randomness at the module boundary. No test may reach a real service or spawn a real binary.
5. Never skip a test and never weaken an assertion to make it pass. If a test exposes a real bug in the
   application, fix the application.
6. Run the suite yourself and leave it passing with a non-zero number of tests executed.

${REPAIR_TOOLING_MANDATE}
${testingStrategy ? `\nArchitecture.md's testing contract for this project:\n${testingStrategy}\n` : ""}
Report at the end how many test files and test cases you added.`,
    model,
    cwd: state.workspaceDir,
    permissionMode,
    auth,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: 20 * 60_000,
    allowedTools: BUILDER_ALLOWED_TOOLS,
    pipelineId: state.pipelineId,
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
        // No --passWithNoTests: an empty suite must fail so the Test Author runs.
        test: "vitest run",
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

export interface TestCommand {
  cmd: string;
  args: string[];
  /** Where the command came from, for honest reporting in the logs. */
  source: "gradle" | "package-script" | "vitest" | "jest";
}

/**
 * Resolve how this workspace runs its tests.
 *
 * Deliberately does NOT pass --passWithNoTests: a generated application with no
 * tests must surface as a failure that the test-author subagent repairs, not as
 * a green run. (The old behavior let an app with zero tests report "tests
 * passed", which is exactly the outcome the testing policy forbids.)
 */
export async function detectTestCommand(workspaceDir: string): Promise<TestCommand | null> {
  if (existsSync(join(workspaceDir, "gradlew"))) {
    return { cmd: "./gradlew", args: ["testDebugUnitTest", "--continue"], source: "gradle" };
  }
  if (existsSync(join(workspaceDir, "build.gradle.kts")) || existsSync(join(workspaceDir, "build.gradle"))) {
    return { cmd: "gradle", args: ["testDebugUnitTest", "--continue"], source: "gradle" };
  }
  try {
    const pkg = JSON.parse(await readFile(join(workspaceDir, "package.json"), "utf-8"));
    const noOpTest = /^\s*echo\b.*\bno test/i;
    if (pkg.scripts?.test && !noOpTest.test(pkg.scripts.test)) {
      return { cmd: "npm", args: ["test"], source: "package-script" };
    }
    if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) {
      return { cmd: "npx", args: ["vitest", "run"], source: "vitest" };
    }
    if (pkg.devDependencies?.jest || pkg.dependencies?.jest) {
      return { cmd: "npx", args: ["jest"], source: "jest" };
    }
  } catch { /* no package.json */ }
  return null;
}

export interface TestOutcome {
  /** Number of individual tests the runner reported executing. */
  testsRun: number;
  /** The runner explicitly reported that it found no test files/suites. */
  noTestsFound: boolean;
}

/**
 * Read a runner's output for how many tests actually executed.
 *
 * A zero-exit run proves nothing on its own — vitest and jest both exit 0 when
 * a `--passWithNoTests` suite matched nothing, and a suite that matched nothing
 * is the failure mode this pipeline exists to prevent. Recognizes vitest
 * ("Tests  12 passed (12)"), jest ("Tests: 3 passed, 3 total") and Gradle.
 */
export function assessTestOutcome(output: string): TestOutcome {
  const reportedEmpty = /no test (?:files|suites)? ?found|no tests found/i.test(output);

  let testsRun = 0;

  // vitest: "Tests  12 passed | 1 failed (13)" / "Tests  12 passed (12)"
  const vitest = output.match(/^\s*Tests\s+(.+?)\((\d+)\)\s*$/m);
  if (vitest?.[2]) testsRun = Math.max(testsRun, Number(vitest[2]));
  if (!testsRun) {
    // vitest without the trailing total, e.g. "Tests  4 passed"
    const vitestLoose = output.match(/^\s*Tests\s+(\d+)\s+passed/m);
    if (vitestLoose?.[1]) testsRun = Math.max(testsRun, Number(vitestLoose[1]));
  }

  // jest: "Tests:       3 passed, 1 failed, 4 total"
  const jest = output.match(/^\s*Tests:\s+.*?(\d+)\s+total\s*$/m);
  if (jest?.[1]) testsRun = Math.max(testsRun, Number(jest[1]));

  // gradle/junit: "5 tests completed"
  const gradle = output.match(/(\d+)\s+tests?\s+completed/i);
  if (gradle?.[1]) testsRun = Math.max(testsRun, Number(gradle[1]));

  // No counted tests is itself the signal; an explicit "no test files found"
  // only confirms it. Either way the suite proved nothing.
  return { testsRun, noTestsFound: testsRun === 0 || reportedEmpty };
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

    appendLog(pipelineId, `[Build] Starting build: ${buildCmd.cmd} ${buildCmd.args.join(" ")}`);

    if (buildCmd.cmd === "npm" || buildCmd.cmd === "npx") {
      appendLog(pipelineId, "[Build] Running npm install…");
      const install = await installDependencies(state.workspaceDir);
      if (install.refetchedMetadata) {
        appendLog(pipelineId, "[Build] npm's cached registry metadata was stale — reinstalled with --prefer-online.");
      }
      if (!install.ok) {
        buildOutput += install.detail;
        appendLog(pipelineId, `[Build] npm install warning: ${install.detail.slice(-300)}`);
      }
    }

    // Build → on failure, fixer subagent → rebuild (up to MAX_FIX_ROUNDS).
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      appendLog(pipelineId, `[Build] Running ${buildCmd.cmd} ${buildCmd.args.join(" ")} (round ${round + 1}/${MAX_FIX_ROUNDS + 1})`);
      try {
        const { stdout, stderr } = await execFileAsync(buildCmd.cmd, buildCmd.args, {
          cwd: state.workspaceDir,
          timeout: 600_000,
          env: { ...process.env, CI: "true" },
        });
        buildOutput += stdout + stderr;
        if (stdout || stderr) appendLog(pipelineId, (stdout + stderr).slice(-600));
        buildPassed = true;
        appendLog(pipelineId, "[Build] Build PASSED");
        break;
      } catch (err: any) {
        const failOut = (err.stdout || "") + (err.stderr || "");
        buildOutput += failOut;
        buildPassed = false;
        appendLog(pipelineId, `[Build] Build FAILED (round ${round + 1}): ${failOut.slice(-400) || err.message?.slice(0, 400)}`);
        if (round < MAX_FIX_ROUNDS) {
          fixRounds++;
          appendLog(pipelineId, `[Build] Running Fixer subagent (fix round ${fixRounds})…`);
          try {
            await runFixerSubagent(state, "build", failOut || err.message);
            // Fixer may add deps — reinstall cheaply before retrying.
            await installDependencies(state.workspaceDir);
          } catch (fixErr: any) {
            appendLog(pipelineId, `[Build] Fixer round ${fixRounds} failed: ${fixErr.message?.slice(0, 200)}`);
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

    appendLog(pipelineId, `[Build] Build ${buildPassed ? "passed ✓" : "failed"} after ${fixRounds} fix round(s) — proceeding to DB provisioning`);
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

    appendLog(pipelineId, `[DB] Starting PostgreSQL container ${containerId}…`);
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

    appendLog(pipelineId, "[DB] Waiting for PostgreSQL to be ready…");
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
    appendLog(pipelineId, `[DB] PostgreSQL ${containerId} is ready — running migrations…`);

    const dbUrl = `postgresql://dlo:dlopassword@localhost:5433/dlo_app`;
    const migrationResult = await runMigrations(state, dbUrl, containerId);
    appendLog(pipelineId, `[DB] Migrations: ${migrationResult}`);

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
    if (!s) return;

    // No Docker on this host is a missing capability, not a broken pipeline.
    // The generated application's unit tests are required to be hermetic, so
    // they still run and still mean something without a database — killing the
    // whole run here threw away every module the fleet had already built.
    // Recorded loudly (never silently "fine"), then the pipeline continues.
    if (isDockerUnavailable(err.message ?? "")) {
      const note = `Database not provisioned: Docker is unavailable on this host (${String(err.message).slice(0, 200)}). The application was NOT run against a real database; only hermetic tests are meaningful for this run.`;
      appendLog(pipelineId, `[DB] ${note}`);
      console.warn(`[DB] ${note}`);
      s.error = note;
      s.phase = "TESTING_RUNNING";
      pushPhaseHistory(s, "TESTING_RUNNING");
      s.activeGate = null;
      s.lastTransitionAt = new Date().toISOString();
      await savePipeline(s);
      void runTestingBackground(pipelineId, false);
      return;
    }

    s.phase = "FAILED";
    pushPhaseHistory(s, "FAILED");
    s.error = `DB provisioning failed: ${err.message}`;
    s.lastTransitionAt = new Date().toISOString();
    await savePipeline(s);
  }
}

/**
 * Is this failure "there is no Docker here" rather than "the database broke"?
 *
 * Only the daemon/binary being absent qualifies. A daemon that IS present and
 * rejects the run (bad image, port already bound, out of disk) is a real
 * failure and must still fail the pipeline.
 */
export function isDockerUnavailable(message: string): boolean {
  return (
    /docker\.sock/i.test(message)
    || /cannot connect to the docker daemon/i.test(message)
    || /is the docker daemon running/i.test(message)
    || /\b(?:spawn |command not found[: ]*)docker\b/i.test(message)
    || /\bdocker: not found\b/i.test(message)
    || /ENOENT.*\bdocker\b/i.test(message)
  );
}

// ─── Testing phase (with fix loop) ───────────────────────────────────────────

export async function runTestingBackground(
  pipelineId: string,
  hasPermission: boolean
): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const detected = await detectTestCommand(state.workspaceDir);

    const testCommands = detected
      ? [
          `cd ${state.workspaceDir}`,
          `npm install`,
          `${detected.cmd} ${detected.args.join(" ")}`,
        ]
      : [
          `cd ${state.workspaceDir}`,
          `# No test suite found — the Test Author subagent will build one first`,
          `npm install`,
          `npx vitest run`,
        ];

    if (!hasPermission) {
      state.activeGate = {
        gateId: `gate-${crypto.randomUUID()}`,
        kind: "TERMINAL_PERMISSION",
        exhibits: [
          "Run Test Suite",
          `Permission needed to install dependencies and run the test suite (failures are auto-repaired by the Fixer subagent, up to ${MAX_FIX_ROUNDS} rounds${detected ? "" : "; the suite is missing, so the Test Author subagent writes it first"}):\n\n${testCommands.join("\n")}`,
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
    let authorRounds = 0;

    // A generated app with no test command is a defect in what the fleet built,
    // not a reason to skip testing — author the suite, then re-detect.
    let testCmd = detected;
    if (!testCmd) {
      appendLog(pipelineId, "[Test] No test command found — running the Test Author subagent to build the suite…");
      authorRounds++;
      try {
        await runTestAuthorSubagent(state, "no-test-command");
      } catch (e: any) {
        appendLog(pipelineId, `[Test] Test Author subagent failed: ${e.message?.slice(0, 300)}`);
      }
      testCmd = await detectTestCommand(state.workspaceDir);
    }

    if (!testCmd) {
      // Report the shortfall honestly rather than letting an untested app look tested.
      const detail = "No test suite exists and the Test Author subagent could not create one.";
      appendLog(pipelineId, `[Test] ${detail} Recording a FAILED test result and proceeding to deploy.`);
      state.testResults = {
        passed: false,
        output: detail,
        durationMs: Date.now() - startTime,
        fixRounds: 0,
      };
      state.phase = "DEPLOY_RUNNING";
      pushPhaseHistory(state, "DEPLOY_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runDeployBackground(pipelineId, false);
      return;
    }

    const dbEnv = {
      ...process.env,
      DATABASE_URL: state.dbConnectionString || "",
      DB_URL: state.dbConnectionString || "",
      CI: "true",
    };

    appendLog(pipelineId, `[Test] Installing dependencies…`);
    try {
      const testInstall = await installDependencies(state.workspaceDir, dbEnv);
      if (testInstall.refetchedMetadata) {
        appendLog(pipelineId, "[Test] npm's cached registry metadata was stale — reinstalled with --prefer-online.");
      }
      if (!testInstall.ok) appendLog(pipelineId, `[Test] npm install warning: ${testInstall.detail.slice(-300)}`);
    } catch (e: any) {
      appendLog(pipelineId, `[Test] npm install warning: ${e.message?.slice(0, 200)}`);
    }

    let testOutput = "";
    let rawPassed = false;
    let fixRounds = 0;
    let testsRun = 0;

    // Test → on failure, fixer subagent → retest (up to MAX_FIX_ROUNDS).
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      appendLog(pipelineId, `[Test] Running ${testCmd.cmd} ${testCmd.args.join(" ")} (round ${round + 1}/${MAX_FIX_ROUNDS + 1})`);
      try {
        const result = await execFileAsync(testCmd.cmd, testCmd.args, {
          cwd: state.workspaceDir,
          env: dbEnv,
          timeout: 300_000,
        });
        testOutput = result.stdout + result.stderr;
        if (testOutput) appendLog(pipelineId, testOutput.slice(-600));

        // Exit 0 is not enough: a suite that executed nothing proves nothing.
        const outcome = assessTestOutcome(testOutput);
        testsRun = outcome.testsRun;
        if (outcome.noTestsFound) {
          if (authorRounds < MAX_TEST_AUTHOR_ROUNDS) {
            authorRounds++;
            appendLog(
              pipelineId,
              `[Test] The suite ran but executed 0 tests — running the Test Author subagent (round ${authorRounds}/${MAX_TEST_AUTHOR_ROUNDS})…`
            );
            try {
              await runTestAuthorSubagent(state, "empty-suite");
              await installDependencies(state.workspaceDir, dbEnv);
              // The author may have introduced the runner or changed the script.
              testCmd = (await detectTestCommand(state.workspaceDir)) ?? testCmd;
            } catch (e: any) {
              appendLog(pipelineId, `[Test] Test Author subagent failed: ${e.message?.slice(0, 300)}`);
            }
            rawPassed = false;
            continue;
          }
          rawPassed = false;
          appendLog(pipelineId, "[Test] Suite still executes 0 tests after all Test Author rounds — recording FAILED.");
          break;
        }

        rawPassed = true;
        appendLog(pipelineId, `[Test] Tests PASSED (${testsRun} test${testsRun === 1 ? "" : "s"} executed)`);
        break;
      } catch (err: any) {
        testOutput = (err.stdout || "") + (err.stderr || "");
        rawPassed = false;
        testsRun = assessTestOutcome(testOutput).testsRun;
        appendLog(pipelineId, `[Test] Tests FAILED (round ${round + 1}): ${testOutput.slice(-400) || err.message?.slice(0, 400)}`);
        if (round < MAX_FIX_ROUNDS) {
          fixRounds++;
          appendLog(pipelineId, `[Test] Running Fixer subagent (fix round ${fixRounds})…`);
          try {
            await runFixerSubagent(state, "test", testOutput || err.message);
            await installDependencies(state.workspaceDir, dbEnv);
          } catch (fixErr: any) {
            appendLog(pipelineId, `[Test] Fixer round ${fixRounds} failed: ${fixErr.message?.slice(0, 200)}`);
            break;
          }
        }
      }
    }

    const durationMs = Date.now() - startTime;

    appendLog(pipelineId, "[Test] Supervisor reviewing test output…");
    const supervisorResult = await supervisorReviewTestOutput(testOutput, state);

    // The supervisor may forgive an environment-caused failure, but it may NOT
    // forgive an empty suite: "no tests ran" is the one verdict no reasoning can
    // turn green, or the pipeline would report an untested app as tested.
    const overrideAllowed = supervisorResult.override && testsRun > 0;
    const finalPassed = rawPassed || overrideAllowed;
    if (supervisorResult.override && !overrideAllowed) {
      appendLog(pipelineId, "[Test] Supervisor override REJECTED — 0 tests executed, so there is nothing to override.");
    } else if (overrideAllowed) {
      appendLog(pipelineId, `[Test] Supervisor overrode failure: ${supervisorResult.reasoning?.slice(0, 200)}`);
    }

    state.testResults = {
      passed: finalPassed,
      output: testOutput.slice(-5000),
      durationMs,
      supervisorReasoning: supervisorResult.reasoning,
      fixRounds,
      testsRun,
      testAuthorRounds: authorRounds,
    };
    state.phase = "DEPLOY_RUNNING";
    pushPhaseHistory(state, "DEPLOY_RUNNING");
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);

    appendLog(
      pipelineId,
      `[Test] Tests ${finalPassed ? "passed ✓" : "failed"} — ${testsRun} test${testsRun === 1 ? "" : "s"} executed ` +
        `(${durationMs}ms, ${fixRounds} fix round(s), ${authorRounds} test-author round(s)) — proceeding to deploy`
    );
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
        await installDependencies(state.workspaceDir, { ...process.env, NODE_ENV: "development" });
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
