/**
 * packages/copilotkit-ui/app/chat/page.tsx
 * Main chat interface using CopilotKit with dynamic agent configuration settings.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import {
  useCopilotReadable,
  useCopilotAction,
  CopilotKit,
} from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { useDloStore } from "@/lib/store";
import { createDloClient } from "@/lib/dlo-client";
import { format } from "date-fns";
import { Activity, AlertCircle, CheckCircle, Clock, Zap, Settings, X, XCircle, Code2, Database, FlaskConical, Rocket, ExternalLink, ShieldCheck, RefreshCw, GitBranch } from "lucide-react";
import { WorkspaceViewer } from "@/components/WorkspaceViewer";
import { ErdPanel } from "@/components/ErdPanel";

const RUNNING_PHASES = new Set([
  "RESEARCH_RUNNING", "DESIGN_RUNNING", "CEO_REVIEW_RUNNING",
  "EXECUTION_RUNNING", "BUILD_RUNNING", "DB_PROVISIONING_RUNNING",
  "TESTING_RUNNING", "DEPLOY_RUNNING", "APP_LAUNCH_RUNNING",
]);

/** Live streaming log panel with stdin input box. */
function LiveLogs({ pipelineId }: { pipelineId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [open, setOpen] = useState(true);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [hasRunningProcess, setHasRunningProcess] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pipelineId) return;
    setLines([]);
    const es = new EventSource(`/api/pipelines/${pipelineId}/logs`);
    es.onmessage = (e) => {
      try {
        const { line } = JSON.parse(e.data) as { line: string };
        setLines((prev) => {
          const next = [...prev, line];
          return next.length > 500 ? next.slice(-500) : next;
        });
      } catch {}
    };
    return () => es.close();
  }, [pipelineId]);

  // Poll whether a subprocess is currently waiting for stdin input.
  useEffect(() => {
    if (!pipelineId) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/pipelines/${pipelineId}/stdin`);
        const data = await res.json();
        setHasRunningProcess(data.running ?? false);
      } catch {}
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [pipelineId]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, open]);

  const sendInput = async () => {
    if (!inputText.trim() || !pipelineId) return;
    setSending(true);
    setSendMsg(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/stdin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText }),
      });
      const data = await res.json();
      if (res.ok) {
        setLines((prev) => [...prev, `> ${inputText}`]);
        setInputText("");
        setSendMsg(null);
      } else {
        setSendMsg(data.error || "Failed to send");
      }
    } catch (e: any) {
      setSendMsg(e.message);
    } finally {
      setSending(false);
    }
  };

  if (lines.length === 0 && !hasRunningProcess) return null;

  return (
    <div className="mt-3 rounded border border-slate-700 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-left"
      >
        <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1.5">
          <Activity className="w-3 h-3 text-blue-400" />
          Live output ({lines.length} lines)
          {hasRunningProcess && (
            <span className="text-[10px] text-emerald-400 ml-1">● subprocess running</span>
          )}
        </span>
        <span className="text-[10px] text-slate-600">{open ? "▲ hide" : "▼ show"}</span>
      </button>

      {open && (
        <>
          <div className="bg-slate-950 max-h-56 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
            {lines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap break-all ${
                  line.startsWith(">") ? "text-emerald-400" :
                  line.startsWith("[") ? "text-blue-300" :
                  line.toLowerCase().includes("error") || line.toLowerCase().includes("failed") ? "text-red-300" :
                  line.toLowerCase().includes("warn") ? "text-amber-300" :
                  line.startsWith("{") || line.startsWith("}") ? "text-slate-600" :
                  "text-slate-300"
                }`}
              >
                {line}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Stdin input — shown when a process is running (for permission prompts & interactive input) */}
          {hasRunningProcess && (
            <div className="border-t border-slate-700 bg-slate-900 p-2">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] text-amber-400 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Subprocess awaiting input — reply to permission prompts or provide context
                </p>
                {/* Quick-approve buttons for common permission responses */}
                <div className="flex gap-1">
                  {["y", "1", "n"].map((quick) => (
                    <button
                      key={quick}
                      onClick={async () => {
                        await fetch(`/api/pipelines/${pipelineId}/stdin`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ text: quick }),
                        });
                      }}
                      className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                        quick === "y" ? "border-emerald-700 text-emerald-400 hover:bg-emerald-900" :
                        quick === "n" ? "border-red-800 text-red-400 hover:bg-red-950" :
                        "border-slate-700 text-slate-400 hover:bg-slate-800"
                      }`}
                    >
                      {quick}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-1.5">
                <input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendInput(); } }}
                  placeholder="Type response or select quick-reply above…"
                  className="flex-1 bg-slate-950 border border-slate-600 rounded px-2 py-1 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={sendInput}
                  disabled={sending || !inputText.trim()}
                  className="px-3 py-1 rounded text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white"
                >
                  {sending ? "…" : "Send"}
                </button>
              </div>
              {sendMsg && (
                <p className="text-[10px] text-red-300 mt-1">{sendMsg}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  RESEARCH_RUNNING: "Running research agent…",
  DESIGN_RUNNING: "Running Design Analyst (Architecture · Database · Implementation)…",
  CEO_REVIEW_RUNNING: "Running CEO review of design documents…",
  EXECUTION_RUNNING: "Building modules (fleet running)…",
  BUILD_RUNNING: "Running build…",
  DB_PROVISIONING_RUNNING: "Provisioning database…",
  TESTING_RUNNING: "Running tests…",
  DEPLOY_RUNNING: "Deploying…",
  APP_LAUNCH_RUNNING: "Launching app…",
};

const STUCK_THRESHOLD_MS = 10 * 60_000; // 10 minutes

function PhaseIndicator({
  status,
  pipelineId,
  onResume,
}: {
  status: any;
  pipelineId: string;
  onResume: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [resuming, setResuming] = useState(false);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const phase: string = status?.phase ?? "";
  const isRunning = RUNNING_PHASES.has(phase);
  const lastTransition = status?.lastTransitionAt ? new Date(status.lastTransitionAt).getTime() : null;
  const elapsedMs = lastTransition ? now - lastTransition : 0;
  const isStuck = isRunning && elapsedMs > STUCK_THRESHOLD_MS;
  const elapsedLabel = elapsedMs > 0 ? (() => {
    const s = Math.floor(elapsedMs / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  })() : null;

  const isFailed = phase === "FAILED";
  const isAborted = phase === "ABORTED";
  const pipelineError = status?.error as string | undefined;
  const canSkipCeoReview = phase === "CEO_REVIEW_RUNNING";

  const handleResume = async (action: "retry" | "skip") => {
    if (!pipelineId) return;
    setResuming(true);
    setResumeMsg(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResumeMsg(`Error: ${data.error}`);
      } else {
        setResumeMsg(action === "skip" ? "Skipped — advancing to Gate 2" : "Restarted — check status in a moment");
        setTimeout(() => { setResumeMsg(null); onResume(); }, 2000);
      }
    } catch (e: any) {
      setResumeMsg(`Error: ${e.message}`);
    } finally {
      setResuming(false);
    }
  };

  const borderColor = isFailed ? "border-red-500" : isAborted ? "border-orange-500" : isStuck ? "border-amber-500" : isRunning ? "border-blue-500" : "border-slate-600";
  const textColor = isFailed ? "text-red-400" : isAborted ? "text-orange-400" : isStuck ? "text-amber-300" : isRunning ? "text-blue-300" : "text-slate-300";

  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Phase</p>
      <div className={`bg-slate-900 rounded px-3 py-2 border-l-4 ${borderColor}`}>
        <div className="flex items-center gap-2">
          {isRunning && !isStuck && <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" />}
          {isStuck && <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />}
          {isFailed && <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
          {isAborted && <AlertCircle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />}
          <p className={`text-sm font-semibold ${textColor}`}>{phase}</p>
          {elapsedLabel && (
            <span className={`text-[10px] ml-auto ${isStuck ? "text-amber-400 font-semibold" : "text-slate-500"}`}>
              {elapsedLabel}
            </span>
          )}
        </div>

        {PHASE_LABELS[phase] && !isStuck && (
          <p className="text-[11px] text-slate-500 mt-1">{PHASE_LABELS[phase]}</p>
        )}

        {isStuck && (
          <p className="text-[11px] text-amber-400 mt-1">
            Phase has been running for {elapsedLabel} without progress — it may be stuck.
          </p>
        )}

        {(pipelineError) && (
          <p className="text-[11px] text-red-300 mt-1.5 break-words font-mono bg-red-950/40 rounded px-2 py-1">
            {pipelineError}
          </p>
        )}

        {resumeMsg && (
          <p className={`text-[11px] mt-1.5 ${resumeMsg.startsWith("Error") ? "text-red-300" : "text-emerald-300"}`}>
            {resumeMsg}
          </p>
        )}

        {isAborted && (
          <p className="text-[11px] text-orange-400 mt-1">
            Pipeline was aborted — click Retry to resume from the last running phase.
          </p>
        )}

        {(isStuck || isFailed || isAborted) && (isRunning || isFailed || isAborted) && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => handleResume("retry")}
              disabled={resuming}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-blue-800 hover:bg-blue-700 disabled:opacity-50 text-white"
            >
              <RefreshCw className={`w-3 h-3 ${resuming ? "animate-spin" : ""}`} />
              Retry
            </button>
            {canSkipCeoReview && (
              <button
                onClick={() => handleResume("skip")}
                disabled={resuming}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200"
                title="Skip CEO review and advance to Gate 2"
              >
                Skip CEO Review
              </button>
            )}
          </div>
        )}
      </div>

      {isRunning && <LiveLogs pipelineId={pipelineId} />}
    </div>
  );
}

/**
 * Registers CopilotKit actions/readables. Only mounted when a Gemini key is present
 * so the runtime is never called without credentials.
 */
function CopilotActions({
  config,
  store,
  setPendingPipelineParams,
  setManualProjectName,
  setManualObjectives,
  setManualResearchMode,
}: {
  config: any;
  store: any;
  setPendingPipelineParams: (p: any) => void;
  setManualProjectName: (s: string) => void;
  setManualObjectives: (s: string) => void;
  setManualResearchMode: (b: boolean) => void;
}) {
  useCopilotAction({
    name: "initialize_pipeline",
    description: "Initialize a new DLO pipeline with the given configuration",
    parameters: [
      { name: "projectName", type: "string", description: "Name of the project", required: true },
      { name: "objectivesMarkdown", type: "string", description: "Project objectives as markdown", required: true },
      { name: "workspaceDir", type: "string", description: "Workspace directory path", required: true },
    ],
    handler: async (input: any) => {
      let activeConfig = { ...config };
      if (typeof window !== "undefined") {
        try {
          const stored = localStorage.getItem("dlo-config");
          if (stored) activeConfig = JSON.parse(stored);
        } catch (err) {
          console.error("Failed to parse stored config:", err);
        }
      }
      if (!activeConfig.providers?.research?.apiKey) {
        setPendingPipelineParams({
          projectName: input.projectName,
          objectivesMarkdown: input.objectivesMarkdown,
          workspaceDir: input.workspaceDir,
        });
        setManualProjectName(input.projectName || "");
        setManualObjectives(input.objectivesMarkdown || "");
        setManualResearchMode(true);
        return "Research agent (Gemini Deep Research) is not configured. Paste your research and requirements in the panel on the right, then click 'Start Pipeline'.";
      }
      await store.initPipeline({
        projectName: input.projectName,
        objectivesMarkdown: input.objectivesMarkdown,
        workspaceDir: input.workspaceDir,
        config: activeConfig,
      });
      return `Pipeline initialized! Proceeding with Gemini Deep Research phase.`;
    },
  });

  useCopilotAction({
    name: "get_pipeline_status",
    description: "Get the current status of the active pipeline",
    parameters: [],
    handler: async () => {
      const client = store.client;
      const pipelineId = store.activePipelineId;
      if (!client || !pipelineId) {
        return { error: "No active pipeline. Initialize one first." };
      }
      return client.getPipelineStatus(pipelineId);
    },
  });

  useCopilotAction({
    name: "resolve_gate",
    description: "Resolve an open HITL gate with a decision",
    parameters: [
      { name: "decision", type: "string", description: "APPROVE, STEER, or REJECT", required: true },
      { name: "instructions", type: "string", description: "For STEER: detailed instructions for revision", required: false },
      { name: "reason", type: "string", description: "For REJECT: reason for rejection", required: false },
      { name: "note", type: "string", description: "Optional note", required: false },
    ],
    handler: async (input: any) => {
      const status = store.pipelineStatus;
      if (!status?.activeGate) {
        return { error: "No active gate to resolve" };
      }
      await store.resolveGate(status.activeGate.gateId, input.decision, {
        instructions: input.instructions,
        reason: input.reason,
        note: input.note,
      });
      return `Gate resolved with decision: ${input.decision}`;
    },
  });

  useCopilotAction({
    name: "get_domain_document",
    description: "Get the domain research document",
    parameters: [],
    handler: async () => {
      const status = store.pipelineStatus;
      if (!status?.domainDocument) {
        return { error: "Domain document not yet available" };
      }
      return {
        markdown: status.domainDocument.markdown,
        citations: status.domainDocument.citations,
      };
    },
  });

  useCopilotAction({
    name: "get_plan",
    description: "Get the strategic plan (CEO, Architecture, or Engineering)",
    parameters: [
      { name: "kind", type: "string", description: "ceo, architecture, or engineering", required: true },
    ],
    handler: async (input: any) => {
      const status = store.pipelineStatus;
      if (!status?.plan) {
        return { error: "Plan not yet available" };
      }
      const key = `${input.kind}Plan` as "ceoPlan" | "architecturePlan" | "engineeringPlan";
      return { plan: (status.plan as any)[key] };
    },
  });

  useCopilotAction({
    name: "generate_erd",
    description:
      "Generate (or regenerate) the entity-relationship diagram (EML/DBML) for the active pipeline from its research/domain document.",
    parameters: [],
    handler: async () => {
      const pipelineId = store.activePipelineId;
      if (!pipelineId) return { error: "No active pipeline." };
      const res = await fetch(`/api/pipelines/${pipelineId}/erd/generate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) return { error: data.error };
      return {
        entities: data.schema.entities.map((e: any) => e.name),
        enums: data.schema.enums.map((e: any) => e.name),
        warnings: data.warnings.map((w: any) => w.message),
      };
    },
  });

  useCopilotAction({
    name: "get_erd_preview",
    description: "Get the current ERD as DBML text (dbdiagram.io syntax) plus any parser warnings, without touching the database.",
    parameters: [],
    handler: async () => {
      const pipelineId = store.activePipelineId;
      if (!pipelineId) return { error: "No active pipeline." };
      const res = await fetch(`/api/pipelines/${pipelineId}/erd`);
      const data = await res.json();
      if (!res.ok) return { error: data.error };
      return { dbml: data.dbml, warnings: data.warnings.map((w: any) => w.message) };
    },
  });

  useCopilotAction({
    name: "sync_database_schema",
    description:
      "Diff the ERD against the pipeline's live database and apply the resulting create/alter statements, then refresh the ERD viewer. Requires the pipeline to have reached database provisioning. Destructive changes (drops, type changes) are NOT applied automatically and are returned separately for the user to confirm in the Database panel.",
    parameters: [],
    handler: async () => {
      const pipelineId = store.activePipelineId;
      if (!pipelineId) return { error: "No active pipeline." };
      const res = await fetch(`/api/pipelines/${pipelineId}/erd/sync`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) return { error: data.error };
      return {
        appliedCount: data.applied.length,
        applied: data.applied.map((s: any) => s.description),
        destructivePendingConfirmation: data.destructive.map((s: any) => s.description),
        viewerUrl: data.viewerUrl,
      };
    },
  });

  useCopilotReadable({
    description: "Current DLO pipeline status",
    value: store.pipelineStatus
      ? {
          phase: store.pipelineStatus.phase,
          board: store.pipelineStatus.board,
          activeGate: store.pipelineStatus.activeGate,
          budget: store.pipelineStatus.budget,
        }
      : { phase: "INIT", board: null, activeGate: null, budget: null },
  });

  return null;
}

/**
 * Inner component that uses the DLO store and CopilotKit hooks.
 * Wrapped by CopilotKit in the page component below.
 */
function DloChat({ onConfigSave, copilotKitReady = false }: { onConfigSave?: () => void; copilotKitReady?: boolean }) {
  const store = useDloStore();
  const setClient = useDloStore((state) => state.setClient);
  const [daemonUrl, setDaemonUrl] = useState("http://localhost:8090");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setDaemonUrl(process.env.NEXT_PUBLIC_DLO_DAEMON_URL || window.location.origin);
    }
  }, []);
  const [isConnected, setIsConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<any>(null);
  const [skillsData, setSkillsData] = useState<{ skills: any[]; gstack: any } | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsAction, setSkillsAction] = useState<string | null>(null);
  const [manualResearchMode, setManualResearchMode] = useState(false);
  const [pendingPipelineParams, setPendingPipelineParams] = useState<{
    projectName: string;
    objectivesMarkdown: string;
    workspaceDir: string;
  } | null>(null);
  const [manualResearch, setManualResearch] = useState("");
  const [manualProjectName, setManualProjectName] = useState("");
  const [manualObjectives, setManualObjectives] = useState("");
  const [gateDecision, setGateDecision] = useState<"APPROVE" | "STEER" | "REJECT" | null>(null);
  const [gateInstructions, setGateInstructions] = useState("");
  const [gateReason, setGateReason] = useState("");
  const [gateSubmitting, setGateSubmitting] = useState(false);
  const [gateExhibitTab, setGateExhibitTab] = useState(0);
  const [contextNote, setContextNote] = useState("");
  const [isSubmittingNote, setIsSubmittingNote] = useState(false);
  const [noteSubmitMsg, setNoteSubmitMsg] = useState<string | null>(null);
  const [statusTab, setStatusTab] = useState<"status" | "code" | "erd">("status");
  const [config, setConfig] = useState({
    copilotModel: "gemini-1.5-pro",
    providers: {
      research: { apiKey: "", vendor: "gemini-deep-research" as const, model: "deep-research-preview-04-2026" as string },
      planner: { apiKey: "", vendor: "claude-code" as const, model: "claude-sonnet-5" as string, auth: "api-key" as "api-key" | "subscription", permissionMode: "bypassPermissions" as string },
      reviewer: { apiKey: "", vendor: "claude-code" as const, model: "" as string, permissionMode: "bypassPermissions" as string },
      supervisor: { apiKey: "", vendor: "claude-code" as const, model: "claude-haiku-4-5-20251001" as string },
      executor: { apiKey: "", vendor: "claude-code" as const, model: "claude-haiku-4-5-20251001" as string, maxConcurrent: 4, permissionMode: "acceptEdits" as string },
      harness: { apiKey: "", vendor: "pi" as const, model: "pi-default-model" as string, sdkPackage: "@earendil-works/pi-coding-agent" as const, subagentsExtension: "@gotgenes/pi-subagents" as const, mode: "auto" as string }
    },
    langflow: { url: "", apiKey: "" },
    budgets: { usd: 100, tokens: 10000000, wallClockMs: 3600000 },
    skills: { pluginDirs: [] as string[] },
  });

  const runConfigTest = async (currentConfig: typeof config) => {
    setIsTesting(true);
    setTestResults(null);
    try {
      const res = await fetch("/api/test-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: currentConfig }),
      });
      const data = await res.json();
      if (data.success) {
        setTestResults(data.results);
      } else {
        setTestResults({ error: data.error || "Failed to run verification." });
      }
    } catch (e: any) {
      setTestResults({ error: e.message || "Failed to contact verification API." });
    } finally {
      setIsTesting(false);
    }
  };

  // Initialize DLO client on mount
  useEffect(() => {
    const client = createDloClient(daemonUrl);
    setClient(client);
    setIsConnected(true);
  }, [daemonUrl, setClient]);

  // Fetch skills status on mount
  useEffect(() => {
    fetchSkills();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume pipeline from ?pipeline=<id> URL param or localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("pipeline") || localStorage.getItem("dlo-active-pipeline");
    if (pid && !store.activePipelineId) {
      store.loadPipeline(pid as any);
    }
  }, [store.client]); // re-run once client is ready

  // Load configuration from local storage
  useEffect(() => {
    const stored = localStorage.getItem("dlo-config");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setConfig((prev) => {
          const merged = { ...prev, ...parsed };
          merged.providers = {
            research: { ...prev.providers.research, ...(parsed.providers?.research || {}) },
            planner: { ...prev.providers.planner, ...(parsed.providers?.planner || {}) },
            reviewer: { ...prev.providers.reviewer, ...(parsed.providers?.reviewer || {}) },
            supervisor: { ...prev.providers.supervisor, ...(parsed.providers?.supervisor || {}) },
            executor: { ...prev.providers.executor, ...(parsed.providers?.executor || {}) },
            harness: { ...prev.providers.harness, ...(parsed.providers?.harness || {}) },
          };
          merged.langflow = { ...prev.langflow, ...(parsed.langflow || {}) };
          merged.budgets = { ...prev.budgets, ...(parsed.budgets || {}) };
          merged.skills = { ...prev.skills, ...(parsed.skills || {}) };
          return merged;
        });
      } catch (e) {
        console.error("Failed to load stored configuration:", e);
      }
    }
  }, []);

  const saveConfig = (newConfig: typeof config) => {
    setConfig(newConfig);
    localStorage.setItem("dlo-config", JSON.stringify(newConfig));
    setShowSettings(false);
    if (onConfigSave) {
      onConfigSave();
    }
  };

  const fetchSkills = async () => {
    setSkillsLoading(true);
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      setSkillsData(data);
    } catch {}
    setSkillsLoading(false);
  };

  const runSkillsAction = async (action: string) => {
    setSkillsAction(action);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.ok) await fetchSkills();
      else console.error("Skill action failed:", data.message);
    } catch (e) {
      console.error("Skill action error:", e);
    }
    setSkillsAction(null);
  };

  // Sync manualResearchMode when config changes (e.g. user saves a key in
  // settings) or when a pipeline becomes active — an active pipeline always
  // shows the status board, even in keyless (manual research) setups.
  useEffect(() => {
    if (manualResearchMode && !pendingPipelineParams && (config.providers.research.apiKey || store.pipelineStatus)) {
      setManualResearchMode(false);
    } else if (!config.providers.research.apiKey && !store.pipelineStatus && !manualResearchMode) {
      setManualResearchMode(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.providers.research.apiKey, store.pipelineStatus]);

  const submitManualResearch = async () => {
    if (!manualResearch.trim()) return;
    let activeConfig = { ...config };
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("dlo-config");
        if (stored) activeConfig = JSON.parse(stored);
      } catch {}
    }
    const params = pendingPipelineParams ?? {
      projectName: manualProjectName || "New Project",
      objectivesMarkdown: manualObjectives || "Build the project as described in the research below.",
      workspaceDir: "",
    };
    await store.initPipeline({
      ...params,
      config: activeConfig,
      researchMarkdown: manualResearch,
    });
    setManualResearchMode(false);
    setPendingPipelineParams(null);
    setManualResearch("");
  };

  const handleGateResolve = async (overrideDecision?: "APPROVE" | "STEER" | "REJECT") => {
    const gate = store.pipelineStatus?.activeGate;
    const decision = overrideDecision || gateDecision;
    if (!gate || !decision) return;
    setGateSubmitting(true);
    try {
      await store.resolveGate(gate.gateId as any, decision, {
        instructions: decision === "STEER" ? gateInstructions : undefined,
        reason: decision === "REJECT" ? gateReason : undefined,
      });
      setGateDecision(null);
      setGateInstructions("");
      setGateReason("");
      setGateExhibitTab(0);
    } finally {
      setGateSubmitting(false);
    }
  };

  const handleWorkspaceSteer = async (file: string, fromLine: number, toLine: number, instruction: string) => {
    if (!store.activePipelineId) return;
    const lineRef = fromLine === toLine ? `line ${fromLine}` : `lines ${fromLine}–${toLine}`;
    const note = `[Workspace: ${file} ${lineRef}]: ${instruction}`;
    await fetch(`/api/pipelines/${store.activePipelineId}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
  };

  const submitContextNote = async () => {
    if (!contextNote.trim() || !store.activePipelineId) return;
    setIsSubmittingNote(true);
    setNoteSubmitMsg(null);
    try {
      const res = await fetch(`/api/pipelines/${store.activePipelineId}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: contextNote.trim() }),
      });
      if (res.ok) {
        setContextNote("");
        setNoteSubmitMsg("Note saved.");
        setTimeout(() => setNoteSubmitMsg(null), 2500);
      } else {
        setNoteSubmitMsg("Failed to save note.");
      }
    } finally {
      setIsSubmittingNote(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      {/* Only register copilot actions/readables when CopilotKit is actually wrapping this component */}
      {copilotKitReady && (
        <CopilotActions
          config={config}
          store={store}
          setPendingPipelineParams={setPendingPipelineParams}
          setManualProjectName={setManualProjectName}
          setManualObjectives={setManualObjectives}
          setManualResearchMode={setManualResearchMode}
        />
      )}
      {/* Header */}
      <div className="bg-slate-950 border-b border-slate-700 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Zap className="w-6 h-6 text-blue-400" />
              DLO Pipeline Controller
            </h1>
            <p className="text-slate-400 text-sm">Autonomous development pipeline orchestrator</p>
          </div>

          <div className="flex items-center gap-4">
            {/* Database & ERD button — shown once the research agent has produced a domain document */}
            {store.activePipelineId && (store.pipelineStatus as any)?.domainDocument && (
              <a
                href={`/erd?pipeline=${store.activePipelineId}`}
                className="flex items-center gap-2 px-3 py-1.5 bg-blue-800 hover:bg-blue-700 text-blue-100 hover:text-white rounded border border-blue-700 transition text-sm"
              >
                <Database className="w-4 h-4" /> Database &amp; ERD
              </a>
            )}

            {/* Agent Designer button — shown when a plan with modules is available */}
            {store.activePipelineId && (store.pipelineStatus as any)?.plan?.engineeringPlan && (
              <a
                href={`/designer?pipeline=${store.activePipelineId}`}
                className="flex items-center gap-2 px-3 py-1.5 bg-indigo-800 hover:bg-indigo-700 text-indigo-100 hover:text-white rounded border border-indigo-700 transition text-sm"
              >
                <GitBranch className="w-4 h-4" /> Agent Designer
              </a>
            )}

            {/* Settings Button */}
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded border border-slate-700 transition text-sm"
            >
              <Settings className="w-4 h-4" /> Config Keys & Limits
            </button>

            {/* Status indicator */}
            {store.pipelineStatus && (
              <div className="flex items-center gap-4">
                <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
                  <div className="text-xs text-slate-400 mb-1">Phase</div>
                  <div className="text-sm font-semibold text-blue-300">
                    {store.pipelineStatus.phase}
                  </div>
                </div>

                {store.pipelineStatus.activeGate && (
                  <div className="bg-amber-900 rounded-lg p-3 border border-amber-700">
                    <div className="text-xs text-amber-200 mb-1">HITL Gate Open</div>
                    <div className="text-sm font-semibold text-amber-100">
                      {store.pipelineStatus.activeGate.kind}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* API key warning banner */}
      {!config.providers.research.apiKey && (
        <div className="bg-amber-900/50 border-b border-amber-700 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center gap-2 text-amber-200 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>
              No Gemini API key configured. Chat requires a key — add it in{" "}
              <button
                onClick={() => setShowSettings(true)}
                className="underline hover:text-white transition"
              >
                Config Keys &amp; Limits
              </button>{" "}
              or set <code className="font-mono text-xs bg-amber-800/60 px-1 rounded">GEMINI_API_KEY</code> in your environment.
            </span>
          </div>
        </div>
      )}

      {/* Gstack missing banner */}
      {skillsData && !skillsData.gstack.installed && (
        <div className="bg-violet-900/50 border-b border-violet-700 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center gap-2 text-violet-200 text-sm">
            <Zap className="w-4 h-4 flex-shrink-0 text-violet-300" />
            <span className="flex-1">
              <strong>gstack skills not installed</strong> — CEO review, QA, design review and other AI skills are unavailable.
            </span>
            <button
              onClick={() => runSkillsAction("install-gstack")}
              disabled={!!skillsAction}
              className="flex items-center gap-1 px-3 py-1 rounded text-xs bg-violet-700 hover:bg-violet-600 disabled:opacity-50 text-white font-medium"
            >
              {skillsAction === "install-gstack" ? <><RefreshCw className="w-3 h-3 animate-spin" /> Installing…</> : "Install gstack"}
            </button>
          </div>
        </div>
      )}

      {/* Pipeline load error banner */}
      {store.error && !store.activePipelineId && (
        <div className="bg-red-900/50 border-b border-red-700 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center gap-2 text-red-200 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{store.error}</span>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        {/* When no key: research panel takes full width; when key present: 2/3 chat + 1/3 panel */}
        <div className={`h-full grid grid-cols-1 gap-4 p-4 ${config.providers.research.apiKey ? "md:grid-cols-3" : "md:grid-cols-1"}`}>
          {/* Chat — only mount when CopilotKit is actually wrapping this component */}
          {copilotKitReady && (
            <div className="md:col-span-2 bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
              <CopilotChat
                instructions="You are DLO, an autonomous development pipeline orchestrator. Help the user initialize pipelines, monitor progress, resolve HITL gates, and view generated artifacts. Be professional, concise, and always provide actionable feedback."
                labels={{
                  title: "DLO Chat",
                  initial: "👋 Hello! I'm DLO. I can help you orchestrate autonomous development pipelines. Try saying 'initialize a new pipeline' or 'check pipeline status'.",
                  placeholder: "Ask me about your pipeline...",
                }}
              />
            </div>
          )}

          {/* Status / Manual Research panel */}
          {(manualResearchMode || (!store.pipelineStatus && !config.providers.research.apiKey && isConnected)) ? (
            /* ── Manual research input ── */
            <div className="bg-slate-800 rounded-lg border border-amber-700/60 flex flex-col overflow-hidden">
              {/* Panel header */}
              <div className="bg-amber-900/40 border-b border-amber-700/60 px-4 py-3 flex items-center gap-2">
                <Activity className="w-4 h-4 text-amber-300 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <h2 className="text-sm font-semibold text-amber-200">Paste Your Research</h2>
                  <p className="text-xs text-amber-300/70">
                    Research agent unavailable — provide your own research to proceed directly to planning.
                  </p>
                </div>
                {manualResearchMode && (
                  <button
                    onClick={() => { setManualResearchMode(false); setPendingPipelineParams(null); }}
                    className="text-amber-400 hover:text-white transition flex-shrink-0"
                    title="Cancel"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Fields */}
              <div className="flex flex-col flex-1 gap-3 p-4 overflow-hidden">
                {/* Project name */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-400 uppercase tracking-wide">Project Name</label>
                  <input
                    type="text"
                    value={manualProjectName}
                    onChange={e => setManualProjectName(e.target.value)}
                    placeholder="e.g. TodoApp"
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition"
                  />
                </div>

                {/* Objectives */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-400 uppercase tracking-wide">Objectives</label>
                  <textarea
                    value={manualObjectives}
                    onChange={e => setManualObjectives(e.target.value)}
                    placeholder="What should this project accomplish?"
                    rows={2}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition resize-none"
                  />
                </div>

                {/* Big research textarea */}
                <div className="flex flex-col gap-1 flex-1 min-h-0">
                  <label className="text-xs text-slate-400 uppercase tracking-wide">
                    Research &amp; Requirements
                  </label>
                  <textarea
                    value={manualResearch}
                    onChange={e => setManualResearch(e.target.value)}
                    placeholder={"Paste your full research here — technical requirements, architecture notes, API specs, data models, user flows, constraints, or any context the planner should know.\n\nMarkdown supported."}
                    className="flex-1 w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition resize-none font-mono leading-relaxed"
                  />
                </div>

                {/* Submit */}
                <button
                  onClick={submitManualResearch}
                  disabled={!manualResearch.trim() || store.isPolling}
                  className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded transition flex items-center justify-center gap-2"
                >
                  <Zap className="w-4 h-4" />
                  {store.isPolling ? "Starting pipeline…" : "Start Pipeline with This Research"}
                </button>
              </div>
            </div>
          ) : (
            /* ── Pipeline Status panel ── */
            <div className="bg-slate-800 rounded-lg border border-slate-700 flex flex-col overflow-hidden">
              {/* Tab bar */}
              <div className="flex items-center border-b border-slate-700 flex-shrink-0">
                <button
                  onClick={() => setStatusTab("status")}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition border-b-2 ${
                    statusTab === "status"
                      ? "border-blue-400 text-white"
                      : "border-transparent text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Activity className="w-4 h-4" /> Status
                </button>
                {store.pipelineStatus && ["EXECUTION_RUNNING", "DB_PROVISIONING_RUNNING", "TESTING_RUNNING", "APP_LAUNCH_RUNNING", "COMPLETED", "FAILED"].includes(store.pipelineStatus.phase) && (
                  <button
                    onClick={() => setStatusTab("code")}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition border-b-2 ${
                      statusTab === "code"
                        ? "border-blue-400 text-white"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <Code2 className="w-4 h-4" /> Workspace
                  </button>
                )}
                {store.pipelineStatus && (store.pipelineStatus as any)?.domainDocument && (
                  <button
                    onClick={() => setStatusTab("erd")}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition border-b-2 ${
                      statusTab === "erd"
                        ? "border-blue-400 text-white"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <Database className="w-4 h-4" /> Database
                  </button>
                )}
              </div>

              {/* Code panel */}
              {statusTab === "code" && store.activePipelineId && (
                <div className="flex-1 overflow-hidden min-h-0">
                  <WorkspaceViewer
                    pipelineId={store.activePipelineId}
                    isRunning={["EXECUTION_RUNNING", "DB_PROVISIONING_RUNNING", "TESTING_RUNNING", "APP_LAUNCH_RUNNING"].includes(store.pipelineStatus?.phase ?? "")}
                    onSteer={handleWorkspaceSteer}
                  />
                </div>
              )}

              {/* ERD / Database panel */}
              {statusTab === "erd" && store.activePipelineId && (
                <div className="flex-1 overflow-hidden min-h-0">
                  <ErdPanel pipelineId={store.activePipelineId} />
                </div>
              )}

              {/* Status panel */}
              {statusTab === "status" && (
              <div className="p-4 overflow-y-auto flex-1">
              <h2 className="text-lg font-semibold text-white mb-4">Pipeline Status</h2>

              {!isConnected ? (
                <div className="text-amber-300 flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold">Not connected</p>
                    <p className="text-sm text-amber-200">
                      Ensure DLO daemon is running on {daemonUrl}
                    </p>
                  </div>
                </div>
              ) : store.pipelineStatus ? (
                <div className="space-y-4">
                  {/* Pipeline ID */}
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wide">Pipeline ID</p>
                    <p className="text-sm font-mono text-slate-200 break-all">
                      {store.pipelineStatus.pipelineId}
                    </p>
                  </div>

                  {/* Phase indicator with elapsed time + stuck detection */}
                  <PhaseIndicator
                    status={store.pipelineStatus}
                    pipelineId={store.activePipelineId ?? ""}
                    onResume={() => store.loadPipeline(store.activePipelineId as any)}
                  />

                  {/* Phase history timeline */}
                  {((store.pipelineStatus as any).phaseHistory as Array<{phase: string; timestamp: string}> | undefined)?.length ? (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">History</p>
                      <div className="relative pl-4 space-y-0">
                        {((store.pipelineStatus as any).phaseHistory as Array<{phase: string; timestamp: string}>).map((entry, i, arr) => {
                          const isCurrent = i === arr.length - 1;
                          return (
                            <div key={i} className="relative flex items-start gap-2 pb-2">
                              {i < arr.length - 1 && (
                                <div className="absolute left-0 top-2.5 bottom-0 w-px bg-slate-700" />
                              )}
                              <div className={`absolute left-[-1px] top-1.5 w-2.5 h-2.5 rounded-full border-2 ${isCurrent ? "bg-blue-400 border-blue-400" : "bg-green-500 border-green-500"}`} />
                              <div className="ml-4">
                                <span className={`text-xs font-mono ${isCurrent ? "text-blue-300 font-semibold" : "text-slate-400"}`}>
                                  {entry.phase}
                                </span>
                                <span className="text-xs text-slate-600 ml-2">
                                  {format(new Date(entry.timestamp), "HH:mm:ss.SSS")}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Gate review — Tool Install Permission (CodeWhale / OCR) */}
                  {store.pipelineStatus.activeGate?.kind === "TOOL_INSTALL_PERMISSION" && (
                    <div className="rounded-lg border border-violet-700/60 bg-violet-900/20 overflow-hidden">
                      <div className="bg-violet-900/40 border-b border-violet-700/60 px-3 py-2 flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-violet-300 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-violet-200">AI Tools Required</p>
                          <p className="text-xs text-violet-300/70">
                            The pipeline needs these tools to generate code. Install automatically, or use Claude Haiku instead.
                          </p>
                        </div>
                      </div>
                      <div className="p-3 space-y-2">
                        <p className="text-xs font-medium text-violet-300">Missing:</p>
                        <ul className="space-y-1">
                          {((store.pipelineStatus.activeGate as any).context)?.toolsToInstall?.map((t: string) => (
                            <li key={t} className="text-xs text-slate-300 font-mono flex items-start gap-1.5">
                              <span className="text-red-400 mt-0.5">✗</span>
                              <span>{t}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-[11px] text-slate-500 pt-1">
                          "Install Tools" runs <code className="bg-slate-800 px-1 rounded">scripts/install-ai-tools.sh</code> and
                          auto-configures CodeWhale with any available provider key
                          (DEEPSEEK_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY).
                        </p>
                      </div>
                      <div className="px-3 pb-3 flex gap-2">
                        <button
                          disabled={gateSubmitting}
                          className="flex-1 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-semibold rounded transition flex items-center justify-center gap-1.5"
                          onClick={() => handleGateResolve("APPROVE")}
                        >
                          {gateSubmitting ? (
                            <>
                              <RefreshCw className="w-3 h-3 animate-spin" />
                              Installing & configuring…
                            </>
                          ) : (
                            "Install Tools"
                          )}
                        </button>
                        <button
                          disabled={gateSubmitting}
                          className="flex-1 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-blue-100 text-xs font-semibold rounded transition"
                          onClick={() => handleGateResolve("USE_CLAUDE" as any)}
                        >
                          Use Claude Haiku
                        </button>
                        <button
                          disabled={gateSubmitting}
                          className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-semibold rounded transition"
                          onClick={() => handleGateResolve("REJECT")}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Gate review — Terminal Permission (db/test/launch approval) */}
                  {store.pipelineStatus.activeGate?.kind === "TERMINAL_PERMISSION" && (
                    <div className="rounded-lg border border-blue-700/60 bg-blue-900/20 overflow-hidden">
                      <div className="bg-blue-900/40 border-b border-blue-700/60 px-3 py-2 flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-blue-300 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-blue-200">
                            Permission Required: {String(store.pipelineStatus.activeGate.exhibits[0] ?? "")}
                          </p>
                          <p className="text-xs text-blue-300/70">Approve to allow · Skip to proceed without this step</p>
                        </div>
                      </div>
                      <div className="max-h-40 overflow-y-auto p-3">
                        <pre className="text-xs text-slate-200 whitespace-pre-wrap font-mono leading-relaxed">
                          {String(store.pipelineStatus.activeGate.exhibits[1] ?? "")}
                        </pre>
                      </div>
                      {store.pipelineStatus.activeGate.exhibits[2] != null && (
                        <div className="px-3 pb-2">
                          <p className="text-xs text-slate-400">{String(store.pipelineStatus.activeGate.exhibits[2] as string)}</p>
                        </div>
                      )}
                      <div className="px-3 pb-3 flex gap-2">
                        <button
                          disabled={gateSubmitting}
                          className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded transition"
                          onClick={() => handleGateResolve("APPROVE")}
                        >
                          {gateSubmitting ? "Running…" : "Approve & Run"}
                        </button>
                        <button
                          disabled={gateSubmitting}
                          className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-semibold rounded transition"
                          onClick={() => handleGateResolve("REJECT")}
                        >
                          Skip
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Gate review — Standard HITL (DOMAIN_DOCUMENT / TRIPARTITE_PLAN) */}
                  {store.pipelineStatus.activeGate && store.pipelineStatus.activeGate.kind !== "TERMINAL_PERMISSION" && store.pipelineStatus.activeGate.kind !== "TOOL_INSTALL_PERMISSION" && (
                    <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 overflow-hidden">
                      <div className="bg-amber-900/40 border-b border-amber-700/60 px-3 py-2 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-300 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-amber-200">
                            {store.pipelineStatus.activeGate.kind === "DOMAIN_DOCUMENT"
                              ? "Review: Research Document"
                              : store.pipelineStatus.activeGate.kind === "DESIGN_REVIEW"
                              ? "Review: Design Documents (Architecture · Database · Implementation)"
                              : "Review: Tripartite Plan"}
                          </p>
                          <p className="text-xs text-amber-300/70">Approve to proceed · Steer to revise · Reject to fail</p>
                          {(store.pipelineStatus.activeGate.kind === "DESIGN_REVIEW" || store.pipelineStatus.activeGate.kind === "DOMAIN_DOCUMENT") && (
                            <a
                              href={`/documents?pipeline=${store.activePipelineId}`}
                              className="text-xs text-blue-300 underline hover:text-blue-200"
                            >
                              Open the Documents page to read, edit, and work through the CEO-review enhancements →
                            </a>
                          )}
                        </div>
                      </div>

                      {store.pipelineStatus.activeGate.kind === "DESIGN_REVIEW" && (
                        <div className="flex border-b border-amber-700/40">
                          {["Architecture.md", "Database.md", "Implementation.md"].map((label, i) => (
                            <button
                              key={label}
                              onClick={() => setGateExhibitTab(i)}
                              className={`flex-1 px-2 py-1.5 text-xs font-medium transition ${
                                gateExhibitTab === i
                                  ? "bg-amber-800/40 text-amber-100"
                                  : "text-amber-400 hover:text-amber-200"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}

                      {store.pipelineStatus.activeGate.kind === "TRIPARTITE_PLAN" && (
                        <div className="flex border-b border-amber-700/40">
                          {["CEO Plan", "Architecture", "Engineering"].map((label, i) => (
                            <button
                              key={label}
                              onClick={() => setGateExhibitTab(i)}
                              className={`flex-1 px-2 py-1.5 text-xs font-medium transition ${
                                gateExhibitTab === i
                                  ? "bg-amber-800/40 text-amber-100"
                                  : "text-amber-400 hover:text-amber-200"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="max-h-48 overflow-y-auto p-3">
                        <pre className="text-xs text-slate-200 whitespace-pre-wrap font-mono leading-relaxed">
                          {String((store.pipelineStatus.activeGate.exhibits as any[])[gateExhibitTab] ?? "")}
                        </pre>
                      </div>

                      {gateDecision === "STEER" && (
                        <div className="px-3 pb-2">
                          <textarea
                            value={gateInstructions}
                            onChange={e => setGateInstructions(e.target.value)}
                            placeholder="Describe what to revise..."
                            rows={3}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition resize-none"
                          />
                        </div>
                      )}

                      {gateDecision === "REJECT" && (
                        <div className="px-3 pb-2">
                          <textarea
                            value={gateReason}
                            onChange={e => setGateReason(e.target.value)}
                            placeholder="Reason for rejection..."
                            rows={3}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 transition resize-none"
                          />
                        </div>
                      )}

                      <div className="px-3 pb-3 flex gap-2">
                        {gateDecision ? (
                          <>
                            <button
                              onClick={() => handleGateResolve()}
                              disabled={
                                gateSubmitting ||
                                (gateDecision === "STEER" && !gateInstructions.trim()) ||
                                (gateDecision === "REJECT" && !gateReason.trim())
                              }
                              className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded transition"
                            >
                              {gateSubmitting ? "Submitting…" : `Confirm ${gateDecision}`}
                            </button>
                            <button
                              onClick={() => { setGateDecision(null); setGateInstructions(""); setGateReason(""); }}
                              disabled={gateSubmitting}
                              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded transition"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => setGateDecision("APPROVE")}
                              className="flex-1 py-2 bg-green-700 hover:bg-green-600 text-white text-xs font-semibold rounded transition"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => setGateDecision("STEER")}
                              className="flex-1 py-2 bg-amber-700 hover:bg-amber-600 text-white text-xs font-semibold rounded transition"
                            >
                              Steer
                            </button>
                            <button
                              onClick={() => setGateDecision("REJECT")}
                              className="flex-1 py-2 bg-red-800 hover:bg-red-700 text-white text-xs font-semibold rounded transition"
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Module board */}
                  {store.pipelineStatus.board && (() => {
                    const mods = store.pipelineStatus.board.modules;
                    const planMods: any[] = (store.pipelineStatus as any).plan?.engineeringPlan?.modules ?? [];
                    const nPassed = mods.filter((m) => m.status === "PASSED").length;
                    const nFailed = mods.filter((m) => m.status === "FAILED" || m.status === "BLOCKED").length;
                    const nExec = mods.filter((m) => m.status === "EXECUTING").length;
                    const nPending = mods.filter((m) => m.status === "PENDING").length;
                    const total = mods.length;
                    const pct = total > 0 ? Math.round((nPassed / total) * 100) : 0;
                    return (
                      <div>
                        {/* Header + progress */}
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-xs text-slate-400 uppercase tracking-wide">
                            Modules
                          </p>
                          <span className="text-[10px] text-slate-500">
                            {nPassed}/{total} done
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-800 rounded-full mb-2 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${pct}%`,
                              background: nFailed > 0 ? "#ef4444" : "#22c55e",
                            }}
                          />
                        </div>
                        {/* Stats row */}
                        <div className="flex gap-3 mb-2 text-[10px]">
                          {nExec > 0 && <span className="text-blue-400">{nExec} executing</span>}
                          {nPassed > 0 && <span className="text-green-400">{nPassed} passed</span>}
                          {nFailed > 0 && <span className="text-red-400">{nFailed} failed/blocked</span>}
                          {nPending > 0 && <span className="text-slate-500">{nPending} pending</span>}
                        </div>
                        {/* Module rows — all visible, scrollable */}
                        <div className="space-y-1 max-h-72 overflow-y-auto pr-0.5">
                          {mods.map((mod) => {
                            const planMod = planMods.find((m: any) => m.moduleId === mod.moduleId);
                            const title = planMod?.title || mod.moduleId;
                            const failure = (mod as any).failure as string | undefined;
                            const touches: string[] = planMod?.touches ?? [];
                            const deps: string[] = planMod?.dependsOn ?? [];
                            const depTitles = deps.map((d: string) => {
                              const pm = planMods.find((m: any) => m.moduleId === d);
                              return pm?.title || d;
                            });

                            const isFailed = mod.status === "FAILED" || mod.status === "BLOCKED";
                            const isExec = mod.status === "EXECUTING";
                            const isPassed = mod.status === "PASSED";

                            const borderCls = isFailed
                              ? "border-red-700/60 bg-red-950/20"
                              : isExec
                              ? "border-blue-600/40 bg-blue-950/20"
                              : isPassed
                              ? "border-green-800/40 bg-green-950/10"
                              : "border-slate-700/40";

                            return (
                              <div
                                key={mod.moduleId}
                                className={`rounded px-2 py-1.5 border ${borderCls}`}
                              >
                                <div className="flex items-center gap-2 text-xs">
                                  {isPassed ? (
                                    <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                                  ) : isExec ? (
                                    <Activity className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 animate-spin" />
                                  ) : mod.status === "FAILED" ? (
                                    <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                                  ) : mod.status === "BLOCKED" ? (
                                    <AlertCircle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
                                  ) : (
                                    <Clock className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
                                  )}
                                  <span className={`font-medium truncate flex-1 ${isFailed ? "text-red-200" : isExec ? "text-blue-200" : isPassed ? "text-green-200" : "text-slate-400"}`}>
                                    {title}
                                  </span>
                                  <div className="flex items-center gap-1.5 flex-shrink-0">
                                    {mod.attempts > 0 && (
                                      <span className={`text-[10px] ${mod.attempts > 1 ? "text-amber-400" : "text-slate-600"}`}>
                                        ×{mod.attempts}
                                      </span>
                                    )}
                                    <span className={`text-[9px] px-1 py-0.5 rounded font-mono ${
                                      isPassed ? "bg-green-900/60 text-green-400"
                                      : isExec ? "bg-blue-900/60 text-blue-400"
                                      : isFailed ? "bg-red-900/60 text-red-400"
                                      : "bg-slate-800 text-slate-500"
                                    }`}>
                                      {mod.status}
                                    </span>
                                  </div>
                                </div>
                                {/* Failure / block reason */}
                                {failure && (
                                  <div className="mt-1 ml-5 text-[10px] text-red-300/80 font-mono bg-red-950/30 rounded px-1.5 py-1 break-words leading-snug">
                                    {failure.slice(0, 400)}{failure.length > 400 ? "…" : ""}
                                  </div>
                                )}
                                {/* Deps (only if pending/blocked and has deps) */}
                                {depTitles.length > 0 && !isPassed && !isExec && (
                                  <div className="mt-0.5 ml-5 text-[10px] text-slate-600">
                                    needs: {depTitles.join(" → ")}
                                  </div>
                                )}
                                {/* Files touched */}
                                {touches.length > 0 && (
                                  <div className="mt-0.5 ml-5 text-[10px] text-slate-600 truncate">
                                    {touches.slice(0, 3).join(" · ")}{touches.length > 3 ? ` +${touches.length - 3}` : ""}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Test Results */}
                  {(store.pipelineStatus as any).testResults && (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1">
                        <FlaskConical className="w-3 h-3" /> Test Results
                      </p>
                      <div className={`rounded px-3 py-2 border ${(store.pipelineStatus as any).testResults.passed ? "border-green-700/60 bg-green-900/20" : "border-red-700/60 bg-red-900/20"}`}>
                        <div className="flex items-center gap-2 text-xs">
                          {(store.pipelineStatus as any).testResults.passed
                            ? <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                            : <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                          <span className={`font-semibold ${(store.pipelineStatus as any).testResults.passed ? "text-green-300" : "text-red-300"}`}>
                            {(store.pipelineStatus as any).testResults.passed ? "Tests Passed" : "Tests Failed"}
                          </span>
                          <span className="text-slate-500 ml-auto">
                            {((store.pipelineStatus as any).testResults.durationMs / 1000).toFixed(1)}s
                          </span>
                        </div>
                        {(store.pipelineStatus as any).testResults.supervisorReasoning && (
                          <p className="text-xs text-slate-400 mt-1 italic">
                            Supervisor: {(store.pipelineStatus as any).testResults.supervisorReasoning}
                          </p>
                        )}
                        {(store.pipelineStatus as any).testResults.output && (
                          <details className="mt-1">
                            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300">View output</summary>
                            <pre className="text-xs text-slate-400 whitespace-pre-wrap font-mono mt-1 max-h-32 overflow-y-auto">
                              {(store.pipelineStatus as any).testResults.output.slice(-1000)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </div>
                  )}

                  {/* DB Connection */}
                  {(store.pipelineStatus as any).dbConnectionString && (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                        <Database className="w-3 h-3" /> Database
                      </p>
                      <div className="bg-slate-900 rounded px-2 py-1.5 border border-slate-700/50">
                        <p className="text-xs font-mono text-green-400 break-all">
                          {(store.pipelineStatus as any).dbConnectionString}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Running App */}
                  {(store.pipelineStatus as any).appUrl && (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                        <Rocket className="w-3 h-3" /> Application
                      </p>
                      <a
                        href={(store.pipelineStatus as any).appUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 bg-green-900/30 border border-green-700/50 rounded px-3 py-2 text-xs text-green-300 hover:bg-green-900/50 transition group"
                      >
                        <Rocket className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate font-mono">{(store.pipelineStatus as any).appUrl}</span>
                        <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-50 group-hover:opacity-100 transition ml-auto" />
                      </a>
                    </div>
                  )}

                  {/* Budget */}
                  {store.pipelineStatus.budget && (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Budget</p>
                      <div className="space-y-1 text-xs">
                        {Object.entries(store.pipelineStatus.budget.spent || {})
                          .slice(0, 3)
                          .map(([dim, spent]) => (
                            <div key={dim} className="flex justify-between text-slate-300">
                              <span>{dim}</span>
                              <span className="font-mono text-amber-300">
                                {spent} / {store.pipelineStatus?.budget?.remaining?.[dim]}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Context notes — always visible as long as there is a pipeline */}
                  {store.activePipelineId && (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Context Notes</p>
                      <div className="bg-slate-900 rounded border border-blue-700/40 p-2 space-y-2">
                        <p className="text-xs text-slate-500">
                          Steer the pipeline at any stage — add constraints, corrections, or new requirements.
                        </p>
                        <textarea
                          value={contextNote}
                          onChange={(e) => setContextNote(e.target.value)}
                          placeholder="e.g. 'Skip the filter tabs', 'Use Zustand instead of Context', 'Add dark mode'…"
                          rows={3}
                          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            onClick={submitContextNote}
                            disabled={!contextNote.trim() || isSubmittingNote}
                            className="flex-1 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded transition"
                          >
                            {isSubmittingNote ? "Saving…" : "Send Note"}
                          </button>
                          {noteSubmitMsg && (
                            <span className="text-xs text-green-400">{noteSubmitMsg}</span>
                          )}
                        </div>
                      </div>
                      {((store.pipelineStatus as any).contextNotes as Array<{note: string; timestamp: string}> | undefined)?.length ? (
                        <div className="mt-2 space-y-1">
                          {((store.pipelineStatus as any).contextNotes as Array<{note: string; timestamp: string}>)
                            .slice(-3)
                            .map((cn, i) => (
                              <div key={i} className="bg-slate-900 rounded px-2 py-1 text-xs border-l-2 border-blue-700/60">
                                <p className="text-slate-300 break-words">{cn.note}</p>
                                <p className="text-slate-600 mt-0.5">{format(new Date(cn.timestamp), "HH:mm:ss")}</p>
                              </div>
                            ))}
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* Timestamps */}
                  <div className="pt-2 border-t border-slate-700">
                    <p className="text-xs text-slate-400">
                      Created:{" "}
                      <span className="text-slate-300">
                        {format(new Date(store.pipelineStatus.createdAt), "MMM d, HH:mm:ss")}
                      </span>
                    </p>
                    <p className="text-xs text-slate-400">
                      Updated:{" "}
                      <span className="text-slate-300">
                        {format(new Date(store.pipelineStatus.lastTransitionAt), "MMM d, HH:mm:ss")}
                      </span>
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-slate-400 text-sm">Initialize a pipeline to get started.</p>
              )}
              </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full max-h-[90vh] flex flex-col shadow-2xl transition">
            <div className="flex items-center justify-between border-b border-slate-700 p-6 pb-4 flex-shrink-0">

              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-blue-400" />
                Configure Keys & Limits
              </h2>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-white transition">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="overflow-y-auto flex-1 p-6 pt-4 space-y-4 text-sm text-slate-300">
              <p className="text-xs text-slate-400">
                Provide credentials/keys to override default environment variables (e.g. GEMINI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY).
              </p>
              
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Google Gemini API Key (Deep Research)
                </label>
                <input
                  type="password"
                  placeholder="Defaults to process.env.GEMINI_API_KEY"
                  value={config.providers.research.apiKey}
                  onChange={(e) => setConfig({
                    ...config,
                    providers: {
                      ...config.providers,
                      research: { ...config.providers.research, apiKey: e.target.value }
                    }
                  })}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Gemini Research Model (Deep Research)
                </label>
                <select
                  value={["deep-research-preview-04-2026", "deep-research-max-preview-04-2026"].includes(config.providers.research.model) ? config.providers.research.model : "custom"}
                  onChange={(e) => {
                    const val = e.target.value;
                    setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        research: {
                          ...config.providers.research,
                          model: val !== "custom" ? val : "deep-research-preview-04-2026"
                        }
                      }
                    });
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-2"
                >
                  <option value="deep-research-preview-04-2026">deep-research-preview-04-2026</option>
                  <option value="deep-research-max-preview-04-2026">deep-research-max-preview-04-2026</option>
                  <option value="custom">Custom Model Name...</option>
                </select>
                
                {!["deep-research-preview-04-2026", "deep-research-max-preview-04-2026"].includes(config.providers.research.model) && (
                  <input
                    type="text"
                    placeholder="Enter custom Gemini Research model name"
                    value={config.providers.research.model || ""}
                    onChange={(e) => setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        research: { ...config.providers.research, model: e.target.value }
                      }
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mt-1"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Copilot Chat Model
                </label>
                <select
                  value={["gemini-1.5-pro", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"].includes(config.copilotModel) ? config.copilotModel : "custom"}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val !== "custom") {
                      setConfig({
                        ...config,
                        copilotModel: val
                      });
                    } else {
                      setConfig({
                        ...config,
                        copilotModel: "gemini-2.5-flash" // custom default
                      });
                    }
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-2"
                >
                  <option value="gemini-1.5-pro">gemini-1.5-pro</option>
                  <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  <option value="gemini-2.0-flash">gemini-2.0-flash</option>
                  <option value="gemini-flash-latest">gemini-flash-latest</option>
                  <option value="custom">Custom Model Name...</option>
                </select>
                
                {(!["gemini-1.5-pro", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"].includes(config.copilotModel)) && (
                  <input
                    type="text"
                    placeholder="Enter custom Gemini model name"
                    value={config.copilotModel || ""}
                    onChange={(e) => setConfig({
                      ...config,
                      copilotModel: e.target.value
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mt-1"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Claude Code Auth
                </label>
                <select
                  value={config.providers.planner.auth || "api-key"}
                  onChange={(e) => setConfig({
                    ...config,
                    providers: {
                      ...config.providers,
                      planner: { ...config.providers.planner, auth: e.target.value as "api-key" | "subscription" }
                    }
                  })}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-2"
                >
                  <option value="subscription">Coding subscription plan (claude CLI login — no API key billed)</option>
                  <option value="api-key">API key (ANTHROPIC_API_KEY)</option>
                </select>
                {config.providers.planner.auth === "subscription" ? (
                  <p className="text-[11px] text-slate-500 mb-3">
                    The server's <code className="bg-slate-800 px-1 rounded">claude</code> CLI must be logged in
                    (run <code className="bg-slate-800 px-1 rounded">claude setup-token</code> on the host).
                    ANTHROPIC_API_KEY is stripped from the agent environment.
                  </p>
                ) : (
                <input
                  type="password"
                  placeholder="Defaults to process.env.ANTHROPIC_API_KEY"
                  value={config.providers.planner.apiKey}
                  onChange={(e) => setConfig({
                    ...config,
                    providers: {
                      ...config.providers,
                      planner: { ...config.providers.planner, apiKey: e.target.value },
                      supervisor: { ...config.providers.supervisor, apiKey: e.target.value }
                    }
                  })}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-3"
                />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Langflow URL (subagent configuration)
                </label>
                <input
                  type="text"
                  placeholder="http://localhost:7860 — leave empty to use the built-in designer canvas"
                  value={config.langflow?.url || ""}
                  onChange={(e) => setConfig({
                    ...config,
                    langflow: { ...(config.langflow || { apiKey: "" }), url: e.target.value }
                  })}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-3"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Planner Model (Claude Code)
                </label>
                <select
                  value={["claude-haiku-4-5-20251001", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-latest", "claude-3-opus-latest", "gemini-2.5-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite-001"].includes(config.providers.planner.model || "") ? config.providers.planner.model : "custom"}
                  onChange={(e) => {
                    const val = e.target.value;
                    setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        planner: {
                          ...config.providers.planner,
                          model: val !== "custom" ? val : "claude-3-5-sonnet-latest"
                        }
                      }
                    });
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-2"
                >
                  <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
                  <option value="claude-3-5-sonnet-latest">claude-3-5-sonnet-latest</option>
                  <option value="claude-3-5-sonnet-20241022">claude-3-5-sonnet-20241022</option>
                  <option value="claude-3-5-haiku-latest">claude-3-5-haiku-latest</option>
                  <option value="claude-3-opus-latest">claude-3-opus-latest</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  <option value="gemini-2.0-flash-001">gemini-2.0-flash-001</option>
                  <option value="gemini-2.0-flash-lite-001">gemini-2.0-flash-lite-001</option>
                  <option value="custom">Custom Model Name...</option>
                </select>
                
                {!["claude-haiku-4-5-20251001", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-latest", "claude-3-opus-latest", "gemini-2.5-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite-001"].includes(config.providers.planner.model || "") && (
                  <input
                    type="text"
                    placeholder="Enter custom model name (e.g. gemini-2.0-flash-001)"
                    value={config.providers.planner.model || ""}
                    onChange={(e) => setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        planner: { ...config.providers.planner, model: e.target.value }
                      }
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mt-1"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Supervisor Model (Claude Code)
                </label>
                <select
                  value={["claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-latest", "claude-3-opus-latest", "gemini-2.5-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite-001"].includes(config.providers.supervisor.model || "") ? config.providers.supervisor.model : "custom"}
                  onChange={(e) => {
                    const val = e.target.value;
                    setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        supervisor: {
                          ...config.providers.supervisor,
                          model: val !== "custom" ? val : "claude-3-5-sonnet-latest"
                        }
                      }
                    });
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-2"
                >
                  <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
                  <option value="claude-3-5-sonnet-latest">claude-3-5-sonnet-latest</option>
                  <option value="claude-3-5-sonnet-20241022">claude-3-5-sonnet-20241022</option>
                  <option value="claude-3-5-haiku-latest">claude-3-5-haiku-latest</option>
                  <option value="claude-3-opus-latest">claude-3-opus-latest</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  <option value="gemini-2.0-flash-001">gemini-2.0-flash-001</option>
                  <option value="gemini-2.0-flash-lite-001">gemini-2.0-flash-lite-001</option>
                  <option value="custom">Custom Model Name...</option>
                </select>
                
                {!["claude-haiku-4-5-20251001", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-latest", "claude-3-opus-latest", "gemini-2.5-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite-001"].includes(config.providers.supervisor.model || "") && (
                  <input
                    type="text"
                    placeholder="Enter custom model name (e.g. gemini-2.0-flash-001)"
                    value={config.providers.supervisor.model || ""}
                    onChange={(e) => setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        supervisor: { ...config.providers.supervisor, model: e.target.value }
                      }
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mt-1"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  DeepSeek / CodeWhale API Key
                </label>
                <input
                  type="password"
                  placeholder="Defaults to process.env.DEEPSEEK_API_KEY"
                  value={config.providers.executor.apiKey}
                  onChange={(e) => setConfig({
                    ...config,
                    providers: {
                      ...config.providers,
                      executor: { ...config.providers.executor, apiKey: e.target.value }
                    }
                  })}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-3"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Executor Model (DeepSeek / CodeWhale)
                </label>
                <select
                  value={["deepseek-coder", "deepseek-chat", "deepseek-reasoner"].includes(config.providers.executor.model || "") ? config.providers.executor.model : "custom"}
                  onChange={(e) => {
                    const val = e.target.value;
                    setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        executor: {
                          ...config.providers.executor,
                          model: val !== "custom" ? val : "deepseek-coder"
                        }
                      }
                    });
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-2"
                >
                  <option value="deepseek-coder">deepseek-coder</option>
                  <option value="deepseek-chat">deepseek-chat</option>
                  <option value="deepseek-reasoner">deepseek-reasoner</option>
                  <option value="custom">Custom Model Name...</option>
                </select>
                
                {!["deepseek-coder", "deepseek-chat", "deepseek-reasoner"].includes(config.providers.executor.model || "") && (
                  <input
                    type="text"
                    placeholder="Enter custom DeepSeek model name"
                    value={config.providers.executor.model || ""}
                    onChange={(e) => setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        executor: { ...config.providers.executor, model: e.target.value }
                      }
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mt-1"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  pi.dev API Key (Harness)
                </label>
                <input
                  type="password"
                  placeholder="Defaults to process.env.PI_API_KEY"
                  value={config.providers.harness.apiKey}
                  onChange={(e) => setConfig({
                    ...config,
                    providers: {
                      ...config.providers,
                      harness: { ...config.providers.harness, apiKey: e.target.value }
                    }
                  })}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-3"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Harness Model (pi.dev / Pi)
                </label>
                <select
                  value={["pi-default-model", "pi-large-model"].includes(config.providers.harness.model || "") ? config.providers.harness.model : "custom"}
                  onChange={(e) => {
                    const val = e.target.value;
                    setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        harness: {
                          ...config.providers.harness,
                          model: val !== "custom" ? val : "pi-default-model"
                        }
                      }
                    });
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mb-2"
                >
                  <option value="pi-default-model">pi-default-model</option>
                  <option value="pi-large-model">pi-large-model</option>
                  <option value="custom">Custom Model Name...</option>
                </select>
                
                {!["pi-default-model", "pi-large-model"].includes(config.providers.harness.model || "") && (
                  <input
                    type="text"
                    placeholder="Enter custom Pi model name"
                    value={config.providers.harness.model || ""}
                    onChange={(e) => setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        harness: { ...config.providers.harness, model: e.target.value }
                      }
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition mt-1"
                  />
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Pi Harness Subagents Extension
                </label>
                <select
                  value={config.providers.harness.subagentsExtension}
                  onChange={(e) => setConfig({
                    ...config,
                    providers: {
                      ...config.providers,
                      harness: { ...config.providers.harness, subagentsExtension: e.target.value as any }
                    }
                  })}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition"
                >
                  <option value="@gotgenes/pi-subagents">@gotgenes/pi-subagents</option>
                  <option value="@tintinweb/pi-subagents">@tintinweb/pi-subagents</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    Max Concurrent Modules
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={config.providers.executor.maxConcurrent}
                    onChange={(e) => setConfig({
                      ...config,
                      providers: {
                        ...config.providers,
                        executor: { ...config.providers.executor, maxConcurrent: parseInt(e.target.value) || 8 }
                      }
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    USD Budget Limit
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={config.budgets.usd}
                    onChange={(e) => setConfig({
                      ...config,
                      budgets: { ...config.budgets, usd: parseFloat(e.target.value) || 100 }
                    })}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition"
                  />
                </div>
              </div>

              {/* Permission Modes section */}
              <div className="border-t border-slate-700 pt-4">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                  Permission Modes
                </label>
                <p className="text-[11px] text-slate-500 mb-3">
                  Controls what the claude subprocess is allowed to do without asking.
                  When NOT set to <code className="font-mono text-[10px]">bypassPermissions</code>, the
                  <strong className="text-slate-300"> Live Logs</strong> input box lets you approve
                  or deny each prompt in real time.
                </p>

                {/* Planner + Reviewer share the same mode */}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Planner / Reviewer
                    </label>
                    <select
                      value={config.providers.planner.permissionMode ?? "bypassPermissions"}
                      onChange={(e) => setConfig({
                        ...config,
                        providers: {
                          ...config.providers,
                          planner: { ...config.providers.planner, permissionMode: e.target.value },
                          reviewer: { ...config.providers.reviewer, permissionMode: e.target.value },
                        },
                      })}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 transition"
                    >
                      <option value="bypassPermissions">bypassPermissions — fully autonomous</option>
                      <option value="acceptEdits">acceptEdits — approve file edits</option>
                      <option value="default">default — approve all writes</option>
                      <option value="plan">plan — read-only (no writes)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Executor / Builder
                    </label>
                    <select
                      value={config.providers.executor.permissionMode ?? "acceptEdits"}
                      onChange={(e) => setConfig({
                        ...config,
                        providers: {
                          ...config.providers,
                          executor: { ...config.providers.executor, permissionMode: e.target.value },
                        },
                      })}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 transition"
                    >
                      <option value="bypassPermissions">bypassPermissions — fully autonomous</option>
                      <option value="acceptEdits">acceptEdits — approve file edits</option>
                      <option value="default">default — approve all writes</option>
                      <option value="plan">plan — read-only (no writes)</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Skills section */}
              <div className="border-t border-slate-700 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    Claude Code Skills
                  </label>
                  <button
                    onClick={fetchSkills}
                    disabled={skillsLoading}
                    className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-0.5"
                  >
                    <RefreshCw className={`w-3 h-3 ${skillsLoading ? "animate-spin" : ""}`} /> Refresh
                  </button>
                </div>

                {/* gstack status */}
                {skillsData ? (
                  <div className="bg-slate-950 rounded border border-slate-800 p-3 mb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${skillsData.gstack.installed ? "bg-emerald-400" : "bg-red-400"}`} />
                        <span className="text-xs text-slate-300 font-semibold">gstack</span>
                        {skillsData.gstack.version && (
                          <span className="text-[10px] text-slate-500">v{skillsData.gstack.version}</span>
                        )}
                      </div>
                      {skillsData.gstack.installed ? (
                        <button
                          onClick={() => runSkillsAction("upgrade-gstack")}
                          disabled={!!skillsAction}
                          className="text-[10px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 flex items-center gap-1"
                        >
                          {skillsAction === "upgrade-gstack" ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : null}
                          Upgrade
                        </button>
                      ) : (
                        <button
                          onClick={() => runSkillsAction("install-gstack")}
                          disabled={!!skillsAction}
                          className="text-[10px] px-2 py-0.5 rounded bg-violet-700 hover:bg-violet-600 text-white flex items-center gap-1"
                        >
                          {skillsAction === "install-gstack" ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : null}
                          Install
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1">
                      {skillsData.gstack.installed
                        ? `${skillsData.skills.length} skills loaded from ~/.claude/skills/`
                        : "Not installed — plan-ceo-review, QA, design-review and other skills unavailable"}
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500 mb-3">Loading skills…</p>
                )}

                {/* Installed skills list */}
                {skillsData && skillsData.skills.length > 0 && (
                  <details className="mb-3">
                    <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-200 mb-1">
                      Show all {skillsData.skills.length} installed skills
                    </summary>
                    <div className="mt-2 max-h-32 overflow-y-auto bg-slate-950 rounded border border-slate-800 p-2 grid grid-cols-2 gap-x-2 gap-y-0.5">
                      {skillsData.skills.map((s: any) => (
                        <div key={s.name} className="flex items-center gap-1 text-[10px] text-slate-400">
                          <span className="text-emerald-500">✓</span>
                          <span className="font-mono">{s.name}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Custom plugin dirs */}
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Extra skill dirs for subagents (one per line, passed via <code className="font-mono text-[10px]">--plugin-dir</code>)
                  </label>
                  <textarea
                    rows={2}
                    value={(config.skills?.pluginDirs ?? []).join("\n")}
                    onChange={(e) => setConfig({
                      ...config,
                      skills: { ...(config.skills ?? {}), pluginDirs: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) },
                    })}
                    placeholder="/path/to/my-skill"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-blue-500 transition resize-none"
                  />
                </div>
              </div>

            {/* Test Results */}
            {isTesting && (
              <div className="bg-slate-950/50 rounded-lg border border-slate-800 p-4 mt-4 text-center">
                <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500 mb-2"></div>
                <p className="text-xs text-blue-400 font-medium">Running configuration test & binary verification...</p>
              </div>
            )}

            {testResults && (
              <div className="bg-slate-950 rounded-lg border border-slate-800 p-4 mt-4 space-y-3">
                <h3 className="text-sm font-semibold text-white border-b border-slate-800 pb-1 flex items-center justify-between">
                  <span>Test Results</span>
                  <button 
                    onClick={() => setTestResults(null)} 
                    className="text-xs text-slate-500 hover:text-slate-300"
                  >
                    Clear
                  </button>
                </h3>
                {testResults.error ? (
                  <p className="text-xs text-red-400">{testResults.error}</p>
                ) : (
                  <div className="space-y-2 text-xs">
                    {/* Binaries */}
                    <div className="space-y-1">
                      <div className="font-semibold text-slate-400 mb-1">Binaries & Executables:</div>
                      <div className="flex items-center justify-between">
                        <span>Claude Code CLI:</span>
                        <span className={testResults.binaries.claude.status === "passed" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                          {testResults.binaries.claude.status === "passed" ? "✓ Ready" : "✗ Missing"}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 mb-2">{testResults.binaries.claude.message}</p>

                      <div className="flex items-center justify-between">
                        <span>CodeWhale Swarm CLI:</span>
                        <span className={testResults.binaries.codewhale.status === "passed" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                          {testResults.binaries.codewhale.status === "passed" ? "✓ Ready" : "✗ Missing"}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 mb-2">{testResults.binaries.codewhale.message}</p>

                      <div className="flex items-center justify-between">
                        <span>open-code-review CLI:</span>
                        <span className={testResults.binaries.ocr?.status === "passed" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                          {testResults.binaries.ocr?.status === "passed" ? "✓ Ready" : "✗ Missing"}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500">{testResults.binaries.ocr?.message}</p>
                    </div>

                    {/* API Keys */}
                    <div className="space-y-2 border-t border-slate-800 pt-2">
                      <div className="font-semibold text-slate-400 mb-1">API Key Configurations:</div>
                      
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span>Gemini Key (Deep Research & Copilot):</span>
                          <span className={testResults.keys.gemini.status === "passed" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                            {testResults.keys.gemini.status === "passed" ? "✓ Ready" : "✗ Error"}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mb-2">{testResults.keys.gemini.message}</p>

                        <div className="flex items-center justify-between">
                          <span>Claude Key (Orchestration):</span>
                          <span className={testResults.keys.anthropic.status === "passed" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                            {testResults.keys.anthropic.status === "passed" ? "✓ Ready" : "✗ Error"}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mb-2">{testResults.keys.anthropic.message}</p>

                        <div className="flex items-center justify-between">
                          <span>DeepSeek Key (Execution):</span>
                          <span className={testResults.keys.deepseek.status === "passed" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                            {testResults.keys.deepseek.status === "passed" ? "✓ Ready" : "✗ Error"}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 mb-2">{testResults.keys.deepseek.message}</p>

                        <div className="flex items-center justify-between">
                          <span>Pi Harness Key:</span>
                          <span className={testResults.keys.pi.status === "passed" ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                            {testResults.keys.pi.status === "passed" ? "✓ Ready" : "✗ Error"}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500">{testResults.keys.pi.message}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-slate-700 p-6 pt-4 flex-shrink-0 bg-slate-900 rounded-b-xl">
              <button
                disabled={isTesting}
                onClick={() => runConfigTest(config)}
                className="px-4 py-2 rounded border border-slate-700 hover:border-slate-500 text-slate-200 hover:text-white font-medium transition mr-auto"
              >
                {isTesting ? "Testing..." : "Test Connection"}
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => saveConfig(config)}
                className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white font-semibold transition"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="bg-slate-950 border-t border-slate-700 p-4">
        <p className="text-xs text-slate-500 max-w-7xl mx-auto">
          DLO v0.1.0 · Double-Loop Orchestrator for autonomous development · 🚀
        </p>
      </div>
    </div>
  );
}

/**
 * Page component with CopilotKit wrapping.
 */
export default function ChatPage() {
  const [headers, setHeaders] = useState<Record<string, string>>({});

  const updateHeaders = () => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("dlo-config");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setHeaders({
            "x-gemini-key": parsed?.providers?.research?.apiKey || "",
            "x-anthropic-key": parsed?.providers?.planner?.apiKey || "",
            "x-deepseek-key": parsed?.providers?.executor?.apiKey || "",
            "x-pi-key": parsed?.providers?.harness?.apiKey || "",
            "x-copilot-model": parsed?.copilotModel || "gemini-1.5-pro",
          });
          return;
        } catch (e) {
          console.error("Failed to parse stored config for headers:", e);
        }
      }
    }
    setHeaders({});
  };

  useEffect(() => {
    updateHeaders();
    window.addEventListener("storage", updateHeaders);
    return () => window.removeEventListener("storage", updateHeaders);
  }, []);

  // Only mount CopilotKit when a Gemini key is present.
  // Without this guard, CopilotKit fires a request to /api/copilotkit on mount (even
  // with no CopilotChat / actions rendered), which returns 500 and shows
  // "Failed to fetch chat completion" when the key isn't configured.
  // DloChat is safe to render outside CopilotKit because all copilotkit hooks live
  // in <CopilotActions>, which itself is only rendered when config.providers.research.apiKey
  // is set — guaranteed to be empty when headers["x-gemini-key"] is empty.
  if (!headers["x-gemini-key"]) {
    return <DloChat onConfigSave={updateHeaders} copilotKitReady={false} />;
  }

  return (
    <CopilotKit runtimeUrl="/api/copilotkit" headers={headers}>
      <DloChat onConfigSave={updateHeaders} copilotKitReady={true} />
    </CopilotKit>
  );
}
