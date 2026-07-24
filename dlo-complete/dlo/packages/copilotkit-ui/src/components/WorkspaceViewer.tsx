"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import {
  RefreshCw, FileCode, MessageSquarePlus, Send, X,
  Folder, FolderOpen, ChevronRight, ChevronDown, File,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: TreeNode[];
}

interface LineSelection {
  fromLine: number;
  toLine: number;
  text: string;
}

interface Props {
  pipelineId: string;
  isRunning: boolean;
  onSteer?: (file: string, fromLine: number, toLine: number, instruction: string) => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function langFor(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return (
    { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
      css: "css", html: "html", json: "json", md: "markdown", py: "python",
      sql: "sql", sh: "shell", kt: "kotlin", swift: "swift", go: "go",
      rs: "rust", java: "java", xml: "xml", yaml: "yaml", yml: "yaml",
      toml: "ini", gradle: "groovy" }[ext] ?? "plaintext"
  );
}

function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce((n, node) =>
    n + (node.type === "file" ? 1 : countFiles(node.children ?? [])), 0);
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── FileTree ─────────────────────────────────────────────────────────────────

function FileTreeNode({
  node, depth, selected, onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);

  if (node.type === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-1 px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          {open ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
          {open ? <FolderOpen className="w-3 h-3 flex-shrink-0 text-amber-400" /> : <Folder className="w-3 h-3 flex-shrink-0 text-amber-500" />}
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  const isSelected = selected === node.path;
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full flex items-center gap-1.5 py-0.5 text-xs font-mono transition ${
        isSelected ? "bg-blue-900/60 text-blue-200" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      }`}
      style={{ paddingLeft: `${20 + depth * 12}px`, paddingRight: "8px" }}
      title={node.path}
    >
      <File className="w-3 h-3 flex-shrink-0 text-slate-500" />
      <span className="truncate flex-1 text-left">{node.name}</span>
      {node.size != null && (
        <span className="text-[10px] text-slate-600 flex-shrink-0">{fmt(node.size)}</span>
      )}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function WorkspaceViewer({ pipelineId, isRunning, onSteer }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [treeLoading, setTreeLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(null);
  const [fileSteerOpen, setFileSteerOpen] = useState(false);
  const [steerInstruction, setSteerInstruction] = useState("");
  const [steerSubmitting, setSteerSubmitting] = useState(false);
  const [steerSent, setSteerSent] = useState(false);
  const steerInputRef = useRef<HTMLTextAreaElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  // ── Tree refresh (no content) ─────────────────────────────────────────
  const refreshTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/workspace`);
      if (res.ok) {
        const data = await res.json();
        setTree(data.tree ?? []);
        if (data.workspaceDir) setWorkspaceDir(data.workspaceDir);
        setLastRefresh(new Date());
      }
    } finally {
      setTreeLoading(false);
    }
  }, [pipelineId]);

  // ── File fetch on demand ──────────────────────────────────────────────
  const loadFile = useCallback(async (path: string) => {
    setFileLoading(true);
    setFileContent(null);
    setLineSelection(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/workspace?file=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content ?? "");
      } else {
        setFileContent("[Error loading file]");
      }
    } finally {
      setFileLoading(false);
    }
  }, [pipelineId]);

  const handleFileSelect = useCallback((path: string) => {
    setSelected(path);
    setFileSteerOpen(false);
    setLineSelection(null);
    setSteerInstruction("");
    loadFile(path);
  }, [loadFile]);

  useEffect(() => { refreshTree(); }, [refreshTree]);

  // Auto-refresh tree only (not content) while running
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(refreshTree, 5000);
    return () => clearInterval(id);
  }, [isRunning, refreshTree]);

  // ── Monaco ────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEditorMount = useCallback((monacoEditor: any) => {
    editorRef.current = monacoEditor;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monacoEditor.onDidChangeCursorSelection((e: any) => {
      const sel = e.selection;
      const isEmpty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
      if (isEmpty) { setLineSelection(null); return; }
      const model = monacoEditor.getModel();
      if (!model) return;
      const text = model.getValueInRange({
        startLineNumber: sel.startLineNumber, startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber, endColumn: sel.endColumn,
      });
      setLineSelection({ fromLine: sel.startLineNumber, toLine: sel.endLineNumber, text: text.slice(0, 300) });
      setTimeout(() => steerInputRef.current?.focus(), 50);
    });
  }, []);

  const handleSteerSubmit = useCallback(async () => {
    if (!steerInstruction.trim() || !selected || !onSteer) return;
    const fromLine = lineSelection?.fromLine ?? 0;
    const toLine = lineSelection?.toLine ?? 0;
    setSteerSubmitting(true);
    try {
      await onSteer(selected, fromLine, toLine, steerInstruction.trim());
      setSteerSent(true);
      setSteerInstruction("");
      setTimeout(() => {
        setSteerSent(false);
        setLineSelection(null);
        setFileSteerOpen(false);
      }, 2000);
    } finally { setSteerSubmitting(false); }
  }, [lineSelection, steerInstruction, selected, onSteer]);

  const totalFiles = countFiles(tree);

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-950">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 font-mono">
            {tree.length === 0 ? "Waiting for generated files…" : `${totalFiles} file${totalFiles !== 1 ? "s" : ""}`}
          </span>
          {workspaceDir && (
            <span className="text-[10px] text-slate-600 font-mono truncate max-w-xs hidden lg:block" title={workspaceDir}>
              {workspaceDir.split("/").slice(-2).join("/")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-slate-600">{lastRefresh.toLocaleTimeString()}</span>
          )}
          <button
            onClick={refreshTree}
            disabled={treeLoading}
            className="text-slate-500 hover:text-slate-300 transition disabled:opacity-40"
            title="Refresh file tree"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${treeLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {tree.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-slate-600">
          <FileCode className="w-8 h-8" />
          <p className="text-xs">{isRunning ? "Generating code…" : "No files yet."}</p>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* File tree sidebar */}
          <div className="w-52 flex-shrink-0 bg-[#0d0f14] border-r border-slate-800 overflow-y-auto py-1">
            {tree.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                selected={selected}
                onSelect={handleFileSelect}
              />
            ))}
          </div>

          {/* Editor pane */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            {/* Breadcrumb */}
            {selected && (
              <div className="flex items-center gap-1 px-3 py-1 bg-slate-900 border-b border-slate-800 flex-shrink-0">
                <FileCode className="w-3 h-3 text-slate-500 flex-shrink-0" />
                <span className="text-[11px] text-slate-400 font-mono truncate flex-1">{selected}</span>
                {onSteer && !lineSelection && (
                  <button
                    onClick={() => { setFileSteerOpen((o) => !o); setSteerInstruction(""); setTimeout(() => steerInputRef.current?.focus(), 50); }}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition flex-shrink-0 ${fileSteerOpen ? "bg-violet-700 text-white" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"}`}
                    title="Steer this entire file"
                  >
                    <MessageSquarePlus className="w-3 h-3" />
                    Steer file
                  </button>
                )}
              </div>
            )}

            {/* File-level steer panel */}
            {fileSteerOpen && !lineSelection && onSteer && selected && (
              <div className="flex-shrink-0 bg-violet-950/80 border-b border-violet-700/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-xs font-semibold text-violet-300">
                    <MessageSquarePlus className="w-3.5 h-3.5 inline mr-1" />
                    Steer <span className="font-mono">{selected.split("/").pop()}</span>
                  </span>
                  <button onClick={() => { setFileSteerOpen(false); setSteerInstruction(""); }} className="text-slate-500 hover:text-slate-300">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {steerSent ? (
                  <p className="text-xs text-green-400 font-medium">Steering note sent!</p>
                ) : (
                  <div className="flex gap-2">
                    <textarea
                      ref={steerInputRef}
                      value={steerInstruction}
                      onChange={(e) => setSteerInstruction(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSteerSubmit(); }}
                      placeholder={`e.g. "Refactor to use async/await", "Add JSDoc to all exports", "Switch to named exports"…`}
                      rows={2}
                      className="flex-1 text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-violet-500"
                    />
                    <button
                      onClick={handleSteerSubmit}
                      disabled={!steerInstruction.trim() || steerSubmitting}
                      className="self-end flex items-center gap-1 px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded transition"
                    >
                      <Send className="w-3 h-3" />
                      {steerSubmitting ? "…" : "Send"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Line-selection steer panel */}
            {lineSelection && onSteer && (
              <div className="flex-shrink-0 bg-blue-950/80 border-b border-blue-700/60 px-3 py-2">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <span className="text-xs font-semibold text-blue-300">
                    <MessageSquarePlus className="w-3.5 h-3.5 inline mr-1" />
                    Steer lines {lineSelection.fromLine}
                    {lineSelection.toLine !== lineSelection.fromLine ? `–${lineSelection.toLine}` : ""}{" "}
                    in {selected?.split("/").pop()}
                  </span>
                  <button onClick={() => { setLineSelection(null); setSteerInstruction(""); }} className="text-slate-500 hover:text-slate-300">
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
                      placeholder={`e.g. "Use zod for validation", "add error handling", "extract into helper"…`}
                      rows={2}
                      className="flex-1 text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleSteerSubmit}
                      disabled={!steerInstruction.trim() || steerSubmitting}
                      className="self-end flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition"
                    >
                      <Send className="w-3 h-3" />
                      {steerSubmitting ? "…" : "Send"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Monaco or placeholder */}
            <div className="flex-1 overflow-hidden relative">
              {!selected ? (
                <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                  Select a file to view
                </div>
              ) : fileLoading ? (
                <div className="flex items-center justify-center h-full gap-2 text-slate-500 text-xs">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : fileContent !== null ? (
                <Editor
                  key={selected}
                  value={fileContent}
                  language={langFor(selected)}
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
                    occurrencesHighlight: "off" as const,
                    hideCursorInOverviewRuler: true,
                    overviewRulerLanes: 0,
                    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                    padding: { top: 8, bottom: 8 },
                  }}
                  height="100%"
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
