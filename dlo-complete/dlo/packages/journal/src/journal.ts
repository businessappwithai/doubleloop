import { createWriteStream } from "node:fs";
import { writeFile, readFile, mkdir, stat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { JournalCorruptionError, JournalIntegrityError } from "@dlo/core";
import { PayloadRegistry } from "./payloads.js";

export interface JournalEvent {
  seq: number;
  pipelineId: string;
  epoch: number;
  ts: string;
  type: string;
  payload: unknown;
  integrity: string;
}

export interface JournalHead {
  activeSegment: number;
  lastSeq: number;
  lastIntegrity: string;
}

export class Journal {
  #head: JournalHead;
  #dir: string;
  #segmentMaxBytes: number;
  #currentSegment: number;
  #lastIntegrity: string = "";
  #pipelineId: string;
  #epochProvider: () => number;
  #registry: PayloadRegistry;

  constructor(
    dir: string,
    pipelineId: string,
    epochProvider: () => number,
    segmentMaxBytes: number = 67_108_864
  ) {
    this.#dir = dir;
    this.#pipelineId = pipelineId;
    this.#epochProvider = epochProvider;
    this.#segmentMaxBytes = segmentMaxBytes;
    this.#head = { activeSegment: 1, lastSeq: 0, lastIntegrity: "" };
    this.#currentSegment = 1;
    this.#registry = new PayloadRegistry();
  }

  async init(): Promise<void> {
    await mkdir(`${this.#dir}/journal`, { recursive: true });
    const headPath = `${this.#dir}/journal/HEAD`;
    try {
      const content = await readFile(headPath, "utf-8");
      this.#head = JSON.parse(content);
      this.#currentSegment = this.#head.activeSegment;
      this.#lastIntegrity = this.#head.lastIntegrity;
    } catch {
      // Reconstruct HEAD from segment files if they exist
      const { readdir } = await import("node:fs/promises");
      try {
        const files = await readdir(`${this.#dir}/journal`);
        const segments = files
          .filter((f) => /^\d+\.jsonl$/.test(f))
          .map((f) => parseInt(f.split(".")[0]!, 10))
          .sort((a, b) => a - b);

        if (segments.length > 0) {
          let lastSeq = 0;
          let lastIntegrity = "";
          let activeSegment = 1;

          for (const seg of segments) {
            const segmentPath = `${this.#dir}/journal/${String(seg).padStart(6, "0")}.jsonl`;
            const content = await readFile(segmentPath, "utf-8");
            const lines = content.split("\n").filter((l) => l.trim());
            for (const line of lines) {
              const event = JSON.parse(line);
              lastSeq = event.seq;
              lastIntegrity = event.integrity;
              activeSegment = seg;
            }
          }

          this.#head = { activeSegment, lastSeq, lastIntegrity };
          this.#currentSegment = activeSegment;
          this.#lastIntegrity = lastIntegrity;
          await this.#persistHead();
        } else {
          // Fresh journal: HEAD doesn't exist yet, and no segments
          await this.#persistHead();
        }
      } catch {
        // Fallback to fresh if directory reading fails
        await this.#persistHead();
      }
    }
  }

  get lastSeq(): number {
    return this.#head.lastSeq;
  }

  async append(type: string, payload: unknown): Promise<void> {
    // 1. Validate payload schema
    const validatedPayload = this.#registry.validate(type, payload);

    const seq = this.#head.lastSeq + 1;
    const ts = new Date().toISOString();
    const epoch = this.#epochProvider();

    const event: Omit<JournalEvent, "integrity"> = {
      seq,
      pipelineId: this.#pipelineId,
      epoch,
      ts,
      type,
      payload: validatedPayload,
    };

    const integrity = this.#computeIntegrity(event);
    const eventWithIntegrity: JournalEvent = { ...event, integrity };

    const line = JSON.stringify(eventWithIntegrity) + "\n";
    
    // Check if segment rotation is needed
    let segmentPath = this.#getSegmentPath(this.#currentSegment);
    try {
      const s = await stat(segmentPath);
      if (s.size + Buffer.byteLength(line, "utf-8") > this.#segmentMaxBytes) {
        this.#currentSegment += 1;
        segmentPath = this.#getSegmentPath(this.#currentSegment);
      }
    } catch {
      // Segment file doesn't exist, which is fine
    }

    // Append to file
    const ws = createWriteStream(segmentPath, { flags: "a" });
    await new Promise<void>((resolve, reject) => {
      ws.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    ws.end();

    // Sync to disk
    const fd = await open(segmentPath, "r");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }

    // Update state
    this.#lastIntegrity = integrity;
    this.#head = {
      activeSegment: this.#currentSegment,
      lastSeq: seq,
      lastIntegrity: integrity,
    };
    await this.#persistHead();
  }

  async *replay(): AsyncGenerator<JournalEvent> {
    let previousIntegrity = "";
    let lastSeq = 0;

    for (let i = 1; i <= this.#head.activeSegment; i++) {
      const segmentPath = this.#getSegmentPath(i);
      let content = "";
      try {
        content = await readFile(segmentPath, "utf-8");
      } catch (e) {
        if (i < this.#head.activeSegment) {
          throw new JournalCorruptionError(
            `Missing segment file: ${segmentPath}`,
            lastSeq,
            "missing-segment"
          );
        }
        break;
      }

      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        let event: JournalEvent;
        try {
          event = JSON.parse(line);
        } catch (e) {
          throw new JournalCorruptionError(
            `Failed to parse JSON at segment ${i}: ${line}`,
            lastSeq + 1,
            "parse-failure"
          );
        }

        // Verify sequence is contiguous
        if (event.seq !== lastSeq + 1) {
          throw new JournalCorruptionError(
            `Seq gap: expected ${lastSeq + 1}, got ${event.seq}`,
            event.seq,
            "sequence-discontinuity"
          );
        }
        lastSeq = event.seq;

        // Verify integrity chain
        const { integrity: storedIntegrity, ...eventForVerification } = event;
        const computedIntegrity = this.#computeIntegrityWithPrev(eventForVerification, previousIntegrity);
        if (storedIntegrity !== computedIntegrity) {
          throw new JournalIntegrityError(
            `Integrity mismatch at seq ${event.seq}`,
            event.seq
          );
        }

        previousIntegrity = storedIntegrity;
        yield event;
      }
    }
  }

  #computeIntegrity(event: Omit<JournalEvent, "integrity">): string {
    return this.#computeIntegrityWithPrev(event, this.#lastIntegrity);
  }

  #computeIntegrityWithPrev(event: Omit<JournalEvent, "integrity">, prev: string): string {
    const hash = createHash("sha256");
    hash.update(prev);
    hash.update(JSON.stringify(event, Object.keys(event).sort()));
    return hash.digest("hex");
  }

  #getSegmentPath(segmentNum: number): string {
    return `${this.#dir}/journal/${String(segmentNum).padStart(6, "0")}.jsonl`;
  }

  async #persistHead(): Promise<void> {
    const tmp = `${this.#dir}/journal/HEAD.tmp`;
    await writeFile(tmp, JSON.stringify(this.#head, null, 2));
    await import("node:fs/promises").then((m) => m.rename(tmp, `${this.#dir}/journal/HEAD`));
  }
}
