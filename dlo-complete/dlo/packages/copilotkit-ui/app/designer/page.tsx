"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Zap, Save, CheckCircle, AlertCircle, RefreshCw, GitBranch } from "lucide-react";
import { AgentDesignerCanvas, DEFAULT_MODELS } from "@/components/AgentDesignerCanvas";
import type { EngineeringModule } from "@/components/AgentDesignerCanvas";
import type { Vendor } from "@/components/ModuleNode";

type AgentConfig = Record<string, { vendor: Vendor; model: string }>;

const VENDOR_LABELS: Record<Vendor, string> = {
  "codewhale": "CodeWhale (DeepSeek)",
  "claude-code": "Claude Code",
  "pi": "Pi Harness",
};

export default function DesignerPage() {
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [modules, setModules] = useState<EngineeringModule[] | null>(null);
  const [agentConfig, setAgentConfig] = useState<AgentConfig>({});
  const [defaultVendor, setDefaultVendor] = useState<Vendor>("codewhale");
  const [savedConfig, setSavedConfig] = useState<AgentConfig>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Load pipeline ID from URL or localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("pipeline") || localStorage.getItem("dlo-active-pipeline");
    setPipelineId(id);
  }, []);

  // Fetch pipeline plan when we have an ID
  useEffect(() => {
    if (!pipelineId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    fetch(`/api/pipelines/${pipelineId}`)
      .then(r => {
        if (!r.ok) throw new Error(`Pipeline not found (${r.status})`);
        return r.json();
      })
      .then(data => {
        const ep = data?.plan?.engineeringPlan as { modules?: EngineeringModule[] } | undefined;
        if (!ep?.modules?.length) {
          throw new Error("No engineering plan available yet. Run the pipeline through Gate 2 first.");
        }
        setModules(ep.modules);

        // Load saved agent config for this pipeline
        const stored = localStorage.getItem(`dlo-agent-design-${pipelineId}`);
        if (stored) {
          const parsed = JSON.parse(stored) as { modules: AgentConfig };
          setSavedConfig(parsed.modules ?? {});
          setAgentConfig(parsed.modules ?? {});
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [pipelineId]);

  const handleConfigChange = useCallback((config: AgentConfig) => {
    setAgentConfig(config);
  }, []);

  const applyDefaultVendor = useCallback(() => {
    if (!modules) return;
    const next: AgentConfig = {};
    for (const m of modules) {
      next[m.moduleId] = { vendor: defaultVendor, model: DEFAULT_MODELS[defaultVendor] };
    }
    setSavedConfig(next);
    setAgentConfig(next);
  }, [modules, defaultVendor]);

  const handleSave = useCallback(async () => {
    if (!pipelineId || !modules) return;
    setSaveStatus("saving");
    try {
      // Persist to localStorage
      const payload = { pipelineId, modules: agentConfig, updatedAt: new Date().toISOString() };
      localStorage.setItem(`dlo-agent-design-${pipelineId}`, JSON.stringify(payload));

      // Post as a context note to the pipeline so kernel can read it
      const note = `[AgentDesign] ${JSON.stringify({ modules: agentConfig })}`;
      await fetch(`/api/pipelines/${pipelineId}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });

      setSavedConfig({ ...agentConfig });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 4000);
    }
  }, [pipelineId, modules, agentConfig]);

  const isDirty = JSON.stringify(agentConfig) !== JSON.stringify(savedConfig);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-white">
      {/* Header */}
      <div className="bg-slate-900 border-b border-slate-700 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href={pipelineId ? `/chat?pipeline=${pipelineId}` : "/chat"}
            className="flex items-center gap-1.5 text-slate-400 hover:text-white transition text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Chat
          </Link>
          <div className="w-px h-5 bg-slate-700" />
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-blue-400" />
            Agent Designer
          </h1>
          {pipelineId && (
            <span className="text-xs text-slate-500 font-mono hidden md:block">{pipelineId}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {modules && (
            <span className="text-xs text-slate-400">{modules.length} module{modules.length !== 1 ? "s" : ""}</span>
          )}
          <button
            onClick={handleSave}
            disabled={saveStatus === "saving" || !modules || !pipelineId}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-semibold transition ${
              saveStatus === "saved"
                ? "bg-green-700 text-white"
                : saveStatus === "error"
                ? "bg-red-700 text-white"
                : isDirty
                ? "bg-blue-600 hover:bg-blue-500 text-white"
                : "bg-slate-700 text-slate-400"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {saveStatus === "saving" ? (
              <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Saving…</>
            ) : saveStatus === "saved" ? (
              <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
            ) : saveStatus === "error" ? (
              <><AlertCircle className="w-3.5 h-3.5" /> Error</>
            ) : (
              <><Save className="w-3.5 h-3.5" /> Apply to Pipeline</>
            )}
          </button>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-56 bg-slate-900 border-r border-slate-700 flex flex-col flex-shrink-0 p-4 gap-4 overflow-y-auto">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Pipeline</p>
            <p className="text-xs font-mono text-slate-400 break-all">{pipelineId ?? "—"}</p>
          </div>

          <div className="border-t border-slate-700/60 pt-3">
            <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Global Default</p>
            <p className="text-xs text-slate-400 mb-2">Apply one agent to all modules</p>
            <select
              value={defaultVendor}
              onChange={e => setDefaultVendor(e.target.value as Vendor)}
              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 transition mb-2"
            >
              {(Object.keys(VENDOR_LABELS) as Vendor[]).map(v => (
                <option key={v} value={v}>{VENDOR_LABELS[v]}</option>
              ))}
            </select>
            <button
              onClick={applyDefaultVendor}
              disabled={!modules}
              className="w-full py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-xs text-slate-200 rounded transition"
            >
              Apply to All
            </button>
          </div>

          <div className="border-t border-slate-700/60 pt-3">
            <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Legend</p>
            <div className="space-y-1 text-[10px]">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0" />
                <span className="text-slate-400">Source (output)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-slate-500 flex-shrink-0" />
                <span className="text-slate-400">Target (input)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-px bg-blue-500 flex-shrink-0" />
                <span className="text-slate-400">Dependency edge</span>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-700/60 pt-3 mt-auto">
            <p className="text-[10px] text-slate-600 leading-relaxed">
              Drag to reposition nodes. Use scroll to zoom. Each node's agent assignment is saved when you click "Apply to Pipeline".
            </p>
          </div>
        </div>

        {/* Canvas area */}
        <div className="flex-1 relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950">
              <div className="flex flex-col items-center gap-3">
                <RefreshCw className="w-8 h-8 text-blue-400 animate-spin" />
                <p className="text-slate-400 text-sm">Loading engineering plan…</p>
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950 p-8">
              <div className="max-w-md text-center">
                <AlertCircle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
                <p className="text-white font-semibold mb-2">Plan Not Available</p>
                <p className="text-slate-400 text-sm mb-6">{error}</p>
                <Link
                  href={pipelineId ? `/chat?pipeline=${pipelineId}` : "/chat"}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Go to Pipeline Chat
                </Link>
              </div>
            </div>
          )}

          {!loading && !error && !pipelineId && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950 p-8">
              <div className="max-w-md text-center">
                <Zap className="w-12 h-12 text-blue-400 mx-auto mb-4" />
                <p className="text-white font-semibold mb-2">No Pipeline Selected</p>
                <p className="text-slate-400 text-sm mb-6">
                  Initialize a pipeline from the chat, then return here to design your agent graph.
                </p>
                <Link
                  href="/chat"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition"
                >
                  Go to Chat
                </Link>
              </div>
            </div>
          )}

          {!loading && !error && modules && (
            <AgentDesignerCanvas
              modules={modules}
              savedConfig={savedConfig}
              onConfigChange={handleConfigChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
