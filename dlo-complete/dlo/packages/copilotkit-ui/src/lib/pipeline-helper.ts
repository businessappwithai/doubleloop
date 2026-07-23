/**
 * packages/copilotkit-ui/src/lib/pipeline-helper.ts
 *
 * FAÇADE — the pipeline implementation moved to src/lib/orchestrator/
 * (M-A refactor: central orchestrator + one module per phase + one module
 * per subagent vendor). This file re-exports the full surface so existing
 * imports keep working. New code should import from "@/lib/orchestrator".
 */

export * from "./orchestrator";
