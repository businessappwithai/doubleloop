/**
 * orchestrator/langflow.ts
 * Langflow as the subagent-configuration surface (R12).
 *
 * Export: the pipeline's agent graph rendered as a Langflow flow — one node
 * per subagent (research trio + assembler, design-analyst, ceo-reviewer, one
 * builder per Implementation.md module, test-runner, fixer), edges mirroring
 * the module dependsOn DAG. Editable template fields: vendor, model,
 * systemPrompt, maxAttempts, maxConcurrent.
 *
 * Apply: a flow (fetched from a Langflow instance by id, or posted inline)
 * is validated and stored as first-class state.agentDesign — which the build
 * fleet honors per module.
 */

import type { PipelineState, AgentDesign, AgentAssignment } from "./state";

const KNOWN_VENDORS = ["claude-code", "codewhale", "gemini"] as const;

export interface LangflowConfig {
  url: string;
  apiKey?: string;
}

export function langflowConfigFrom(state: PipelineState): LangflowConfig | null {
  const url = state.config?.langflow?.url || process.env.LANGFLOW_URL;
  if (!url) return null;
  const apiKey = state.config?.langflow?.apiKey || process.env.LANGFLOW_API_KEY;
  return { url: String(url).replace(/\/$/, ""), ...(apiKey ? { apiKey } : {}) };
}

// ─── Export: pipeline → Langflow flow JSON ────────────────────────────────────

function templateField(value: string | number, opts?: { options?: string[]; info?: string }) {
  return {
    type: typeof value === "number" ? "int" : "str",
    required: false,
    show: true,
    value,
    ...(opts?.options ? { options: opts.options } : {}),
    ...(opts?.info ? { info: opts.info } : {}),
  };
}

function agentNode(
  id: string,
  displayName: string,
  description: string,
  fields: Record<string, any>,
  position: { x: number; y: number },
  role: string
) {
  return {
    id,
    type: "genericNode",
    position,
    data: {
      id,
      type: "DloAgent",
      node: {
        display_name: displayName,
        description,
        documentation: "https://github.com/businessappwithai/doubleloop",
        template: {
          _type: "DloAgent",
          role: templateField(role, { info: "DLO subagent role (do not change)" }),
          ...fields,
        },
      },
    },
  };
}

export function exportPipelineAsFlow(state: PipelineState): any {
  const executor = state.config?.providers?.executor || {};
  const defaultVendor = executor.vendor === "codewhale" || executor.type === "codewhale" ? "codewhale" : "claude-code";
  const defaultModel = executor.model || "claude-haiku-4-5-20251001";
  const design = state.agentDesign;

  const nodes: any[] = [];
  const edges: any[] = [];

  // Fixed pipeline-stage nodes.
  const stageNodes: Array<[string, string, string, string]> = [
    ["dlo-research-architecture", "Research: Architecture", "Gemini research subagent — best architecture approach", "research"],
    ["dlo-research-domain", "Research: Domain", "Gemini research subagent — best domain knowledge", "research"],
    ["dlo-research-erd", "Research: ERD", "Gemini research subagent — best entity relationships (PostgreSQL)", "research"],
    ["dlo-research-assembler", "Prompt Assembler", "Assembles best prompts, merges research into RESEARCH.md", "research"],
    ["dlo-design-analyst", "Design Analyst", "Claude Code plan mode — Architecture.md / Database.md / Implementation.md", "design"],
    ["dlo-ceo-reviewer", "CEO Reviewer", "/plan-ceo-review over the three design documents", "review"],
    ["dlo-test-runner", "Test Runner", "Builds, executes and tests the generated app", "finalize"],
    ["dlo-fixer", "Fixer", "Repairs build/test failures (cheap model)", "finalize"],
  ];
  stageNodes.forEach(([id, name, desc, role], i) => {
    const vendor = role === "research" ? "gemini" : "claude-code";
    const model =
      role === "research"
        ? state.config?.providers?.research?.model || "deep-research-preview-04-2026"
        : role === "design" || role === "review"
        ? state.config?.providers?.planner?.model || "claude-sonnet-5"
        : defaultModel;
    nodes.push(
      agentNode(id, name, desc, {
        vendor: templateField(vendor, { options: [...KNOWN_VENDORS] }),
        model: templateField(model),
      }, { x: 80, y: 80 + i * 130 }, role)
    );
  });

  // Research trio → assembler → design → review edges.
  for (const src of ["dlo-research-architecture", "dlo-research-domain", "dlo-research-erd"]) {
    edges.push({ id: `e-${src}-assembler`, source: src, target: "dlo-research-assembler" });
  }
  edges.push({ id: "e-assembler-design", source: "dlo-research-assembler", target: "dlo-design-analyst" });
  edges.push({ id: "e-design-review", source: "dlo-design-analyst", target: "dlo-ceo-reviewer" });

  // One builder node per Implementation.md module, edges = dependsOn DAG.
  const modules: any[] = state.plan?.engineeringPlan?.modules || [];
  modules.forEach((m: any, i: number) => {
    const nodeId = `dlo-builder-${m.moduleId}`;
    const assigned: AgentAssignment | undefined = design?.modules?.[m.moduleId];
    nodes.push(
      agentNode(
        nodeId,
        `Builder: ${m.title || m.moduleId}`,
        (m.prompt || "").slice(0, 300),
        {
          moduleId: templateField(m.moduleId, { info: "Implementation.md module id (do not change)" }),
          vendor: templateField(assigned?.vendor ?? defaultVendor, { options: [...KNOWN_VENDORS] }),
          model: templateField(assigned?.model ?? defaultModel),
          systemPrompt: templateField(assigned?.systemPrompt ?? ""),
          maxAttempts: templateField(assigned?.maxAttempts ?? m.maxAttempts ?? 3),
        },
        { x: 520 + (i % 3) * 360, y: 80 + Math.floor(i / 3) * 180 },
        "builder"
      )
    );
    if (!m.dependsOn?.length) {
      edges.push({ id: `e-review-${nodeId}`, source: "dlo-ceo-reviewer", target: nodeId });
    } else {
      for (const dep of m.dependsOn) {
        edges.push({ id: `e-${dep}-${m.moduleId}`, source: `dlo-builder-${dep}`, target: nodeId });
      }
    }
  });

  // Builders with no dependents feed the test runner.
  const hasDependents = new Set(modules.flatMap((m: any) => m.dependsOn || []));
  for (const m of modules) {
    if (!hasDependents.has(m.moduleId)) {
      edges.push({ id: `e-${m.moduleId}-test`, source: `dlo-builder-${m.moduleId}`, target: "dlo-test-runner" });
    }
  }
  edges.push({ id: "e-test-fixer", source: "dlo-test-runner", target: "dlo-fixer" });

  // Fleet-level settings node.
  nodes.push(
    agentNode(
      "dlo-fleet-settings",
      "Fleet Settings",
      "Global build-fleet settings",
      {
        maxConcurrent: templateField(design?.maxConcurrent ?? executor.maxConcurrent ?? 4, {
          info: "How many builder subagents run in parallel",
        }),
      },
      { x: 80, y: 80 + stageNodes.length * 130 },
      "settings"
    )
  );

  return {
    name: `DLO — ${state.projectName}`,
    description: `Double-Loop Orchestrator agent graph for pipeline ${state.pipelineId}. Edit vendor/model/prompt fields, then Apply in DLO.`,
    data: { nodes, edges, viewport: { x: 0, y: 0, zoom: 0.7 } },
  };
}

// ─── Apply: Langflow flow JSON → AgentDesign ──────────────────────────────────

export interface ApplyResult {
  agentDesign: AgentDesign;
  warnings: string[];
}

export function parseFlowIntoAgentDesign(flow: any, flowId?: string): ApplyResult {
  const nodes: any[] = flow?.data?.nodes || flow?.nodes || [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("Flow contains no nodes (expected flow.data.nodes).");
  }

  const warnings: string[] = [];
  const modules: Record<string, AgentAssignment> = {};
  let maxConcurrent: number | undefined;

  for (const node of nodes) {
    const template = node?.data?.node?.template || {};
    const fieldValue = (name: string) => template?.[name]?.value ?? template?.[name];

    const role = String(fieldValue("role") ?? "");
    if (role === "settings" || node.id === "dlo-fleet-settings") {
      const mc = Number(fieldValue("maxConcurrent"));
      if (Number.isFinite(mc) && mc >= 1 && mc <= 16) maxConcurrent = mc;
      else if (fieldValue("maxConcurrent") !== undefined) warnings.push(`Ignored invalid maxConcurrent: ${fieldValue("maxConcurrent")}`);
      continue;
    }

    const moduleId = fieldValue("moduleId");
    if (!moduleId) continue; // stage nodes configure via pipeline config, not agentDesign

    const vendorRaw = String(fieldValue("vendor") ?? "claude-code");
    if (!(KNOWN_VENDORS as readonly string[]).includes(vendorRaw)) {
      throw new Error(`Node ${node.id}: unknown vendor "${vendorRaw}" (allowed: ${KNOWN_VENDORS.join(", ")})`);
    }
    const model = String(fieldValue("model") ?? "").trim();
    if (!model) throw new Error(`Node ${node.id}: model must not be empty`);

    const assignment: AgentAssignment = {
      vendor: vendorRaw as AgentAssignment["vendor"],
      model,
    };
    const sysPrompt = fieldValue("systemPrompt");
    if (typeof sysPrompt === "string" && sysPrompt.trim()) assignment.systemPrompt = sysPrompt.trim();
    const maxAttempts = Number(fieldValue("maxAttempts"));
    if (Number.isFinite(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10) assignment.maxAttempts = maxAttempts;

    modules[String(moduleId)] = assignment;
  }

  if (Object.keys(modules).length === 0) {
    warnings.push("Flow contained no builder nodes with a moduleId — only fleet settings were applied.");
  }

  return {
    agentDesign: {
      modules,
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
      source: "langflow",
      ...(flowId ? { langflowFlowId: flowId } : {}),
      updatedAt: new Date().toISOString(),
    },
    warnings,
  };
}

// ─── Langflow REST client ─────────────────────────────────────────────────────

async function langflowFetch(cfg: LangflowConfig, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Langflow ${init?.method || "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function pushFlowToLangflow(cfg: LangflowConfig, flow: any): Promise<{ flowId: string; editorUrl: string }> {
  const created = await langflowFetch(cfg, "/api/v1/flows/", {
    method: "POST",
    body: JSON.stringify(flow),
  });
  const flowId = created?.id;
  if (!flowId) throw new Error("Langflow did not return a flow id.");
  return { flowId, editorUrl: `${cfg.url}/flow/${flowId}` };
}

export async function fetchFlowFromLangflow(cfg: LangflowConfig, flowId: string): Promise<any> {
  return langflowFetch(cfg, `/api/v1/flows/${flowId}`);
}

export async function checkLangflow(cfg: LangflowConfig): Promise<{ reachable: boolean; detail: string }> {
  try {
    await langflowFetch(cfg, "/health");
    return { reachable: true, detail: `Langflow reachable at ${cfg.url}` };
  } catch (e: any) {
    return { reachable: false, detail: e.message };
  }
}
