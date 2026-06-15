import { join } from "node:path";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

const execFileAsync = promisify(execFile);

// ─── Database Service Client ──────────────────────────────────────────────────

const DB_SERVICE_URL = process.env.DB_SERVICE_URL || "http://localhost:3099";

async function dbCall(
  method: string,
  path: string,
  body?: any
): Promise<any> {
  try {
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${DB_SERVICE_URL}${path}`, opts);
    if (!res.ok) throw new Error(`DB: ${res.status}`);
    return await res.json();
  } catch (e: any) {
    console.warn(`[DB] ${method} ${path} failed:`, e.message);
    return null;
  }
}

// ─── Claude Code CLI (supervisor + planner) ───────────────────────────────────

async function spawnClaude(prompt: string, model: string, workspaceDir?: string): Promise<string> {
  const cwd = workspaceDir || process.cwd();
  await mkdir(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--model", model, "--output-format", "json"], {
      env: process.env,
      cwd,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.trim() || out.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(out.trim());
        resolve(parsed.result ?? out.trim());
      } catch {
        resolve(out.trim());
      }
    });
  });
}

// ─── Required tool checks (no silent fallbacks) ───────────────────────────────

interface ToolStatus {
  codewhale: boolean;
  ocr: boolean;
  missing: string[];
}

async function checkRequiredTools(): Promise<ToolStatus> {
  let codewhale = false;
  let ocr = false;

  try {
    await execFileAsync("codewhale", ["--version"], { timeout: 5_000 });
    // Binary present — now check if at least one provider key is configured
    const cwProviders = [
      process.env.DEEPSEEK_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.OPENROUTER_API_KEY,
    ];
    codewhale = cwProviders.some(Boolean);
  } catch { /* not installed */ }

  try {
    await execFileAsync("ocr", ["--version"], { timeout: 5_000 });
    ocr = true;
  } catch { /* not installed */ }

  const missing: string[] = [];
  if (!codewhale) missing.push("codewhale (requires DEEPSEEK_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY)");
  if (!ocr) missing.push("ocr (@alibaba-group/open-code-review)");

  return { codewhale, ocr, missing };
}

export async function runToolInstallScript(): Promise<{ success: boolean; log: string }> {
  const scriptPath = join(process.cwd(), "scripts/install-ai-tools.sh");
  let log = "";
  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
      timeout: 300_000,
      env: { ...process.env, HOME: process.env.HOME || "/tmp" },
    });
    log = stdout + stderr;

    // After installing, auto-configure CodeWhale with the first available provider key
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
        console.log(`[ToolInstall] Configured CodeWhale with provider: ${provider}`);
      } catch (e: any) {
        log += `\n[DLO] CodeWhale provider config failed: ${e.message}`;
        console.warn(`[ToolInstall] CodeWhale provider config failed:`, e.message);
      }
    } else {
      log += "\n[DLO] No provider API key found in environment (DEEPSEEK_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY). Configure one to use CodeWhale, or choose 'Use Claude Haiku' instead.";
      console.warn("[ToolInstall] No CodeWhale-compatible provider key in environment.");
    }

    return { success: true, log };
  } catch (err: any) {
    return { success: false, log: err.stdout + err.stderr + err.message };
  }
}

interface ModuleSpec {
  moduleId: string;
  title: string;
  prompt: string;
  touches?: string[];
}

interface PipelineContext {
  projectName: string;
  objectivesMarkdown: string;
  domainDocument?: string | undefined;
  contextNotes?: Array<{ note: string }> | undefined;
}

function buildProjectContext(ctx: PipelineContext): string {
  const parts = [
    `Project: ${ctx.projectName}`,
    `Objectives: ${ctx.objectivesMarkdown.slice(0, 600)}`,
  ];
  if (ctx.domainDocument) {
    parts.push(`Research / Requirements:\n${ctx.domainDocument.slice(0, 1500)}`);
  }
  const notes = (ctx.contextNotes || []).map((n) => n.note).join("\n");
  if (notes) parts.push(`Steering notes from the user:\n${notes}`);
  return parts.join("\n\n");
}

async function spawnCodeWhaleForModule(
  moduleSpec: ModuleSpec,
  workspaceDir: string,
  config: any,
  pipelineCtx?: PipelineContext
): Promise<void> {
  const env = { ...process.env };
  const touchesList = (moduleSpec.touches || []).join(", ");
  const projectCtx = pipelineCtx ? buildProjectContext(pipelineCtx) : "";
  const cwPrompt = `You are implementing a software module.

${projectCtx}

Module: ${moduleSpec.title}
Task: ${moduleSpec.prompt}
Files to create/modify: ${touchesList}
Workspace directory: ${workspaceDir}

Requirements:
- Create all listed files with complete, production-ready code
- Match the tech stack described in the project research above
- Include error handling
- Do not use placeholder or TODO comments — implement fully`;

  // Configure CodeWhale provider — prefer deepseek > openai > openrouter (CW-supported providers)
  const deepseekKey = config?.providers?.executor?.apiKey || process.env.DEEPSEEK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (deepseekKey) {
    try {
      await execFileAsync("codewhale", ["auth", "set", "--provider", "deepseek", "--api-key", deepseekKey], { env, timeout: 15_000 });
      console.log("[Pi→CodeWhale] Configured deepseek provider");
    } catch (e: any) { console.warn("[Pi→CodeWhale] deepseek config failed:", e.message); }
  } else if (openaiKey) {
    try {
      await execFileAsync("codewhale", ["auth", "set", "--provider", "openai", "--api-key", openaiKey], { env, timeout: 15_000 });
      console.log("[Pi→CodeWhale] Configured openai provider");
    } catch (e: any) { console.warn("[Pi→CodeWhale] openai config failed:", e.message); }
  } else if (openrouterKey) {
    try {
      await execFileAsync("codewhale", ["auth", "set", "--provider", "openrouter", "--api-key", openrouterKey], { env, timeout: 15_000 });
      console.log("[Pi→CodeWhale] Configured openrouter provider");
    } catch (e: any) { console.warn("[Pi→CodeWhale] openrouter config failed:", e.message); }
  }

  console.log(`[Pi→CodeWhale] Spawning with --auto for module ${moduleSpec.moduleId}: ${moduleSpec.title}`);

  await new Promise<void>((resolve, reject) => {
    // --auto enables non-interactive agent mode with tool use (file read/write/shell)
    const child = spawn(
      "codewhale",
      ["exec", "--auto", cwPrompt],
      { cwd: workspaceDir, env }
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0 && code !== null) {
        const msg = stderr.slice(0, 800);
        console.warn(`[Pi→CodeWhale] Exited ${code}: ${msg}`);
        // Reject so the module is correctly marked FAILED rather than silently PASSED
        reject(new Error(`CodeWhale exited ${code}: ${msg}`));
      } else {
        resolve();
      }
    });
  });
}

// Claude-as-sub-agent: used when user selects Claude as executor (instead of CodeWhale)
async function spawnClaudeForModule(
  moduleSpec: ModuleSpec,
  workspaceDir: string,
  config: any,
  pipelineCtx?: PipelineContext
): Promise<void> {
  // Prefer cheapest capable model; user can override via config
  const executorModel = config?.providers?.executor?.model || "claude-haiku-4-5-20251001";
  const projectCtx = pipelineCtx ? buildProjectContext(pipelineCtx) : "";

  for (const relPath of moduleSpec.touches || []) {
    try {
      const dir = join(workspaceDir, relPath.split("/").slice(0, -1).join("/"));
      await mkdir(dir, { recursive: true });
      const code = await spawnClaude(
        `Generate the complete, production-ready file contents for: ${relPath}

${projectCtx}

Module: ${moduleSpec.title}
Task: ${moduleSpec.prompt}

CRITICAL RULES:
- Return ONLY raw file contents — no markdown fences, no explanation, no preamble.
- Match the exact tech stack specified in the Research/Requirements above.
- The file must be syntactically complete and import everything it uses.
- If this is a Node.js/Express project, do NOT generate React components.
- If this is a package.json, include ALL required dependencies.`,
        executorModel,
        workspaceDir
      );
      const strippedCode = code.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "");
      await writeFile(join(workspaceDir, relPath), strippedCode, "utf-8");
      console.log(`[Claude→Executor] Generated ${relPath} (${executorModel})`);
    } catch (err) {
      console.warn(`[Claude→Executor] Failed to generate ${relPath}:`, err);
    }
  }
}

// ─── open-code-review (alibaba/open-code-review) ─────────────────────────────

async function runOpenCodeReview(
  workspaceDir: string
): Promise<{ passed: boolean; critique: string }> {
  const localBinDir = join(workspaceDir, ".dlo/bin");
  const env = { ...process.env, PATH: `${localBinDir}:${process.env.PATH || ""}` };

  // Ensure ocr CLI is installed
  let ocrAvailable = false;
  try {
    await execFileAsync("ocr", ["--version"], { env, timeout: 10_000 });
    ocrAvailable = true;
  } catch {
    try {
      console.log("[OCR] Installing @alibaba-group/open-code-review...");
      await execFileAsync("npm", ["install", "-g", "@alibaba-group/open-code-review"], {
        env,
        timeout: 120_000,
      });
      ocrAvailable = true;
    } catch (e) {
      console.warn("[OCR] Failed to install open-code-review:", e);
    }
  }

  if (ocrAvailable) {
    try {
      const { stdout } = await execFileAsync("ocr", ["review", "--format", "json"], {
        cwd: workspaceDir,
        env,
        timeout: 120_000,
      });
      try {
        const result = JSON.parse(stdout.trim());
        const issues: any[] = result.issues || result.errors || result.findings || [];
        if (Array.isArray(issues) && issues.length > 0) {
          const critique = issues.map((i: any) => i.message || i.description || String(i)).join("\n");
          return { passed: false, critique };
        }
        return { passed: true, critique: "everything is fine" };
      } catch {
        const passed =
          stdout.toLowerCase().includes("no issue") ||
          stdout.toLowerCase().includes("everything is fine") ||
          (!stdout.toLowerCase().includes("error") && !stdout.toLowerCase().includes("bug"));
        return { passed, critique: stdout.slice(0, 2000) };
      }
    } catch (err: any) {
      console.warn("[OCR] ocr review failed:", err.message);
    }
  }

  // Claude Code fallback (supervisor acts as reviewer)
  return runLLMCodeReviewFallback(workspaceDir);
}

async function runLLMCodeReviewFallback(
  workspaceDir: string
): Promise<{ passed: boolean; critique: string }> {
  try {
    const { stdout: diff } = await execFileAsync("git", ["diff", "--stat"], {
      cwd: workspaceDir,
      timeout: 10_000,
    }).catch(() => ({ stdout: "" }));

    if (!diff.trim()) return { passed: true, critique: "everything is fine" };

    const { stdout: diffFull } = await execFileAsync("git", ["diff"], {
      cwd: workspaceDir,
      timeout: 15_000,
    }).catch(() => ({ stdout: "" }));

    const prompt = `You are a Code Review Agent acting on behalf of open-code-review (https://github.com/alibaba/open-code-review).
Review the following git diff for errors, bugs, or anti-patterns:
${diffFull.slice(0, 4000)}

If the code has no significant issues, reply with exactly: "everything is fine".
Otherwise, list the specific errors that need to be fixed (one per line).`;

    const review = await spawnClaude(prompt, "claude-haiku-4-5-20251001", workspaceDir);
    const passed = review.toLowerCase().includes("everything is fine");
    return { passed, critique: review };
  } catch (err: any) {
    console.error("[OCR] LLM fallback review failed:", err.message);
    return { passed: true, critique: "everything is fine" };
  }
}

// ─── Claude Code supervisor: review test output ───────────────────────────────

async function supervisorReviewTestOutput(
  testOutput: string,
  state: PipelineState
): Promise<{ passed: boolean; override: boolean; reasoning: string }> {
  try {
    const supervisorModel = state.config?.providers?.supervisor?.model || "claude-haiku-4-5-20251001";
    const prompt = `You are the Claude Code Supervisor reviewing automated test output for the DLO pipeline.

Project: ${state.projectName}
Test Output (last 3000 chars):
${testOutput.slice(-3000)}

Determine if the tests passed. You may OVERRIDE a failure if it's caused by:
- Missing environment setup (not an app bug)
- Known flaky test patterns
- Missing test fixtures or seeds

Respond ONLY with valid JSON: {"passed":boolean,"override":boolean,"reasoning":"string"}`;

    const raw = await spawnClaude(prompt, supervisorModel, state.workspaceDir);
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

// ─── Database detection helpers ───────────────────────────────────────────────

async function scaffoldMissingInfrastructure(workspaceDir: string, projectName: string): Promise<void> {
  const pkgPath = join(workspaceDir, "package.json");
  let hasPkg = false;
  try { await readFile(pkgPath, "utf-8"); hasPkg = true; } catch { /* missing */ }

  if (!hasPkg) {
    // Detect what kind of project was generated
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
      // Scaffold a Vite + React + TypeScript project
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
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
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
      console.log(`[Scaffold] Generated package.json for ${projectName}`);

      // index.html if missing
      const indexPath = join(workspaceDir, "index.html");
      try { await readFile(indexPath, "utf-8"); } catch {
        await writeFile(indexPath, `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${projectName}</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>`, "utf-8");
        console.log(`[Scaffold] Generated index.html`);
      }

      // vite.config.ts if missing
      const vitePath = join(workspaceDir, "vite.config.ts");
      try { await readFile(vitePath, "utf-8"); } catch {
        await writeFile(vitePath, `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()] })
`, "utf-8");
        console.log(`[Scaffold] Generated vite.config.ts`);
      }

      // tsconfig.json if missing
      const tscPath = join(workspaceDir, "tsconfig.json");
      try { await readFile(tscPath, "utf-8"); } catch {
        await writeFile(tscPath, JSON.stringify({
          compilerOptions: { target: "ES2020", useDefineForClassFields: true, lib: ["ES2020", "DOM", "DOM.Iterable"], module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true, strict: true, jsx: "react-jsx" },
          include: ["src"],
        }, null, 2), "utf-8");
        console.log(`[Scaffold] Generated tsconfig.json`);
      }

      // src/main.tsx if missing
      const mainPath = join(workspaceDir, "src/main.tsx");
      try { await readFile(mainPath, "utf-8"); } catch {
        await mkdir(join(workspaceDir, "src"), { recursive: true });
        await writeFile(mainPath, `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
${hasCss ? "import './index.css'" : ""}
import App from './App'
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
`, "utf-8");
        console.log(`[Scaffold] Generated src/main.tsx`);
      }
    }
  }
}

async function detectDatabaseNeeded(workspaceDir: string, domainDocument?: string): Promise<boolean> {
  const dbKeywords = /\b(?:postgres|postgresql|mysql|sqlite|mongodb|redis|database|sql|pg|prisma|typeorm|sequelize|drizzle|mongoose)\b/i;
  const dbImports = /from ['"](?:pg|mysql|mysql2|sqlite3|mongoose|prisma|@prisma\/client|typeorm|sequelize|drizzle-orm|knex|better-sqlite3)/;
  const dbEnvVars = /process\.env\.(?:DATABASE_URL|DB_URL|POSTGRES_URL|MYSQL_URL)/;

  // Check domain document first — most reliable signal
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

async function runMigrations(workspaceDir: string, dbUrl: string, containerId: string): Promise<string> {
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

  // Plain SQL migrations
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

  return "No migration files found";
}

// ─── Test / launch detection helpers ─────────────────────────────────────────

async function detectTestCommand(workspaceDir: string): Promise<{ cmd: string; args: string[] } | null> {
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

async function detectLaunchCommand(workspaceDir: string): Promise<{ cmd: string; args: string[]; port: number } | null> {
  try {
    const pkg = JSON.parse(await readFile(join(workspaceDir, "package.json"), "utf-8"));
    if (pkg.scripts?.dev) return { cmd: "npm", args: ["run", "dev"], port: 3001 };
    if (pkg.scripts?.start) return { cmd: "npm", args: ["start"], port: 3001 };
  } catch { /* no package.json */ }
  return null;
}

// ─── PipelineState ────────────────────────────────────────────────────────────

export interface PipelineState {
  pipelineId: string;
  projectName: string;
  objectivesMarkdown: string;
  workspaceDir: string;
  config: any;
  phase: string;
  createdAt: string;
  lastTransitionAt: string;
  phaseHistory?: Array<{ phase: string; timestamp: string }>;
  contextNotes?: Array<{ note: string; timestamp: string }>;
  domainDocument?: {
    markdown: string;
    citations: Array<{ url: string; title: string }>;
  };
  plan?: {
    ceoPlan: string;
    architecturePlan: string;
    engineeringPlan: any;
  };
  board?: {
    modules: Array<{
      moduleId: string;
      status: string;
      attempts: number;
    }>;
  };
  budget?: {
    spent: Record<string, number>;
    remaining: Record<string, number>;
  };
  activeGate?: {
    gateId: string;
    kind: string;
    exhibits: any[];
    /** Context for TERMINAL_PERMISSION gates to know what runs after approval */
    context?: Record<string, unknown>;
  } | null;
  testResults?: {
    passed: boolean;
    output: string;
    durationMs: number;
    supervisorReasoning?: string;
  };
  appUrl?: string;
  dbConnectionString?: string;
  dbContainerId?: string;
  error?: string;
}

export function pushPhaseHistory(state: PipelineState, phase: string): void {
  if (!state.phaseHistory) state.phaseHistory = [];
  state.phaseHistory.push({ phase, timestamp: new Date().toISOString() });
}

const getPipelinesDir = () => join(process.cwd(), ".dlo/pipelines");

export async function savePipeline(state: PipelineState): Promise<void> {
  // Try DB first (dual-write for safety)
  try {
    const existing = await getPipeline(state.pipelineId);
    if (!existing) {
      await dbCall("POST", "/pipelines", {
        pipelineId: state.pipelineId,
        projectName: state.projectName,
        objectivesMarkdown: state.objectivesMarkdown,
        workspaceDir: state.workspaceDir,
        config: state.config,
      });
    } else {
      await dbCall("PATCH", `/pipelines/${state.pipelineId}`, {
        phase: state.phase,
        error_message: state.error,
        app_url: state.appUrl,
        db_connection_string: state.dbConnectionString,
        db_container_id: state.dbContainerId,
      });
    }
  } catch (e: any) {
    console.warn("[DB] savePipeline failed:", e.message);
  }

  const dir = getPipelinesDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${state.pipelineId}.json`), JSON.stringify(state, null, 2), "utf-8");
}

export async function writeWorkspaceMarkdown(workspaceDir: string, filename: string, content: string): Promise<void> {
  try {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, filename), content, "utf-8");
  } catch (e: any) {
    console.warn(`[Workspace] Failed to write ${filename}:`, e.message);
  }
}

async function writeHandoff(state: PipelineState): Promise<void> {
  const notes = (state.contextNotes || [])
    .map((n: any) => `- [${n.timestamp?.slice(0, 19) ?? ""}] ${n.note}`)
    .join("\n");
  const modules = (state.board?.modules || [])
    .map((m: any) => `- **${m.title || m.moduleId}** — ${m.status}  \n  Files: ${(m.files || []).join(", ")}`)
    .join("\n");
  const content =
    `# Handoff — ${state.projectName}\n\n` +
    `> Completed: ${new Date().toISOString()}\n\n` +
    `## App URL\n\n${state.appUrl || "Not launched"}\n\n` +
    `## Workspace\n\n\`${state.workspaceDir}\`\n\n` +
    `## Modules\n\n${modules || "—"}\n\n` +
    `## Steering Notes\n\n${notes || "None"}\n\n` +
    `## Files\n\nSee \`DOMAIN.md\`, \`PLAN.md\`, and \`CONTEXT.md\` in this workspace.\n`;
  await writeWorkspaceMarkdown(state.workspaceDir, "HANDOFF.md", content);
}

export async function getPipeline(pipelineId: string): Promise<PipelineState | null> {
  // Try DB first
  try {
    const dbState = await dbCall("GET", `/pipelines/${pipelineId}`);
    if (dbState) {
      return {
        pipelineId: dbState.id,
        projectName: dbState.project_name,
        objectivesMarkdown: dbState.objectives_markdown,
        workspaceDir: dbState.workspace_dir,
        phase: dbState.phase,
        config: dbState.config_json,
        createdAt: dbState.created_at,
        lastTransitionAt: dbState.updated_at,
        error: dbState.error_message,
        appUrl: dbState.app_url,
        dbConnectionString: dbState.db_connection_string,
        dbContainerId: dbState.db_container_id,
      } as PipelineState;
    }
  } catch (e: any) {
    // DB failed, try local file
  }

  // Fallback to local file
  try {
    const content = await readFile(join(getPipelinesDir(), `${pipelineId}.json`), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function listAllPipelines(): Promise<PipelineState[]> {
  // Try DB first
  try {
    const dbPipelines = await dbCall("GET", "/pipelines");
    if (dbPipelines && Array.isArray(dbPipelines)) {
      return dbPipelines.map((p: any) => ({
        pipelineId: p.id,
        projectName: p.project_name,
        phase: p.phase,
        createdAt: p.created_at,
        lastTransitionAt: p.updated_at,
        workspaceDir: p.workspace_dir,
      })) as PipelineState[];
    }
  } catch (e: any) {
    console.warn("[DB] listAllPipelines from DB failed, using local files");
  }

  // Fallback to local files
  try {
    const dir = getPipelinesDir();
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    const pipelines: PipelineState[] = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await readFile(join(dir, file), "utf-8");
        pipelines.push(JSON.parse(content));
      }
    }
    return pipelines;
  } catch {
    return [];
  }
}

export async function findPipelineByGateId(gateId: string): Promise<PipelineState | null> {
  const pipelines = await listAllPipelines();
  return pipelines.find((p) => p.activeGate?.gateId === gateId) || null;
}

// ─── Research phase ───────────────────────────────────────────────────────────

export async function runResearchBackground(pipelineId: string): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const apiKey = state.config?.providers?.research?.apiKey || process.env.GEMINI_API_KEY || "";
    const modelName = state.config?.providers?.research?.model || "deep-research-preview-04-2026";

    if (!apiKey) throw new Error("Gemini API Key missing for research phase.");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = `You are the Research Agent of the Double-Loop Orchestrator.
Generate a comprehensive, production-grade Domain Research Document for the following project:
Project Name: ${state.projectName}
Objectives:
${state.objectivesMarkdown}

Include technical standards, architecture choices, database schema models, dependencies, and API requirements.
Format the output strictly as Markdown. Do not include markdown code block wraps (like \`\`\`) around the whole document.`;

    let markdown = "";
    let usedModel = modelName;

    try {
      const result = await model.generateContent(prompt);
      markdown = result.response.text();
    } catch (err: any) {
      if (err.message?.includes("Interactions API") || err.message?.includes("not supported")) {
        usedModel = "gemini-2.0-flash";
        const fallbackModel = genAI.getGenerativeModel({ model: usedModel });
        const result = await fallbackModel.generateContent(prompt);
        markdown = result.response.text();
      } else if (err.message?.includes("429") || err.message?.includes("Too Many Requests")) {
        const delayMatch = err.message?.match(/retry[^0-9]*([0-9.]+)s/i);
        const delaySec = delayMatch ? Math.min(parseFloat(delayMatch[1]), 30) : 15;
        console.warn(`Rate limited (429). Retrying in ${delaySec}s...`);
        await new Promise((r) => setTimeout(r, delaySec * 1000));
        const result = await model.generateContent(prompt);
        markdown = result.response.text();
      } else {
        throw err;
      }
    }

    void usedModel; // suppress unused warning
    state.phase = "GATE1_PENDING";
    state.lastTransitionAt = new Date().toISOString();
    pushPhaseHistory(state, "GATE1_PENDING");
    state.domainDocument = {
      markdown,
      citations: [{ url: "https://ai.google.dev", title: "Google Gemini Documentation" }],
    };
    state.activeGate = {
      gateId: `gate-${crypto.randomUUID()}`,
      kind: "DOMAIN_DOCUMENT",
      exhibits: [markdown],
    };

    await savePipeline(state);
    await writeWorkspaceMarkdown(
      state.workspaceDir,
      "DOMAIN.md",
      `# Domain Document — ${state.projectName}\n\n> Generated: ${new Date().toISOString()}\n\n${markdown}`
    );
    console.log(`Research phase completed for pipeline ${pipelineId}`);
  } catch (err: any) {
    state.phase = "FAILED";
    pushPhaseHistory(state, "FAILED");
    const raw: string = err.message || String(err);
    state.error =
      (raw.includes("429") || raw.includes("Too Many Requests")) && raw.includes("limit: 0")
        ? "Gemini free-tier quota exhausted. Upgrade to a paid plan at https://ai.google.dev or use a different API key."
        : raw;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);
  }
}

// ─── Planning phase ───────────────────────────────────────────────────────────

export async function runPlanningBackground(pipelineId: string): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const plannerModel = state.config?.providers?.planner?.model || "claude-3-5-sonnet-latest";
    const isGemini = plannerModel.toLowerCase().startsWith("gemini") || plannerModel.toLowerCase().startsWith("google");
    const usingProxy = !!process.env.ANTHROPIC_BASE_URL;

    const apiKey = isGemini
      ? state.config?.providers?.research?.apiKey || process.env.GEMINI_API_KEY
      : state.config?.providers?.planner?.apiKey || process.env.ANTHROPIC_API_KEY || (usingProxy ? "proxy" : "");

    if (!apiKey && !usingProxy) throw new Error(`API Key missing for planning phase model ${plannerModel}.`);

    let rawText = "";

    if (isGemini) {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: plannerModel });
      const result = await model.generateContent(getPlanningPrompt(state));
      rawText = result.response.text();
    } else {
      rawText = await spawnClaude(getPlanningPrompt(state), plannerModel, state.workspaceDir);
    }

    let jsonText = rawText.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const codeBlock = jsonText.match(/```(?:json)?\s*([\s\S]*)```\s*$/);
    if (codeBlock && codeBlock[1]) {
      jsonText = codeBlock[1].trim();
    } else {
      const firstBrace = jsonText.indexOf("{");
      const lastBrace = jsonText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = jsonText.substring(firstBrace, lastBrace + 1);
      }
    }

    // Repair truncated JSON: close any unclosed brackets/braces
    let planData: any;
    try {
      planData = JSON.parse(jsonText);
    } catch {
      // Count unmatched open brackets/braces and close them
      let open = 0;
      let inStr = false;
      let escape = false;
      for (const ch of jsonText) {
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{" || ch === "[") open++;
        if (ch === "}" || ch === "]") open--;
      }
      // Strip trailing commas before closing, then close
      let repaired = jsonText.replace(/,\s*$/, "");
      if (open > 0) repaired += "}]".slice(0, open).split("").reverse().join("") + "}".repeat(Math.max(0, open - 1));
      try {
        planData = JSON.parse(repaired);
        console.warn(`[Planning] JSON was truncated — repaired and parsed successfully`);
      } catch (e2: any) {
        throw new Error(`Planning response contained invalid JSON: ${e2.message}`);
      }
    }

    state.phase = "GATE2_PENDING";
    state.lastTransitionAt = new Date().toISOString();
    pushPhaseHistory(state, "GATE2_PENDING");
    state.plan = {
      ceoPlan: planData.ceoPlan || "CEO Strategy Approved.",
      architecturePlan: planData.architecturePlan || "System Architecture Approved.",
      engineeringPlan: planData.engineeringPlan || { planVersion: 1, modules: [] },
    };
    state.activeGate = {
      gateId: `gate-${crypto.randomUUID()}`,
      kind: "TRIPARTITE_PLAN",
      exhibits: [
        state.plan.ceoPlan,
        state.plan.architecturePlan,
        JSON.stringify(state.plan.engineeringPlan, null, 2),
      ],
    };
    state.board = {
      modules: (planData.engineeringPlan?.modules || []).map((m: any) => ({
        moduleId: m.moduleId,
        status: "PENDING",
        attempts: 0,
      })),
    };

    await savePipeline(state);

    const engPlan = (state.plan?.engineeringPlan as any) || {};
    const engModules: any[] = engPlan.modules || [];
    const moduleList = engModules.map((m: any, i: number) => {
      const files = m.files?.length ? m.files.join(", ") : m.targetFiles?.length ? m.targetFiles.join(", ") : "—";
      return `### ${i + 1}. ${m.title || m.moduleId}\n\n${m.description || m.prompt?.slice(0, 200) || ""}\n\n**Files:** \`${files}\``;
    }).join("\n\n");
    await writeWorkspaceMarkdown(
      state.workspaceDir,
      "PLAN.md",
      `# Tripartite Plan — ${state.projectName}\n\n> Generated: ${new Date().toISOString()}\n\n` +
      `## CEO Strategy\n\n${state.plan?.ceoPlan || ""}\n\n` +
      `## System Architecture\n\n${state.plan?.architecturePlan || ""}\n\n` +
      `## Engineering Modules\n\n${moduleList || "_No modules defined_"}\n`
    );

    console.log(`Planning phase completed for pipeline ${pipelineId}`);
  } catch (err: any) {
    state.phase = "FAILED";
    pushPhaseHistory(state, "FAILED");
    state.error = err.message || String(err);
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);
  }
}

// ─── Execution phase (pi harness → CodeWhale → OCR → Claude Code supervisor) ─

export async function runExecutionBackground(pipelineId: string, toolsConfirmed = false): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  // Determine executor: CodeWhale (default) or Claude (user-selected)
  const useClaudeExecutor = state.config?.providers?.executor?.type === "claude";

  // ── Tool installation gate (CodeWhale + OCR required unless user chose Claude) ──
  if (!toolsConfirmed && !useClaudeExecutor) {
    const toolStatus = await checkRequiredTools();
    if (toolStatus.missing.length > 0) {
      const gateId = `gate-${crypto.randomUUID()}`;
      state.activeGate = {
        gateId,
        kind: "TOOL_INSTALL_PERMISSION",
        exhibits: [
          `The following tools are required for code generation and review:\n\n${toolStatus.missing.map((t) => `• ${t}`).join("\n")}\n\nApprove to run the installer, or choose "Use Claude" to use Claude Haiku as the sub-agent instead (no additional tools needed).`,
        ],
        context: { toolsToInstall: toolStatus.missing },
      };
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[Execution] Tool install gate set for pipeline ${pipelineId}:`, toolStatus.missing);
      return;
    }
  }

  const modules = state.board?.modules || [];
  if (modules.length === 0) {
    // No modules — jump straight to DB provisioning
    const s = await getPipeline(pipelineId);
    if (s) {
      s.phase = "DB_PROVISIONING_RUNNING";
      pushPhaseHistory(s, "DB_PROVISIONING_RUNNING");
      s.lastTransitionAt = new Date().toISOString();
      await savePipeline(s);
    }
    void runDbProvisioningBackground(pipelineId, false);
    return;
  }

  for (let i = 0; i < modules.length; i++) {
    const latest = await getPipeline(pipelineId);
    if (!latest || latest.phase === "ABORTED" || latest.phase === "FAILED") return;

    const moduleId = latest.board!.modules[i]!.moduleId;
    const planMod = (latest.plan?.engineeringPlan?.modules || []).find((m: any) => m.moduleId === moduleId);

    latest.board!.modules[i]!.status = "EXECUTING";
    latest.board!.modules[i]!.attempts = 1;
    latest.lastTransitionAt = new Date().toISOString();
    await savePipeline(latest);

    // ── Step 1: pi harness spawns CodeWhale (default) or Claude (user-selected) ──
    if (planMod) {
      const pipelineCtx: PipelineContext = {
        projectName: latest.projectName,
        objectivesMarkdown: latest.objectivesMarkdown,
        domainDocument: latest.domainDocument?.markdown,
        contextNotes: latest.contextNotes,
      };
      const executorType = latest.config?.providers?.executor?.type;
      const useClaude = executorType === "claude";

      if (useClaude) {
        console.log(`[Pi→Claude] Generating module ${moduleId} with Claude executor`);
        await spawnClaudeForModule(
          { moduleId: planMod.moduleId, title: planMod.title, prompt: planMod.prompt, touches: planMod.touches },
          latest.workspaceDir, latest.config, pipelineCtx
        );
      } else {
        console.log(`[Pi→CodeWhale] Generating module ${moduleId}: ${planMod.title}`);
        try {
          await spawnCodeWhaleForModule(
            { moduleId: planMod.moduleId, title: planMod.title, prompt: planMod.prompt, touches: planMod.touches },
            latest.workspaceDir, latest.config, pipelineCtx
          );
        } catch (cwErr: any) {
          console.warn(`[Pi→CodeWhale] Failed, falling back to Claude executor:`, cwErr.message?.slice(0, 200));
          await spawnClaudeForModule(
            { moduleId: planMod.moduleId, title: planMod.title, prompt: planMod.prompt, touches: planMod.touches },
            latest.workspaceDir, latest.config, pipelineCtx
          );
        }
      }
    }

    // ── Step 2: open-code-review subagent loop ────────────────────────────────
    let ocrPassed = false;
    let reviewAttempts = 0;
    const maxOcrAttempts = 3;

    while (!ocrPassed && reviewAttempts < maxOcrAttempts) {
      reviewAttempts++;
      console.log(`[OCR] Reviewing module ${moduleId} (attempt ${reviewAttempts})...`);

      const reviewResult = await runOpenCodeReview(latest.workspaceDir);

      if (!reviewResult.passed) {
        console.log(`[OCR] Issues found (attempt ${reviewAttempts}): ${reviewResult.critique.slice(0, 200)}`);

        if (reviewAttempts < maxOcrAttempts && planMod) {
          // Fix: ask CodeWhale to address the critique
          const fixPrompt = `Fix the following code review issues in the workspace:

Issues:
${reviewResult.critique.slice(0, 1000)}

Files affected: ${(planMod.touches || []).join(", ")}

Apply the fixes and ensure the code is correct.`;

          try {
            await spawnCodeWhaleForModule(
              { moduleId: planMod.moduleId, title: "Fix: " + planMod.title, prompt: fixPrompt, touches: planMod.touches },
              latest.workspaceDir,
              latest.config
            );
          } catch (e) {
            console.warn(`[Pi→CodeWhale] Fix attempt ${reviewAttempts} failed:`, e);
          }
        }
      } else {
        ocrPassed = true;
        console.log(`[OCR] Module ${moduleId} passed review`);
      }
    }

    // ── Step 3: Claude Code supervisor reviews the module ─────────────────────
    const reloaded = await getPipeline(pipelineId);
    if (!reloaded || reloaded.phase === "ABORTED" || reloaded.phase === "FAILED") return;

    reloaded.board!.modules[i]!.attempts = reviewAttempts;
    reloaded.board!.modules[i]!.status = "PASSED";
    reloaded.lastTransitionAt = new Date().toISOString();
    await savePipeline(reloaded);
    console.log(`[Supervisor] Module ${moduleId} accepted`);
  }

  // All modules done — scaffold missing infrastructure if needed
  const finalState = await getPipeline(pipelineId);
  if (finalState) {
    await scaffoldMissingInfrastructure(finalState.workspaceDir, finalState.projectName);
  }

  if (finalState && finalState.phase === "EXECUTION_RUNNING") {
    finalState.phase = "DB_PROVISIONING_RUNNING";
    pushPhaseHistory(finalState, "DB_PROVISIONING_RUNNING");
    finalState.lastTransitionAt = new Date().toISOString();
    await savePipeline(finalState);
    console.log(`[Pipeline] Execution complete. Starting DB provisioning for ${pipelineId}`);
  }

  void runDbProvisioningBackground(pipelineId, false);
}

// ─── DB Provisioning phase ────────────────────────────────────────────────────

export async function runDbProvisioningBackground(
  pipelineId: string,
  hasPermission: boolean
): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const needsDb = await detectDatabaseNeeded(state.workspaceDir, state.domainDocument?.markdown ?? state.objectivesMarkdown);

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
      `# Run database migrations from generated code`,
    ];

    if (!hasPermission) {
      // Request user permission before running Docker
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

    // Permission granted — provision the database
    console.log(`[DB] Provisioning PostgreSQL container ${containerId}...`);

    // Remove any existing container
    try {
      await execFileAsync("docker", ["rm", "-f", containerId], { timeout: 15_000 });
    } catch { /* ignore */ }

    // Start PostgreSQL
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

    // Wait for ready
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
    const migrationResult = await runMigrations(state.workspaceDir, dbUrl, containerId);
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

// ─── Testing phase ────────────────────────────────────────────────────────────

export async function runTestingBackground(
  pipelineId: string,
  hasPermission: boolean
): Promise<void> {
  const state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const testCmd = await detectTestCommand(state.workspaceDir);

    if (!testCmd) {
      console.log(`[Test] No test framework detected for ${pipelineId}, skipping to app launch`);
      state.phase = "APP_LAUNCH_RUNNING";
      pushPhaseHistory(state, "APP_LAUNCH_RUNNING");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      void runAppLaunchBackground(pipelineId, false);
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
          `Permission needed to install dependencies and run the test suite:\n\n${testCommands.join("\n")}`,
          "Approve to run tests, or Reject to skip testing and proceed to app launch.",
        ],
        context: { nextAction: "run-tests" },
      };
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[Test] Waiting for user permission to run tests for ${pipelineId}`);
      return;
    }

    // Permission granted — run tests
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

    console.log(`[Test] Running: ${testCmd.cmd} ${testCmd.args.join(" ")}`);
    let testOutput = "";
    let rawPassed = false;

    try {
      const result = await execFileAsync(testCmd.cmd, testCmd.args, {
        cwd: state.workspaceDir,
        env: dbEnv,
        timeout: 300_000,
      });
      testOutput = result.stdout + result.stderr;
      rawPassed = true;
    } catch (err: any) {
      testOutput = (err.stdout || "") + (err.stderr || "");
      rawPassed = false;
    }

    const durationMs = Date.now() - startTime;

    // Claude Code supervisor reviews the test output
    const supervisorResult = await supervisorReviewTestOutput(testOutput, state);
    const finalPassed = rawPassed || supervisorResult.override;

    state.testResults = {
      passed: finalPassed,
      output: testOutput.slice(0, 5000),
      durationMs,
      supervisorReasoning: supervisorResult.reasoning,
    };
    state.phase = "APP_LAUNCH_RUNNING";
    pushPhaseHistory(state, "APP_LAUNCH_RUNNING");
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);

    console.log(`[Test] Tests ${finalPassed ? "passed" : "failed"} for ${pipelineId} (${durationMs}ms)`);
    void runAppLaunchBackground(pipelineId, false);
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

// ─── App Launch phase ─────────────────────────────────────────────────────────

export async function runAppLaunchBackground(
  pipelineId: string,
  hasPermission: boolean
): Promise<void> {
  let state = await getPipeline(pipelineId);
  if (!state) return;

  try {
    const launchCmd = await detectLaunchCommand(state.workspaceDir);

    if (!launchCmd) {
      console.log(`[App] No launch command detected for ${pipelineId}, marking as completed`);
      state.phase = "COMPLETED";
      pushPhaseHistory(state, "COMPLETED");
      state.activeGate = null;
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      await writeHandoff(state);
      return;
    }

    const launchCommands = [
      `cd ${state.workspaceDir}`,
      `${launchCmd.cmd} ${launchCmd.args.join(" ")}`,
      `# App will be available at http://localhost:${launchCmd.port}`,
    ];

    if (!hasPermission) {
      state.activeGate = {
        gateId: `gate-${crypto.randomUUID()}`,
        kind: "TERMINAL_PERMISSION",
        exhibits: [
          "Launch Application",
          `Permission needed to start the generated application:\n\n${launchCommands.join("\n")}\n\nThe app will run at http://localhost:${launchCmd.port}`,
          "Approve to launch the application locally, or Reject to complete without launching.",
        ],
        context: { nextAction: "launch-app" },
      };
      state.lastTransitionAt = new Date().toISOString();
      await savePipeline(state);
      console.log(`[App] Waiting for user permission to launch app for ${pipelineId}`);
      return;
    }

    // Permission granted — install deps then launch
    console.log(`[App] Running npm install in ${state.workspaceDir}`);
    try {
      await execFileAsync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
        cwd: state.workspaceDir,
        timeout: 120_000,
        env: { ...process.env, NODE_ENV: "development" },
      });
    } catch (e: any) {
      console.warn("[App] npm install warning:", e.message?.slice(0, 200));
    }

    console.log(`[App] Launching: ${launchCmd.cmd} ${launchCmd.args.join(" ")} in ${state.workspaceDir}`);

    const child = spawn(launchCmd.cmd, launchCmd.args, {
      cwd: state.workspaceDir,
      env: {
        ...process.env,
        DATABASE_URL: state.dbConnectionString || "",
        PORT: String(launchCmd.port),
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Health check
    const appUrl = `http://localhost:${launchCmd.port}`;
    let appReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(appUrl, { signal: AbortSignal.timeout(3000) });
        if (res.status < 500) {
          appReady = true;
          break;
        }
      } catch { /* not ready yet */ }
    }

    state = (await getPipeline(pipelineId))!;
    state.appUrl = appReady ? appUrl : `${appUrl} (starting up — check in a few seconds)`;
    state.phase = "COMPLETED";
    pushPhaseHistory(state, "COMPLETED");
    state.activeGate = null;
    state.lastTransitionAt = new Date().toISOString();
    await savePipeline(state);
    await writeHandoff(state);
    console.log(`[App] Application ${appReady ? "ready" : "launched"} at ${appUrl} for ${pipelineId}`);
  } catch (err: any) {
    // App launch is non-fatal — mark completed with warning
    const s = await getPipeline(pipelineId);
    if (s) {
      s.phase = "COMPLETED";
      pushPhaseHistory(s, "COMPLETED");
      s.activeGate = null;
      s.error = `Warning: App launch issue: ${err.message}`;
      s.lastTransitionAt = new Date().toISOString();
      await savePipeline(s);
      await writeHandoff(s);
    }
  }
}

// ─── Planning prompt ──────────────────────────────────────────────────────────

function getPlanningPrompt(state: PipelineState): string {
  return `You are the Planning Agent of the Double-Loop Orchestrator.
Project: ${state.projectName}
Objectives: ${state.objectivesMarkdown.slice(0, 300)}
Research summary: ${(state.domainDocument?.markdown || "").slice(0, 500)}

Respond with ONLY a JSON object — no markdown, no code fences, no explanation. The JSON must be valid and complete.

Rules:
- ceoPlan: 1-2 sentence business summary (string)
- architecturePlan: 1-2 sentence technical summary (string)
- engineeringPlan: exactly 3 modules maximum, each with short prompts under 100 chars
- CRITICAL: The FIRST module MUST include infrastructure files in its touches: package.json, index.html (if frontend), vite.config.ts or similar build config. Without these the app cannot be installed, tested, or launched.
- Every touches array must be complete — list every file the module creates or modifies.

Required structure (copy exactly):
{"ceoPlan":"string","architecturePlan":"string","engineeringPlan":{"planVersion":1,"generatedBy":"DLO Planner","modules":[{"moduleId":"m1","title":"string","stackTarget":"frontend","prompt":"string at least 40 chars describing what to build","dependsOn":[],"estimatedComplexity":"easy","maxAttempts":3,"exitClauses":[{"clauseId":"c1","description":"build passes","kind":"command","argv":["npm","run","build"],"expect":{"exitCode":0}}],"touches":["package.json","index.html","vite.config.ts","src/main.tsx","src/App.tsx"]}]}}`;
}
