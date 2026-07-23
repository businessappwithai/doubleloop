"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Database,
  RefreshCw,
  Sparkles,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Code2,
  FileCode,
  ShieldAlert,
  X,
} from "lucide-react";

interface ParseWarning {
  message: string;
  entity?: string;
  field?: string;
}

interface DiffStatement {
  sql: string;
  description: string;
  destructive: boolean;
  reason?: string;
}

interface ErdPreview {
  sourcePath: string;
  dbml: string;
  sql: string[];
  warnings: ParseWarning[];
  schema: { entities: Array<{ name: string }>; enums: Array<{ name: string }> };
}

interface SyncResult {
  applied: DiffStatement[];
  destructive: DiffStatement[];
  warnings: string[];
  failedAt?: { statement: string; error: string };
  viewerUrl?: string | null;
}

type Tab = "viewer" | "dbml" | "sql" | "warnings";

export function ErdPanel({ pipelineId }: { pipelineId: string }) {
  const [preview, setPreview] = useState<ErdPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [applyingDestructive, setApplyingDestructive] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerBuilding, setViewerBuilding] = useState(false);
  const [tab, setTab] = useState<Tab>("viewer");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [pendingDestructive, setPendingDestructive] = useState<DiffStatement[] | null>(null);
  const [viewerNonce, setViewerNonce] = useState(0);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/erd`);
      const data = await res.json();
      if (!res.ok) {
        setPreview(null);
        setError(data.error || "Failed to load ERD");
        return;
      }
      setPreview(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [pipelineId]);

  const loadViewerUrl = useCallback(async () => {
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/erd/viewer`);
      const data = await res.json();
      if (data.url) setViewerUrl(data.url);
    } catch {
      /* ignore */
    }
  }, [pipelineId]);

  useEffect(() => {
    loadPreview();
    loadViewerUrl();
  }, [loadPreview, loadViewerUrl]);

  const buildViewer = useCallback(async () => {
    setViewerBuilding(true);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/erd/viewer`, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.url) {
        setViewerUrl(data.url);
        setViewerNonce((n) => n + 1);
        setTab("viewer");
      } else {
        setError(data.error || "Failed to build viewer");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setViewerBuilding(false);
    }
  }, [pipelineId]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/erd/generate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to generate ERD");
        return;
      }
      setPreview(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }, [pipelineId]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/erd/sync`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to sync database");
        return;
      }
      setSyncResult(data);
      if (data.viewerUrl) {
        setViewerUrl(data.viewerUrl);
        setViewerNonce((n) => n + 1);
      }
      if (data.destructive?.length > 0) {
        setPendingDestructive(data.destructive);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }, [pipelineId]);

  const confirmDestructive = useCallback(async () => {
    if (!pendingDestructive) return;
    setApplyingDestructive(true);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/erd/apply-destructive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statements: pendingDestructive.map((d) => d.sql) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to apply changes");
        return;
      }
      setPendingDestructive(null);
      if (data.viewerUrl) {
        setViewerUrl(data.viewerUrl);
        setViewerNonce((n) => n + 1);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setApplyingDestructive(false);
    }
  }, [pipelineId, pendingDestructive]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-900">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-950 border-b border-slate-700 flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Database className="w-4 h-4 text-blue-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-white">Database &amp; ERD</span>
          {preview && (
            <span className="text-xs text-slate-500 font-mono truncate hidden sm:inline">
              {preview.sourcePath.split("/").pop()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={generate}
            disabled={generating}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-violet-800 hover:bg-violet-700 disabled:opacity-50 text-violet-100 rounded transition"
            title="Ask the Data Modeling Agent to (re)generate an EML ERD from the research document"
          >
            <Sparkles className={`w-3.5 h-3.5 ${generating ? "animate-pulse" : ""}`} />
            {generating ? "Generating…" : preview ? "Regenerate ERD" : "Generate ERD from Research"}
          </button>
          <button
            onClick={loadPreview}
            disabled={loading}
            className="p-1.5 text-slate-400 hover:text-slate-200 transition"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          {preview && (
            <button
              onClick={sync}
              disabled={syncing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition"
              title="Diff the ERD against the live database and apply the changes"
            >
              <Database className={`w-3.5 h-3.5 ${syncing ? "animate-pulse" : ""}`} />
              {syncing ? "Syncing…" : "Sync to Database"}
            </button>
          )}
          {viewerUrl && (
            <a
              href={viewerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open Full Viewer
            </a>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-900/40 border-b border-red-700/50 text-red-200 text-xs flex-shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {syncResult && !pendingDestructive && (
        <div className="flex items-start gap-2 px-3 py-2 bg-green-900/30 border-b border-green-700/40 text-green-200 text-xs flex-shrink-0">
          <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Applied {syncResult.applied.length} change{syncResult.applied.length !== 1 ? "s" : ""} to the database.
            {syncResult.failedAt && ` Stopped on error: ${syncResult.failedAt.error}`}
          </span>
        </div>
      )}

      {!preview && !loading && !error && (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-slate-500 p-8 text-center">
          <FileCode className="w-10 h-10" />
          <p className="text-sm max-w-sm">
            No EML ERD file found yet. Generate one from the research document, or drop a <code className="text-slate-400">.eml.mmd</code> file
            into the workspace.
          </p>
        </div>
      )}

      {preview && (
        <>
          {/* Tabs */}
          <div className="flex items-center border-b border-slate-700 flex-shrink-0">
            {([
              ["viewer", "Viewer"],
              ["dbml", "DBML"],
              ["sql", "SQL"],
              ["warnings", `Warnings${preview.warnings.length ? ` (${preview.warnings.length})` : ""}`],
            ] as Array<[Tab, string]>).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition border-b-2 ${
                  tab === key ? "border-blue-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto mr-3 text-xs text-slate-500">
              {preview.schema.entities.length} entities · {preview.schema.enums.length} enums
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            {tab === "viewer" &&
              (viewerUrl ? (
                <iframe
                  key={viewerNonce}
                  src={`${viewerUrl}?t=${viewerNonce}`}
                  className="w-full h-full border-0 bg-white"
                  title="Liam ERD Viewer"
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500">
                  <Database className="w-10 h-10" />
                  <p className="text-sm">No viewer built yet for this schema.</p>
                  <button
                    onClick={buildViewer}
                    disabled={viewerBuilding}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${viewerBuilding ? "animate-spin" : ""}`} />
                    {viewerBuilding ? "Building…" : "Build Viewer"}
                  </button>
                </div>
              ))}

            {tab === "dbml" && (
              <pre className="h-full overflow-auto p-4 text-xs font-mono text-slate-200 whitespace-pre">{preview.dbml}</pre>
            )}

            {tab === "sql" && (
              <pre className="h-full overflow-auto p-4 text-xs font-mono text-slate-200 whitespace-pre-wrap">
                {preview.sql.join("\n\n")}
              </pre>
            )}

            {tab === "warnings" && (
              <div className="h-full overflow-auto p-4 space-y-2">
                {preview.warnings.length === 0 ? (
                  <p className="text-xs text-slate-500">No warnings — the ERD parsed cleanly.</p>
                ) : (
                  preview.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 bg-amber-900/20 border border-amber-700/40 rounded px-2.5 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div className="text-xs text-amber-200">
                        {w.entity && <span className="font-mono text-amber-400 mr-1">[{w.entity}{w.field ? `.${w.field}` : ""}]</span>}
                        {w.message}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Destructive-change confirmation */}
      {pendingDestructive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-red-700/60 rounded-xl max-w-lg w-full max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between border-b border-red-700/50 p-4 flex-shrink-0">
              <h3 className="text-sm font-bold text-red-200 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" /> Confirm Destructive Changes
              </h3>
              <button onClick={() => setPendingDestructive(null)} className="text-slate-400 hover:text-white transition">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 space-y-2">
              <p className="text-xs text-slate-400 mb-2">
                These changes could fail or lose data and were not applied automatically. Review before confirming:
              </p>
              {pendingDestructive.map((d, i) => (
                <div key={i} className="bg-slate-950 border border-red-700/30 rounded px-2.5 py-2">
                  <p className="text-xs text-red-200 font-medium">{d.description}</p>
                  {d.reason && <p className="text-xs text-slate-500 mt-0.5">{d.reason}</p>}
                  <pre className="text-[10px] text-slate-400 font-mono mt-1 whitespace-pre-wrap">{d.sql}</pre>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-slate-700 flex gap-2 flex-shrink-0">
              <button
                onClick={confirmDestructive}
                disabled={applyingDestructive}
                className="flex-1 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold rounded transition flex items-center justify-center gap-1.5"
              >
                <Code2 className="w-3.5 h-3.5" />
                {applyingDestructive ? "Applying…" : `Apply ${pendingDestructive.length} Change${pendingDestructive.length !== 1 ? "s" : ""}`}
              </button>
              <button
                onClick={() => setPendingDestructive(null)}
                disabled={applyingDestructive}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded transition"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
