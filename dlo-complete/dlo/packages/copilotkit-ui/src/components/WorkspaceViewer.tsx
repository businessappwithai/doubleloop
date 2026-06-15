"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { oneDark } from "@codemirror/theme-one-dark";
import { RefreshCw, FileCode } from "lucide-react";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
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
}

export function WorkspaceViewer({ pipelineId, isRunning }: Props) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

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

  // Poll every 2 s while running, once when done
  useEffect(() => {
    refresh();
    if (!isRunning) return;
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [isRunning, refresh]);

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
          <div className="w-40 flex-shrink-0 bg-slate-950 border-r border-slate-700 overflow-y-auto">
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => setSelected(f.path)}
                className={`w-full text-left px-2 py-1 text-xs font-mono truncate transition ${
                  selected === f.path
                    ? "bg-blue-900/60 text-blue-200"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                }`}
                title={f.path}
              >
                {f.path.split("/").pop()}
                <span className="block text-slate-600 text-[10px] truncate">{f.path}</span>
              </button>
            ))}
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-auto">
            {currentFile ? (
              <CodeMirror
                value={currentFile.content}
                extensions={[langFor(currentFile.path)]}
                theme={oneDark}
                editable={false}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: false,
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
      )}
    </div>
  );
}
