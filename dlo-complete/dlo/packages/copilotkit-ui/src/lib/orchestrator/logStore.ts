/**
 * logStore.ts — in-process log capture for running pipeline phases.
 *
 * Buffers the last MAX_LINES of subprocess output per pipeline and
 * broadcasts each new line to SSE subscribers so the UI can display
 * live progress without polling.
 *
 * The buffer and the subscriber table live on `globalThis` under a
 * `Symbol.for` key, NOT in module scope: Next.js compiles each route handler
 * into its own bundle, so a module-level Map is instantiated once per route.
 * The phase code (reached through /api/gates/[gateId]/resolve) then appended
 * into one copy while /api/pipelines/[id]/logs streamed from another, and the
 * console's log panel stayed empty for the whole run.
 */

const MAX_LINES = 500;

const BUFFER_KEY = Symbol.for("dlo.orchestrator.logBuffer");
const SUBSCRIBERS_KEY = Symbol.for("dlo.orchestrator.logSubscribers");

type Buffers = Map<string, string[]>;
type Subscribers = Map<string, Set<(line: string) => void>>;

type Holder = typeof globalThis & {
  [BUFFER_KEY]?: Buffers;
  [SUBSCRIBERS_KEY]?: Subscribers;
};

function buffers(): Buffers {
  const holder = globalThis as Holder;
  if (!holder[BUFFER_KEY]) holder[BUFFER_KEY] = new Map();
  return holder[BUFFER_KEY];
}

function subscriberTable(): Subscribers {
  const holder = globalThis as Holder;
  if (!holder[SUBSCRIBERS_KEY]) holder[SUBSCRIBERS_KEY] = new Map();
  return holder[SUBSCRIBERS_KEY];
}

export function appendLog(pipelineId: string, text: string): void {
  // Split on newlines so each logical line is a separate entry.
  const lines = text.split(/\r?\n/);
  const buffer = buffers();
  const existing = buffer.get(pipelineId) ?? [];
  for (const line of lines) {
    if (!line && lines.length > 1) continue; // skip empty splits
    existing.push(line);
  }
  if (existing.length > MAX_LINES) {
    existing.splice(0, existing.length - MAX_LINES);
  }
  buffer.set(pipelineId, existing);

  // Broadcast to live subscribers.
  const subs = subscriberTable().get(pipelineId);
  if (subs) {
    for (const cb of subs) {
      for (const line of lines) {
        if (line || lines.length === 1) cb(line);
      }
    }
  }
}

export function getLogs(pipelineId: string): string[] {
  return [...(buffers().get(pipelineId) ?? [])];
}

export function clearLogs(pipelineId: string): void {
  buffers().delete(pipelineId);
}

/**
 * Subscribe to new log lines. Returns an unsubscribe function.
 * The callback is called once per logical line.
 */
export function subscribeToLogs(
  pipelineId: string,
  cb: (line: string) => void
): () => void {
  const table = subscriberTable();
  const subs = table.get(pipelineId) ?? new Set();
  subs.add(cb);
  table.set(pipelineId, subs);
  return () => {
    subs.delete(cb);
    if (subs.size === 0) table.delete(pipelineId);
  };
}
