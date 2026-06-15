"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { RefreshCw, FileCode, MessageSquarePlus, Send, X } from "lucide-react";

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

function langFor(path: string): string {
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".jsx") || path.endsWith(".js")) return "javascript";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".sh")) return "shell";
  return "typescript";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEditorMount = useCallback((monacoEditor: any) => {
    editorRef.current = monacoEditor;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monacoEditor.onDidChangeCursorSelection((e: any) => {
      const sel = e.selection;
      const isEmpty =
        sel.startLineNumber === sel.endLineNumber &&
        sel.startColumn === sel.endColumn;

      if (isEmpty) {
        setLineSelection(null);
        return;
      }

      const model = monacoEditor.getModel();
      if (!model) return;

      const text = model.getValueInRange({
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      });

      setLineSelection({
        fromLine: sel.startLineNumber,
        toLine: sel.endLineNumber,
        text: text.slice(0, 300),
      });

      setTimeout(() => steerInputRef.current?.focus(), 50);
    });
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

  const handleFileSelect = useCallback((path: string) => {
    setSelected(path);
    setLineSelection(null);
  }, []);

  const currentFile = files.find((f) => f.path === selected);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-slate-900 border-b border-slate-700 flex-shrink-0">
        <span className="text-xs text-slate-400 font-mono truncate">
          {files.length === 0
            ? "Waiting for generated files…"
            : `${files.length} file${files.length !== 1 ? "s" : ""}`}
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
                onClick={() => handleFileSelect(f.path)}
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
                    {lineSelection.toLine !== lineSelection.fromLine
                      ? `–${lineSelection.toLine}`
                      : ""}{" "}
                    in {selected?.split("/").pop()}
                  </span>
                  <button
                    onClick={dismissSteer}
                    className="text-slate-500 hover:text-slate-300 mt-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {lineSelection.text && (
                  <pre className="text-[10px] text-slate-500 font-mono bg-slate-900/60 rounded px-2 py-1 mb-2 max-h-12 overflow-hidden truncate">
                    {lineSelection.text.slice(0, 120)}
                    {lineSelection.text.length > 120 ? "…" : ""}
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
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                          handleSteerSubmit();
                      }}
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

            {/* Monaco Editor */}
            <div className="flex-1 overflow-hidden">
              {currentFile ? (
                <Editor
                  key={currentFile.path}
                  value={currentFile.content}
                  language={langFor(currentFile.path)}
                  theme="vs-dark"
                  onMount={handleEditorMount}
                  options={{
                    readOnly: true,
                    fontSize: 12,
                    lineNumbers: "on",
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: "off",
                    folding: true,
                    renderLineHighlight: "line",
                    selectionHighlight: true,
                    occurrencesHighlight: "off",
                    hideCursorInOverviewRuler: true,
                    overviewRulerLanes: 0,
                    scrollbar: {
                      verticalScrollbarSize: 8,
                      horizontalScrollbarSize: 8,
                    },
                    padding: { top: 8, bottom: 8 },
                  }}
                  height="100%"
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
