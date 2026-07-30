/**
 * __tests__/launch-port.test.ts — `parseScriptPort` / `detectLaunchCommand`.
 *
 * Found by running the deploy phase for real. The phase launched the generated app correctly, then
 * polled a port nothing would ever answer on: `detectLaunchCommand` returned a hardcoded 3001 while
 * the app's own `dev` script pinned `vite dev --port 3000`, and a CLI flag beats the `PORT` the
 * phase exports. It waited the full 60 s, recorded `deployed: false` and
 * `appUrl: "http://localhost:3001 (starting up)"` for an app that was serving happily on 3000, and
 * skipped the smoke check entirely — because the smoke check only runs once the app looks ready.
 *
 * A pinned port in the dev script is not unusual; it is what DLO's own design prompts produce.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_LAUNCH_PORT,
  detectLaunchCommand,
  parseScriptPort,
} from "../src/lib/orchestrator/phases/finalize";

describe("parseScriptPort", () => {
  describe("flag forms", () => {
    test("reads --port with a space", () => {
      expect(parseScriptPort("vite dev --port 3000 --config app.config.ts")).toBe(3000);
    });

    test("reads --port=N", () => {
      expect(parseScriptPort("vite dev --port=4173")).toBe(4173);
    });

    test("reads -p with a space, as next dev uses", () => {
      expect(parseScriptPort("next dev -p 3000")).toBe(3000);
    });

    test("reads -p=N", () => {
      expect(parseScriptPort("next dev -p=8080")).toBe(8080);
    });

    test("reads a port at the very end of the script", () => {
      expect(parseScriptPort("vite preview --port 4173")).toBe(4173);
    });

    test("reads the real script this bug was found on", () => {
      expect(parseScriptPort("vite dev --port 3000 --config app.config.ts")).toBe(3000);
    });
  });

  describe("env-assignment form", () => {
    test("reads a leading PORT= assignment", () => {
      expect(parseScriptPort("PORT=8080 node server.js")).toBe(8080);
    });

    test("reads a PORT= assignment after a separator", () => {
      expect(parseScriptPort("npm run build && PORT=5000 node dist/server.js")).toBe(5000);
    });
  });

  describe("scripts that defer to the environment", () => {
    test("returns null when no port is pinned", () => {
      expect(parseScriptPort("next start")).toBeNull();
      expect(parseScriptPort("node server.js")).toBeNull();
    });

    test("returns null for --port $PORT — the script really is deferring", () => {
      expect(parseScriptPort("vite preview --port $PORT")).toBeNull();
    });

    test("returns null for --port ${PORT:-3000}", () => {
      expect(parseScriptPort("next dev -p ${PORT:-3000}")).toBeNull();
    });

    test("returns null for an empty script", () => {
      expect(parseScriptPort("")).toBeNull();
    });
  });

  describe("things that are not a port", () => {
    test("does not read a number that merely follows -p inside a longer flag", () => {
      expect(parseScriptPort("tsc --project 3000")).toBeNull();
    });

    test("does not read a bare number with no flag", () => {
      expect(parseScriptPort("node server.js 3000")).toBeNull();
    });

    test("does not read a single-digit value as a port", () => {
      expect(parseScriptPort("vite dev --port 3")).toBeNull();
    });

    test("takes the first pinned port when a script somehow names two", () => {
      expect(parseScriptPort("vite dev --port 3000 && vite preview --port 4173")).toBe(3000);
    });
  });
});

describe("detectLaunchCommand", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dlo-launch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePkg(scripts: Record<string, string>): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", scripts }), "utf-8");
  }

  test("uses the port the dev script pins, not the default", async () => {
    writePkg({ dev: "vite dev --port 3000 --config app.config.ts" });

    await expect(detectLaunchCommand(dir)).resolves.toEqual({
      cmd: "npm",
      args: ["run", "dev"],
      port: 3000,
    });
  });

  test("falls back to the default when the dev script pins no port", async () => {
    writePkg({ dev: "vite dev" });

    const launch = await detectLaunchCommand(dir);

    expect(launch?.port).toBe(DEFAULT_LAUNCH_PORT);
  });

  test("prefers dev over start", async () => {
    writePkg({ dev: "vite dev --port 3000", start: "node server.js" });

    const launch = await detectLaunchCommand(dir);

    expect(launch?.args).toEqual(["run", "dev"]);
    expect(launch?.port).toBe(3000);
  });

  test("reads the start script's port when there is no dev script", async () => {
    writePkg({ start: "vite preview --port 4173" });

    await expect(detectLaunchCommand(dir)).resolves.toEqual({
      cmd: "npm",
      args: ["start"],
      port: 4173,
    });
  });

  test("returns null when neither script exists", async () => {
    writePkg({ build: "vite build" });

    await expect(detectLaunchCommand(dir)).resolves.toBeNull();
  });

  test("returns null when there is no package.json", async () => {
    await expect(detectLaunchCommand(dir)).resolves.toBeNull();
  });

  test("returns null for a Gradle project — Android does not launch this way", async () => {
    writePkg({ dev: "vite dev --port 3000" });
    writeFileSync(join(dir, "build.gradle.kts"), "", "utf-8");

    await expect(detectLaunchCommand(dir)).resolves.toBeNull();
  });
});
