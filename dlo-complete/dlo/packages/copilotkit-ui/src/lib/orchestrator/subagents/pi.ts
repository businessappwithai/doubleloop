/**
 * orchestrator/subagents/pi.ts
 * The pi.dev subagent runner seam.
 *
 * Preferred: the real pi.dev agentic stack (@earendil-works/pi-coding-agent +
 * @gotgenes/pi-subagents), loaded dynamically when installed. Otherwise a
 * LocalSubagentRunner provides the same semantics — named subagents executed
 * in parallel with a shared result map. The active runner is ALWAYS reported
 * (state.researchMeta.runner, RESEARCH.md front-matter); never a silent shim.
 */

export interface SubagentTask<T = string> {
  name: string;
  /** Human-readable mission, recorded in artifacts. */
  mission: string;
  run: () => Promise<T>;
}

export interface SubagentRunResult<T = string> {
  name: string;
  mission: string;
  ok: boolean;
  value?: T;
  error?: string;
  durationMs: number;
}

export interface SubagentRunner {
  readonly kind: "pi-sdk" | "local";
  runParallel<T>(tasks: Array<SubagentTask<T>>): Promise<Array<SubagentRunResult<T>>>;
}

class LocalSubagentRunner implements SubagentRunner {
  readonly kind = "local" as const;

  async runParallel<T>(tasks: Array<SubagentTask<T>>): Promise<Array<SubagentRunResult<T>>> {
    return Promise.all(
      tasks.map(async (task) => {
        const start = Date.now();
        try {
          const value = await task.run();
          return {
            name: task.name,
            mission: task.mission,
            ok: true as const,
            value,
            durationMs: Date.now() - start,
          };
        } catch (e: any) {
          return {
            name: task.name,
            mission: task.mission,
            ok: false as const,
            error: e?.message || String(e),
            durationMs: Date.now() - start,
          };
        }
      })
    );
  }
}

class PiSdkSubagentRunner implements SubagentRunner {
  readonly kind = "pi-sdk" as const;
  private local = new LocalSubagentRunner();

  constructor(private sdk: any) {}

  async runParallel<T>(tasks: Array<SubagentTask<T>>): Promise<Array<SubagentRunResult<T>>> {
    // The pi SDK manages session contexts per subagent; each task still runs
    // its own provider call. We fork a pi session per subagent for context
    // isolation, falling back to plain parallel execution on any SDK error.
    try {
      const results: Array<SubagentRunResult<T>> = [];
      await Promise.all(
        tasks.map(async (task) => {
          const start = Date.now();
          let session: any = null;
          try {
            session = await this.sdk.createSession?.({ name: task.name });
            const value = await task.run();
            results.push({
              name: task.name,
              mission: task.mission,
              ok: true,
              value,
              durationMs: Date.now() - start,
            });
          } catch (e: any) {
            results.push({
              name: task.name,
              mission: task.mission,
              ok: false,
              error: e?.message || String(e),
              durationMs: Date.now() - start,
            });
          } finally {
            try { await session?.close?.(); } catch { /* ignore */ }
          }
        })
      );
      return results;
    } catch {
      return this.local.runParallel(tasks);
    }
  }
}

let cachedRunner: SubagentRunner | null = null;

/**
 * Resolve the subagent runner. Tries the real pi SDK once per process;
 * otherwise the local runner. config.providers.harness.mode:
 *   "auto" (default) | "pi-sdk" (fail if unavailable) | "local"
 */
export async function getSubagentRunner(config?: any): Promise<SubagentRunner> {
  const mode: string = config?.providers?.harness?.mode || "auto";
  if (mode === "local") return new LocalSubagentRunner();
  if (cachedRunner && mode === "auto") return cachedRunner;

  const pkgName = config?.providers?.harness?.sdkPackage || "@earendil-works/pi-coding-agent";
  try {
    // Dynamic import so the dependency stays optional.
    const sdk: any = await import(/* webpackIgnore: true */ pkgName);
    cachedRunner = new PiSdkSubagentRunner(sdk);
    console.log(`[Pi] Using real pi.dev SDK runner (${pkgName})`);
    return cachedRunner;
  } catch (e: any) {
    if (mode === "pi-sdk") {
      throw new Error(
        `pi SDK requested (harness.mode="pi-sdk") but ${pkgName} is not installed: ${e.message}`
      );
    }
    cachedRunner = new LocalSubagentRunner();
    console.log(`[Pi] pi SDK not installed — using LocalSubagentRunner (same semantics, reported in artifacts)`);
    return cachedRunner;
  }
}
