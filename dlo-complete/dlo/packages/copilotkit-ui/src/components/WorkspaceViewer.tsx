"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { oneDark } from "@codemirror/theme-one-dark";
import type { ViewUpdate } from "@codemirror/view";
import { RefreshCw, FileCode, MessageSquarePlus, Send, X } from "lucide-react";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
}

interface LineSelection {
  fromLine: number;
  toLine: number;
  text: string;
}

function langFor(path: string) {
  if (path.endsWith(".tsx") || path.endsWith(".ts") || path.endsWith(".jsx") || path.endsWith(".js"))
    return javascript({ jsx: true, typescript: true });
  if (path.endsWith(".css")) return css();
  if (path.endsWith(".html")) return html();
  return javascript({ jsx: true, typescript: true });
}

interface Props {
  pipelineId: string;
  isRunning: boolean;
  onSteer?: (file: string, fromLine: number, toLine: number, instruction: string) => Promise<void>;
}

export function WorkspaceViewer({ pipelineId, isRunning, onSteer }: Props) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(null);
  const [steerInstruction, setSteerInstruction] = useState("");
  const [steerSubmitting, setSteerSubmitting] = useState(false);
  const [steerSent, setSteerSent] = useState(false);
  const steerInputRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/workspace`);
      if (res.ok) {
        const data = await res.json();
        const incoming: WorkspaceFile[] = data.files || [];
        setFiles(incoming);
        setLastRefresh(new Date());
        setSelected((prev) => {
          if (!prev && incoming.length > 0) return incoming[0]!.path;
          if (prev && incoming.some((f) => f.path === prev)) return prev;
          return incoming[0]?.path ?? null;
        });
      }
    } finally {
      setLoading(false);
    }
  }, [pipelineId]);

  useEffect(() => {
    refresh();
    if (!isRunning) return;
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [isRunning, refresh]);

  // Detect line selection in CodeMirror
  const handleEditorUpdate = useCallback((update: ViewUpdate) => {
    if (!update.selectionSet) return;
    const sel = update.state.selection.main;
    if (sel.empty) {
      setLineSelection(null);
      return;
    }
    const doc = update.state.doc;
    const fromLine = doc.lineAt(sel.from).number;
    const toLine = doc.lineAt(sel.to).number;
    const text = update.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 300));
    setLineSelection({ fromLine, toLine, text });
    // Focus steering input if it's visible
    setTimeout(() => steerInputRef.current?.focus(), 50);
  }, []);

  const handleSteerSubmit = useCallback(async () => {
    if (!lineSelection || !steerInstruction.trim() || !selected || !onSteer) return;
    setSteerSubmitting(true);
    try {
      await onSteer(selected, lineSelection.fromLine, lineSelection.toLine, steerInstruction.trim());
      setSteerSent(true);
      setSteerInstruction("");
      setTimeout(() => {
        setSteerSent(false);
        setLineSelection(null);
      }, 2000);
    } finally {
      setSteerSubmitting(false);
    }
  }, [lineSelection, steerInstruction, selected, onSteer]);

  const dismissSteer = useCallback(() => {
    setLineSelection(null);
    setSteerInstruction("");
    setSteerSent(false);
  }, []);

  const currentFile = files.find((f) => f.path === selected);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-slate-900 border-b border-slate-700 flex-shrink-0">
        <span className="text-xs text-slate-400 font-mono truncate">
          {files.length === 0 ? "Waiting for generated files…" : `${files.length} file${files.length !== 1 ? "s" : ""}`}
        </span>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs text-slate-600">
              {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="text-slate-500 hover:text-slate-300 transition disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Hint bar */}
      {files.length > 0 && onSteer && (
        <div className="flex items-center gap-1.5 px-3 py-1 bg-slate-900/60 border-b border-slate-800 flex-shrink-0">
          <MessageSquarePlus className="w-3 h-3 text-blue-400 flex-shrink-0" />
          <span className="text-[11px] text-slate-500">
            Select lines in the editor to steer the code at that location
          </span>
        </div>
      )}

      {files.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-slate-600">
          <FileCode className="w-8 h-8" />
          <p className="text-xs">
            {isRunning ? "Generating code…" : "No files generated yet."}
          </p>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* File tree */}
          <div className="w-44 flex-shrink-0 bg-slate-950 border-r border-slate-700 overflow-y-auto">
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => { setSelected(f.path); setLineSelection(null); }}
                className={`w-full text-left px-2 py-1.5 text-xs font-mono transition ${
                  selected === f.path
                    ? "bg-blue-900/60 text-blue-200"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                }`}
                title={f.path}
              >
                <span className="block truncate">{f.path.split("/").pop()}</span>
                <span className="block text-slate-600 text-[10px] truncate">{f.path}</span>
              </button>
            ))}
          </div>

          {/* Editor + steer panel */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            {/* Line-steer panel — appears when lines are selected */}
            {lineSelection && onSteer && (
              <div className="flex-shrink-0 bg-blue-950/80 border-b border-blue-700/60 px-3 py-2">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <span className="text-xs font-semibold text-blue-300">
                    Steer lines {lineSelection.fromLine}
                    {lineSelection.toLine !== lineSelection.fromLine ? `–${lineSelection.toLine}` : ""} in {selected?.split("/").pop()}
                  </span>
                  <button onClick={dismissSteer} className="text-slate-500 hover:text-slate-300 mt-0.5">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {lineSelection.text && (
                  <pre className="text-[10px] text-slate-500 font-mono bg-slate-900/60 rounded px-2 py-1 mb-2 max-h-12 overflow-hidden truncate">
                    {lineSelection.text.slice(0, 120)}{lineSelection.text.length > 120 ? "…" : ""}
                  </pre>
                )}
                {steerSent ? (
                  <p className="text-xs text-green-400 font-medium">Steering note sent!</p>
                ) : (
                  <div className="flex gap-2">
                    <textarea
                      ref={steerInputRef}
                      value={steerInstruction}
                      onChange={(e) => setSteerInstruction(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSteerSubmit(); }}
                      placeholder={`e.g. "Use zod for validation here", "add error handling", "extract this into a helper function"…`}
                      rows={2}
                      className="flex-1 text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleSteerSubmit}
                      disabled={!steerInstruction.trim() || steerSubmitting}
                      className="self-end flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition"
                    >
                      <Send className="w-3 h-3" />
                      {steerSubmitting ? "Sending…" : "Send"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Editor */}
            <div className="flex-1 overflow-auto">
              {currentFile ? (
                <CodeMirror
                  value={currentFile.content}
                  extensions={[langFor(currentFile.path)]}
                  onUpdate={handleEditorUpdate}
                  theme={oneDark}
                  editable={false}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    highlightSelectionMatches: false,
                  }}
                  style={{ fontSize: "12px", height: "100%" }}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                  Select a file
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
