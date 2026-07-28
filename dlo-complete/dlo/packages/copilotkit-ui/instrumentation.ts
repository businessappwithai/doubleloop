/**
 * instrumentation.ts
 * Next.js calls register() once per server process, before it serves anything.
 *
 * This is where DLO recovers pipelines that a previous process left mid-flight.
 * Phase runners are plain in-process async functions, so a host restart, OOM
 * kill or deploy leaves the persisted state saying EXECUTION_RUNNING with no
 * one running it — the pipeline looks alive, is dead, and every module the
 * fleet already finished is stranded behind it. Recovering on startup makes a
 * restart cost minutes instead of the whole run.
 */

export async function register(): Promise<void> {
  // Node runtime only: the edge runtime has no child processes or filesystem.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { recoverOnStartup } = await import("./src/lib/orchestrator");
    await recoverOnStartup();
  } catch (err: any) {
    // Recovery must never stop the server from booting: a pipeline that cannot
    // be resumed is still visible and steerable through the UI.
    console.error("[Recovery] Startup recovery failed:", err?.message ?? err);
  }
}
