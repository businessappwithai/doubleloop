/**
 * packages/copilotkit-ui/app/chat/page.tsx
 * Main chat interface using CopilotKit with dynamic agent configuration settings.
 */

"use client";

import { useEffect, useState } from "react";
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
import { Activity, AlertCircle, CheckCircle, Clock, Zap, Settings, X } from "lucide-react";

/**
 * Inner component that uses the DLO store and CopilotKit hooks.
 * Wrapped by CopilotKit in the page component below.
 */
function DloChat({ onConfigSave }: { onConfigSave?: () => void }) {
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
  const [config, setConfig] = useState({
    copilotModel: "gemini-1.5-pro",
    providers: {
      research: { apiKey: "", vendor: "gemini-deep-research" as const, model: "deep-research-preview-04-2026" as string },
      planner: { apiKey: "", vendor: "claude-code" as const, model: "claude-haiku-4-5-20251001" as string },
      supervisor: { apiKey: "", vendor: "claude-code" as const, model: "claude-haiku-4-5-20251001" as string },
      executor: { apiKey: "", vendor: "codewhale" as const, model: "deepseek-coder" as string, maxConcurrent: 8 },
      harness: { apiKey: "", vendor: "pi" as const, model: "pi-default-model" as string, sdkPackage: "@earendil-works/pi-coding-agent" as const, subagentsExtension: "@gotgenes/pi-subagents" as const }
    },
    budgets: { usd: 100, tokens: 10000000, wallClockMs: 3600000 }
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

  // Resume pipeline from ?pipeline=<id> URL param
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("pipeline");
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
            supervisor: { ...prev.providers.supervisor, ...(parsed.providers?.supervisor || {}) },
            executor: { ...prev.providers.executor, ...(parsed.providers?.executor || {}) },
            harness: { ...prev.providers.harness, ...(parsed.providers?.harness || {}) },
          };
          merged.budgets = { ...prev.budgets, ...(parsed.budgets || {}) };
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

  // 1. Initialize Pipeline Action
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

  // 2. Get Pipeline Status Action
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

  // 3. Resolve Gate Action
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

  // 4. Get Domain Document Action
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

  // 5. Get Plan Action
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
      return {
        plan: (status.plan as any)[key],
      };
    },
  });

  // Make pipeline status readable to the copilot
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
      workspaceDir: "/tmp/dlo-workspace",
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

  const handleGateResolve = async () => {
    const gate = store.pipelineStatus?.activeGate;
    if (!gate || !gateDecision) return;
    setGateSubmitting(true);
    try {
      await store.resolveGate(gate.gateId as any, gateDecision, {
        instructions: gateDecision === "STEER" ? gateInstructions : undefined,
        reason: gateDecision === "REJECT" ? gateReason : undefined,
      });
      setGateDecision(null);
      setGateInstructions("");
      setGateReason("");
      setGateExhibitTab(0);
    } finally {
      setGateSubmitting(false);
    }
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
          {/* Chat — only mount when a Gemini key is configured (prevents "Failed to fetch chat completion") */}
          {config.providers.research.apiKey && (
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
            <div className="bg-slate-800 rounded-lg border border-slate-700 p-4 overflow-y-auto">
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

                  {/* Phase indicator */}
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Phase</p>
                    <div className={`bg-slate-900 rounded px-3 py-2 border-l-4 ${store.pipelineStatus.phase === "FAILED" ? "border-red-500" : "border-blue-500"}`}>
                      <p className={`text-sm font-semibold ${store.pipelineStatus.phase === "FAILED" ? "text-red-400" : "text-blue-300"}`}>
                        {store.pipelineStatus.phase}
                      </p>
                      {store.pipelineStatus.phase === "FAILED" && (store.pipelineStatus as any).error && (
                        <p className="text-xs text-red-200 mt-1 break-words font-mono">
                          {(store.pipelineStatus as any).error}
                        </p>
                      )}
                    </div>
                  </div>

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
                                  {format(new Date(entry.timestamp), "HH:mm:ss")}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Gate review */}
                  {store.pipelineStatus.activeGate && (
                    <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 overflow-hidden">
                      {/* Header */}
                      <div className="bg-amber-900/40 border-b border-amber-700/60 px-3 py-2 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-300 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-amber-200">
                            {store.pipelineStatus.activeGate.kind === "DOMAIN_DOCUMENT"
                              ? "Review: Domain Document"
                              : "Review: Tripartite Plan"}
                          </p>
                          <p className="text-xs text-amber-300/70">Approve to proceed · Steer to revise · Reject to fail</p>
                        </div>
                      </div>

                      {/* Exhibit tabs (TRIPARTITE_PLAN only) */}
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

                      {/* Exhibit content */}
                      <div className="max-h-48 overflow-y-auto p-3">
                        <pre className="text-xs text-slate-200 whitespace-pre-wrap font-mono leading-relaxed">
                          {String((store.pipelineStatus.activeGate.exhibits as any[])[gateExhibitTab] ?? "")}
                        </pre>
                      </div>

                      {/* STEER instructions textarea */}
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

                      {/* REJECT reason textarea */}
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

                      {/* Action buttons */}
                      <div className="px-3 pb-3 flex gap-2">
                        {gateDecision ? (
                          <>
                            <button
                              onClick={handleGateResolve}
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
                  {store.pipelineStatus.board && (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Modules</p>
                      <div className="space-y-1.5">
                        {store.pipelineStatus.board.modules.slice(0, 5).map((mod) => {
                          const planMod = (store.pipelineStatus as any).plan?.engineeringPlan?.modules?.find(
                            (m: any) => m.moduleId === mod.moduleId
                          );
                          return (
                            <div
                              key={mod.moduleId}
                              className="bg-slate-900 rounded px-2 py-1.5 border border-slate-700/50"
                            >
                              <div className="flex items-center gap-2 text-xs">
                                {mod.status === "PASSED" ? (
                                  <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                                ) : mod.status === "EXECUTING" ? (
                                  <Activity className="w-4 h-4 text-blue-400 flex-shrink-0 animate-spin" />
                                ) : mod.status === "REJECTED" ? (
                                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                                ) : (
                                  <Clock className="w-4 h-4 text-slate-400 flex-shrink-0" />
                                )}
                                <span className="text-slate-200 font-medium truncate">
                                  {planMod?.title || mod.moduleId}
                                </span>
                                <span className="text-slate-500 ml-auto flex-shrink-0">×{mod.attempts}</span>
                              </div>
                              {planMod?.touches?.length > 0 && (
                                <div className="mt-1 ml-6 text-xs text-slate-500 truncate">
                                  {(planMod.touches as string[]).slice(0, 2).join(" · ")}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {(store.pipelineStatus.board.modules.length || 0) > 5 && (
                          <p className="text-xs text-slate-500 px-2 py-1">
                            +{store.pipelineStatus.board.modules.length - 5} more
                          </p>
                        )}
                      </div>
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

                  {/* Context notes — visible and editable during running phases */}
                  {["PLANNING_RUNNING", "EXECUTION_RUNNING"].includes(store.pipelineStatus.phase) && (
                    <div>
                      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Context Notes</p>
                      <div className="bg-slate-900 rounded border border-blue-700/40 p-2 space-y-2">
                        <p className="text-xs text-slate-500">
                          Add context, constraints, or corrections the agent should consider.
                        </p>
                        <textarea
                          value={contextNote}
                          onChange={(e) => setContextNote(e.target.value)}
                          placeholder="e.g. 'Use React Query v5 hooks syntax' or 'Add dark mode support'…"
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
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 shadow-2xl transition">
            <div className="flex items-center justify-between border-b border-slate-700 pb-4 mb-4">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-blue-400" />
                Configure Keys & Limits
              </h2>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-white transition">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="space-y-4 text-sm text-slate-300">
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
                  Anthropic API Key (Claude Code)
                </label>
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

            <div className="flex items-center justify-end gap-3 border-t border-slate-700 pt-4 mt-6">
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

  return (
    <CopilotKit runtimeUrl="/api/copilotkit" headers={headers}>
      <DloChat onConfigSave={updateHeaders} />
    </CopilotKit>
  );
}
