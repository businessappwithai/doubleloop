import { writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import type { Journal, JournalEvent } from "./journal.js";

export interface Snapshot {
  seq: number;
  ts: string;
  state: unknown; // PipelineState
  boardSerialized: unknown; // DagBoard.serialize()
  budgetSerialized: unknown; // BudgetLedger.serialize()
}

export async function saveSnapshot(
  dir: string,
  seq: number,
  state: unknown,
  board: unknown,
  budget: unknown
): Promise<void> {
  const snapshot: Snapshot = {
    seq,
    ts: new Date().toISOString(),
    state,
    boardSerialized: board,
    budgetSerialized: budget,
  };

  const snapshotsDir = `${dir}/snapshots`;
  await mkdir(snapshotsDir, { recursive: true });
  const path = `${snapshotsDir}/state-${seq}.json`;
  await writeFile(path, JSON.stringify(snapshot, null, 2));
}

export async function loadLatestSnapshot(dir: string): Promise<Snapshot | null> {
  const snapshotsDir = `${dir}/snapshots`;
  try {
    const files = await readdir(snapshotsDir);
    const snapshotFiles = files
      .filter((f) => f.startsWith("state-") && f.endsWith(".json"))
      .map((f) => {
        const match = f.match(/^state-(\d+)\.json$/);
        return {
          file: f,
          seq: match ? parseInt(match[1]!, 10) : -1,
        };
      })
      .filter((item) => item.seq >= 0)
      .sort((a, b) => b.seq - a.seq);

    const latest = snapshotFiles[0];
    if (!latest) {
      return null;
    }

    const path = `${snapshotsDir}/${latest.file}`;
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as Snapshot;
  } catch {
    return null;
  }
}

export async function* replayFrom(
  journal: Journal,
  snapshot: Snapshot
): AsyncGenerator<JournalEvent> {
  for await (const event of journal.replay()) {
    if (event.seq > snapshot.seq) {
      yield event;
    }
  }
}
