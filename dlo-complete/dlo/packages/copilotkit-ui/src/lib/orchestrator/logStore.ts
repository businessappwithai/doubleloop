/**
 * logStore.ts — in-process log capture for running pipeline phases.
 *
 * Buffers the last MAX_LINES of subprocess output per pipeline and
 * broadcasts each new line to SSE subscribers so the UI can display
 * live progress without polling.
 */

const MAX_LINES = 500;

const buffer = new Map<string, string[]>();
const subscribers = new Map<string, Set<(line: string) => void>>();

export function appendLog(pipelineId: string, text: string): void {
  // Split on newlines so each logical line is a separate entry.
  const lines = text.split(/\r?\n/);
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
  const subs = subscribers.get(pipelineId);
  if (subs) {
    for (const cb of subs) {
      for (const line of lines) {
        if (line || lines.length === 1) cb(line);
      }
    }
  }
}

export function getLogs(pipelineId: string): string[] {
  return [...(buffer.get(pipelineId) ?? [])];
}

export function clearLogs(pipelineId: string): void {
  buffer.delete(pipelineId);
}

/**
 * Subscribe to new log lines. Returns an unsubscribe function.
 * The callback is called once per logical line.
 */
export function subscribeToLogs(
  pipelineId: string,
  cb: (line: string) => void
): () => void {
  const subs = subscribers.get(pipelineId) ?? new Set();
  subs.add(cb);
  subscribers.set(pipelineId, subs);
  return () => {
    subs.delete(cb);
    if (subs.size === 0) subscribers.delete(pipelineId);
  };
}
