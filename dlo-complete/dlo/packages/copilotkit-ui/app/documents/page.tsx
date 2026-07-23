"use client";

/**
 * /documents — read the pipeline's documents (Research, Architecture,
 * Database, Implementation), edit them, and work through the
 * /plan-ceo-review enhancements: apply, edit, or dismiss each suggestion,
 * approve each document, then approve all to start the build fleet.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowLeft, FileText, CheckCircle, AlertCircle, RefreshCw, Pencil,
  Save, X, Sparkles, ThumbsUp, Ban, ExternalLink, GitBranch, Play,
} from "lucide-react";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type DocKey = "research" | "architecture" | "database" | "implementation";

interface DocListEntry {
  key: DocKey;
  filename: string;
  exists: boolean;
  version: number;
  updatedAt: string | null;
  approvedAt: string | null;
  review: {
    reviewer: string;
    reviewedAt: string;
    openSuggestions: number;
    totalSuggestions: number;
  } | null;
}

interface Suggestion {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  rationale: string;
  proposedChange: string;
  status: "open" | "applied" | "dismissed";
}

interface DocDetail {
  key: DocKey;
  filename: string;
  markdown: string;
  version: number;
  approvedAt: string | null;
  review: {
    reviewer: string;
    rawMarkdown: string;
    suggestions: Suggestion[];
    reviewedAt: string;
  } | null;
}

const DOC_LABELS: Record<DocKey, string> = {
  research: "Research",
  architecture: "Architecture",
  database: "Database",
  implementation: "Implementation",
};

const SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-900/60 text-red-200 border-red-700",
  medium: "bg-amber-900/60 text-amber-200 border-amber-700",
  low: "bg-slate-800 text-slate-300 border-slate-600",
};

export default function DocumentsPage() {
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocListEntry[]>([]);
  const [phase, setPhase] = useState<string>("");
  const [activeKey, setActiveKey] = useState<DocKey>("architecture");
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gate, setGate] = useState<{ gateId: string; kind: string } | null>(null);
  const [steerText, setSteerText] = useState("");
  const [langflowFlowId, setLangflowFlowId] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("pipeline") || localStorage.getItem("dlo-active-pipeline");
    setPipelineId(id);
  }, []);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  };

  const refreshList = useCallback(async () => {
    if (!pipelineId) return;
    try {
      const [docsRes, pipeRes] = await Promise.all([
        fetch(`/api/pipelines/${pipelineId}/documents`),
        fetch(`/api/pipelines/${pipelineId}`),
      ]);
      if (docsRes.ok) {
        const data = await docsRes.json();
        setDocs(data.documents || []);
        setPhase(data.phase || "");
      }
      if (pipeRes.ok) {
        const p = await pipeRes.json();
        setGate(p?.activeGate ? { gateId: p.activeGate.gateId, kind: p.activeGate.kind } : null);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [pipelineId]);

  const loadDoc = useCallback(async (key: DocKey) => {
    if (!pipelineId) return;
    setDetail(null);
    setEditing(false);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/documents/${key}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setDetail({ key, filename: "", markdown: "", version: 0, approvedAt: null, review: null });
        setError(err.error || `Failed to load ${key}`);
        return;
      }
      setError(null);
      const data = await res.json();
      setDetail(data);
      setDraft(data.markdown);
    } catch (e: any) {
      setError(e.message);
    }
  }, [pipelineId]);

  useEffect(() => { void refreshList(); }, [refreshList]);
  useEffect(() => { void loadDoc(activeKey); }, [activeKey, loadDoc]);

  const saveDraft = async () => {
    if (!pipelineId || !detail) return;
    setBusy("save");
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/documents/${detail.key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: draft }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Save failed");
      setEditing(false);
      flash(`${DOC_LABELS[detail.key]} saved (new version)`);
      await Promise.all([loadDoc(detail.key), refreshList()]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const setSuggestionStatus = async (s: Suggestion, status: Suggestion["status"]) => {
    if (!pipelineId || !detail) return;
    setBusy(s.id);
    try {
      await fetch(`/api/pipelines/${pipelineId}/documents/${detail.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId: s.id, status }),
      });
      await loadDoc(detail.key);
      await refreshList();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  /** Apply = append the enhancement into the document (editable afterwards) + mark applied. */
  const applySuggestion = async (s: Suggestion) => {
    if (!pipelineId || !detail) return;
    setBusy(s.id);
    try {
      const marker = "\n\n## Enhancements (applied from CEO review)\n";
      let next = detail.markdown;
      if (!next.includes(marker.trim())) next += marker;
      next += `\n### ${s.title} [${s.severity}]\n\n${s.proposedChange}\n`;
      const res = await fetch(`/api/pipelines/${pipelineId}/documents/${detail.key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Apply failed");
      await setSuggestionStatus(s, "applied");
      flash(`Applied: ${s.title} — edit the document to refine it`);
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  };

  const rerunReview = async () => {
    if (!pipelineId || !detail || detail.key === "research") return;
    setBusy("review");
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/documents/${detail.key}/review`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error || "Review failed");
      flash("Review re-run complete");
      await Promise.all([loadDoc(detail.key), refreshList()]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const approveDoc = async () => {
    if (!pipelineId || !detail || detail.key === "research") return;
    setBusy("approve");
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/documents/${detail.key}/approve`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error || "Approve failed");
      flash(`${DOC_LABELS[detail.key]} approved`);
      await Promise.all([loadDoc(detail.key), refreshList()]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const resolveGate = async (decision: "APPROVE" | "STEER" | "REJECT", instructions?: string) => {
    if (!gate) return;
    setBusy("gate");
    try {
      const res = await fetch(`/api/gates/${gate.gateId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(instructions ? { instructions } : {}) }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Gate resolution failed");
      flash(
        decision === "APPROVE"
          ? gate.kind === "DOMAIN_DOCUMENT" ? "Research approved — Design Analyst running" : "Design approved — build fleet starting"
          : decision === "STEER" ? "Sent back with your instructions" : "Rejected"
      );
      setSteerText("");
      await refreshList();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const openInLangflow = async () => {
    if (!pipelineId) return;
    setBusy("langflow");
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/langflow/flow`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Langflow push failed");
      setLangflowFlowId(data.flowId);
      window.open(data.editorUrl, "_blank");
      flash(`Flow pushed to Langflow (${data.flowId}) — edit there, then Apply here`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const applyFromLangflow = async () => {
    if (!pipelineId || !langflowFlowId) return;
    setBusy("langflow-apply");
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/langflow/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: langflowFlowId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Apply failed");
      flash(`Langflow agent design applied${data.warnings?.length ? ` (warnings: ${data.warnings.join("; ")})` : ""}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const activeEntry = docs.find((d) => d.key === activeKey);
  const reviewableApproved = useMemo(
    () => docs.filter((d) => d.key !== "research" && d.approvedAt).length,
    [docs]
  );
  const suggestions = detail?.review?.suggestions ?? [];

  if (!pipelineId) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-white">
        <div className="text-center max-w-md">
          <FileText className="w-12 h-12 text-blue-400 mx-auto mb-4" />
          <p className="font-semibold mb-2">No Pipeline Selected</p>
          <p className="text-slate-400 text-sm mb-6">Initialize a pipeline from the chat, then return here to review its documents.</p>
          <Link href="/chat" className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Go to Chat</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-white">
      {/* Header */}
      <div className="bg-slate-900 border-b border-slate-700 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link href={`/chat?pipeline=${pipelineId}`} className="flex items-center gap-1.5 text-slate-400 hover:text-white transition text-sm">
            <ArrowLeft className="w-4 h-4" /> Back to Chat
          </Link>
          <div className="w-px h-5 bg-slate-700" />
          <h1 className="text-lg font-bold flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-400" /> Documents
          </h1>
          <span className="text-xs text-slate-500 font-mono hidden md:block">{pipelineId}</span>
          {phase && <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{phase}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openInLangflow}
            disabled={busy === "langflow"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-slate-800 hover:bg-slate-700 border border-slate-600 disabled:opacity-50"
            title="Push this pipeline's subagent graph to Langflow for configuration"
          >
            <GitBranch className="w-3.5 h-3.5" /> Open in Langflow
          </button>
          {langflowFlowId && (
            <button
              onClick={applyFromLangflow}
              disabled={busy === "langflow-apply"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-purple-700 hover:bg-purple-600 disabled:opacity-50"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Apply Langflow Config
            </button>
          )}
          <Link href={`/designer?pipeline=${pipelineId}`} className="text-xs text-slate-400 hover:text-white px-2">Designer canvas</Link>
        </div>
      </div>

      {/* Notices */}
      {(notice || error) && (
        <div className={`px-4 py-2 text-sm flex-shrink-0 ${error ? "bg-red-900/40 text-red-200" : "bg-emerald-900/40 text-emerald-200"}`}>
          {error || notice}
          {error && <button className="ml-3 underline" onClick={() => setError(null)}>dismiss</button>}
        </div>
      )}

      {/* Gate action bar */}
      {gate?.kind === "DOMAIN_DOCUMENT" && (
        <div className="bg-blue-950/60 border-b border-blue-800 px-4 py-3 flex flex-wrap items-center gap-3 flex-shrink-0">
          <span className="text-sm text-blue-200 font-semibold">Gate 1 — Research approval:</span>
          <button onClick={() => resolveGate("APPROVE")} disabled={busy === "gate"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50">
            <ThumbsUp className="w-3.5 h-3.5" /> Approve Research
          </button>
          <input
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            placeholder="Additional research inputs…"
            className="flex-1 min-w-48 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs"
          />
          <button onClick={() => resolveGate("STEER", steerText)} disabled={busy === "gate" || !steerText.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-amber-700 hover:bg-amber-600 disabled:opacity-50">
            <RefreshCw className="w-3.5 h-3.5" /> Research Further
          </button>
          <span className="text-[11px] text-blue-300">Tip: use Edit below to modify the research document before approving.</span>
        </div>
      )}
      {gate?.kind === "DESIGN_REVIEW" && (
        <div className="bg-purple-950/60 border-b border-purple-800 px-4 py-3 flex flex-wrap items-center gap-3 flex-shrink-0">
          <span className="text-sm text-purple-200 font-semibold">Gate 2 — Design approval ({reviewableApproved}/3 documents approved):</span>
          <button onClick={() => resolveGate("APPROVE")} disabled={busy === "gate"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
            title="Approves all three documents and starts the build fleet">
            <Play className="w-3.5 h-3.5" /> Approve All &amp; Start Build
          </button>
          <input
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            placeholder="Design steering instructions…"
            className="flex-1 min-w-48 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs"
          />
          <button onClick={() => resolveGate("STEER", steerText)} disabled={busy === "gate" || !steerText.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-amber-700 hover:bg-amber-600 disabled:opacity-50">
            <RefreshCw className="w-3.5 h-3.5" /> Redesign
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left rail: document tabs */}
        <div className="w-60 bg-slate-900 border-r border-slate-700 flex flex-col flex-shrink-0 p-3 gap-1.5 overflow-y-auto">
          {(["research", "architecture", "database", "implementation"] as DocKey[]).map((key) => {
            const entry = docs.find((d) => d.key === key);
            const active = key === activeKey;
            return (
              <button
                key={key}
                onClick={() => setActiveKey(key)}
                className={`text-left rounded px-3 py-2.5 border transition ${
                  active ? "bg-slate-800 border-blue-600" : "bg-slate-900 border-slate-700 hover:border-slate-500"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{DOC_LABELS[key]}</span>
                  {entry?.approvedAt ? (
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                  ) : entry?.exists ? (
                    <Pencil className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <span className="text-[10px] text-slate-600">pending</span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{entry?.filename || ""}</div>
                {entry?.review && (
                  <div className="text-[10px] mt-1 text-slate-400">
                    <Sparkles className="w-3 h-3 inline mr-1 text-purple-400" />
                    {entry.review.openSuggestions}/{entry.review.totalSuggestions} suggestions open
                    <span className="block text-slate-600">{entry.review.reviewer}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Main pane: document viewer/editor */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/60 flex-shrink-0">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="font-mono">{detail?.filename}</span>
              {detail && <span>v{detail.version}</span>}
              {activeEntry?.approvedAt && <span className="text-emerald-400">approved</span>}
            </div>
            <div className="flex items-center gap-2">
              {activeKey !== "research" && (
                <>
                  <button onClick={rerunReview} disabled={busy === "review" || !detail?.markdown}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-purple-800 hover:bg-purple-700 disabled:opacity-50">
                    {busy === "review" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    Re-run CEO Review
                  </button>
                  <button onClick={approveDoc} disabled={busy === "approve" || !detail?.markdown || !!activeEntry?.approvedAt}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50">
                    <ThumbsUp className="w-3 h-3" /> Approve Document
                  </button>
                </>
              )}
              {editing ? (
                <>
                  <button onClick={saveDraft} disabled={busy === "save"}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-50">
                    <Save className="w-3 h-3" /> Save
                  </button>
                  <button onClick={() => { setEditing(false); setDraft(detail?.markdown || ""); }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-slate-700 hover:bg-slate-600">
                    <X className="w-3 h-3" /> Cancel
                  </button>
                </>
              ) : (
                <button onClick={() => setEditing(true)} disabled={!detail?.markdown}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-50">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {!detail ? (
              <div className="h-full flex items-center justify-center">
                <RefreshCw className="w-6 h-6 text-blue-400 animate-spin" />
              </div>
            ) : !detail.markdown ? (
              <div className="h-full flex items-center justify-center text-slate-500 text-sm p-8 text-center">
                <div>
                  <AlertCircle className="w-8 h-8 mx-auto mb-3 text-slate-600" />
                  {DOC_LABELS[activeKey]} has not been generated yet.<br />
                  {activeKey === "research" ? "Run the research phase first." : "It is authored by the Design Analyst after Gate 1 approval."}
                </div>
              </div>
            ) : editing ? (
              <MonacoEditor
                height="100%"
                defaultLanguage="markdown"
                theme="vs-dark"
                value={draft}
                onChange={(v: string | undefined) => setDraft(v ?? "")}
                options={{ wordWrap: "on", minimap: { enabled: false }, fontSize: 13 }}
              />
            ) : (
              <div className="h-full overflow-y-auto px-6 py-4">
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-slate-200 max-w-4xl">
                  {detail.markdown}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Right rail: CEO review suggestions */}
        {activeKey !== "research" && (
          <div className="w-96 bg-slate-900 border-l border-slate-700 flex flex-col flex-shrink-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 flex-shrink-0">
              <h2 className="text-sm font-bold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" /> CEO Review
              </h2>
              {detail?.review ? (
                <p className="text-[11px] text-slate-500 mt-1">
                  Reviewer: <span className={detail.review.reviewer === "built-in" ? "text-amber-400" : "text-emerald-400"}>{detail.review.reviewer}</span>
                  {" · "}{new Date(detail.review.reviewedAt).toLocaleString()}
                </p>
              ) : (
                <p className="text-[11px] text-slate-500 mt-1">No review yet — it runs automatically after design, or use "Re-run CEO Review".</p>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {suggestions.length === 0 && detail?.review && (
                <p className="text-xs text-slate-500 px-1">The reviewer returned no structured suggestions. See the raw review below.</p>
              )}
              {suggestions.map((s) => (
                <div key={s.id} className={`rounded border p-3 ${s.status === "open" ? "border-slate-600 bg-slate-800/60" : "border-slate-700/50 bg-slate-900 opacity-60"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold leading-snug">{s.title}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0 ${SEVERITY_COLORS[s.severity]}`}>{s.severity}</span>
                  </div>
                  {s.rationale && <p className="text-[11px] text-slate-400 mt-1.5">{s.rationale}</p>}
                  <details className="mt-1.5">
                    <summary className="text-[11px] text-blue-300 cursor-pointer">Proposed change</summary>
                    <pre className="whitespace-pre-wrap text-[11px] text-slate-300 mt-1 bg-slate-950 rounded p-2 max-h-48 overflow-y-auto">{s.proposedChange}</pre>
                  </details>
                  <div className="flex items-center gap-1.5 mt-2">
                    {s.status === "open" ? (
                      <>
                        <button onClick={() => applySuggestion(s)} disabled={busy === s.id}
                          className="px-2 py-1 rounded text-[10px] bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50">
                          Apply
                        </button>
                        <button onClick={() => { setEditing(true); flash("Suggestion open in editor context — apply it manually, then Save"); }}
                          className="px-2 py-1 rounded text-[10px] bg-blue-800 hover:bg-blue-700">
                          Edit &amp; Apply
                        </button>
                        <button onClick={() => setSuggestionStatus(s, "dismissed")} disabled={busy === s.id}
                          className="px-2 py-1 rounded text-[10px] bg-slate-700 hover:bg-slate-600 disabled:opacity-50 flex items-center gap-1">
                          <Ban className="w-2.5 h-2.5" /> Dismiss
                        </button>
                      </>
                    ) : (
                      <span className="text-[10px] text-slate-500">{s.status}</span>
                    )}
                  </div>
                </div>
              ))}
              {detail?.review?.rawMarkdown && (
                <details className="mt-2">
                  <summary className="text-[11px] text-slate-400 cursor-pointer px-1">Raw review output</summary>
                  <pre className="whitespace-pre-wrap text-[11px] text-slate-400 mt-1 bg-slate-950 rounded p-2">{detail.review.rawMarkdown}</pre>
                </details>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
