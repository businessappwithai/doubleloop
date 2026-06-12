import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { Journal } from "../src/journal.js";
import { saveSnapshot, loadLatestSnapshot, replayFrom } from "../src/snapshot.js";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(process.cwd(), "tmp-test-journal");

describe("Journal", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("append/replay round-trip preserves events", async () => {
    const journal = new Journal(TEST_DIR, "test-pipeline", () => 1234567890);
    await journal.init();

    await journal.append("pipeline.started", {
      pipelineId: "test-pipeline",
      config: {},
    });

    await journal.append("dag.moduleReady", {
      moduleId: "auth-module",
    });

    const replayed = [];
    for await (const event of journal.replay()) {
      replayed.push(event);
    }

    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.type).toBe("pipeline.started");
    expect(replayed[0]?.pipelineId).toBe("test-pipeline");
    expect(replayed[1]?.type).toBe("dag.moduleReady");
    expect((replayed[1]?.payload as any).moduleId).toBe("auth-module");
  });

  test("corruption detection on single-byte tamper", async () => {
    const journal = new Journal(TEST_DIR, "test-pipeline", () => 1234567890);
    await journal.init();

    await journal.append("pipeline.started", {
      pipelineId: "test-pipeline",
      config: {},
    });

    // Read the segment file, tamper with it, and write it back
    const segmentPath = join(TEST_DIR, "journal", "000001.jsonl");
    const content = await readFile(segmentPath, "utf-8");
    
    // Change one character in the JSON string
    const tamperedContent = content.replace("pipeline.started", "pipeline.startedx");
    await writeFile(segmentPath, tamperedContent, "utf-8");

    // Replay should throw integrity error or corruption error
    const replayer = async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of journal.replay()) {
        // do nothing
      }
    };

    await expect(replayer()).rejects.toThrow();
  });

  test("HEAD recovery after simulated crash", async () => {
    const journal = new Journal(TEST_DIR, "test-pipeline", () => 1234567890);
    await journal.init();

    await journal.append("pipeline.started", {
      pipelineId: "test-pipeline",
      config: {},
    });

    // Delete HEAD file
    const headPath = join(TEST_DIR, "journal", "HEAD");
    await rm(headPath);

    // Initializing a new journal instance should recover by scanning segment files
    const journal2 = new Journal(TEST_DIR, "test-pipeline", () => 1234567890);
    await journal2.init();

    const replayed = [];
    for await (const event of journal2.replay()) {
      replayed.push(event);
    }

    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.type).toBe("pipeline.started");
    expect(journal2.lastSeq).toBe(1);
  });
});
