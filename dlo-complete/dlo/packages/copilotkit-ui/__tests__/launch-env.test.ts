/**
 * __tests__/launch-env.test.ts — `readWorkspaceEnvFile` / `buildLaunchEnv`.
 *
 * Found by deploying the generated app's production build and then querying it. The build served
 * `/` fine and died on the first real GraphQL request with
 * `ConfigError: Invalid configuration for INSTANCE_ID: Required`.
 *
 * The cause is a seam between the app and its build tool: a Vite project's `.env` is loaded by the
 * Vite config, which runs for `vite dev` and `vite preview` and NOT for `node dist/server/ssr.js`.
 * Spawning the production build therefore handed it only what the deploy phase passed explicitly —
 * PORT and DATABASE_URL — and every other variable the app requires was simply absent.
 */

import { describe, expect, test } from "vitest";
import { buildLaunchEnv, readWorkspaceEnvFile } from "../src/lib/orchestrator/phases/finalize";

/** A `readFileSync` stand-in serving one fixed body, or throwing ENOENT when `body` is null. */
function reader(body: string | null) {
  return () => {
    if (body === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return body;
  };
}

describe("readWorkspaceEnvFile", () => {
  test("parses plain KEY=VALUE lines", () => {
    expect(readWorkspaceEnvFile("/ws", reader("INSTANCE_ID=local-dev\nLOG_LEVEL=info"))).toEqual({
      INSTANCE_ID: "local-dev",
      LOG_LEVEL: "info",
    });
  });

  test("parses the real shape of the generated app's .env", () => {
    const body = [
      "# Copy to .env and fill in real values.",
      "",
      "NODE_ENV=development",
      "INSTANCE_ID=local-dev",
      "DATABASE_URL=postgres://ekw@127.0.0.1:5433/ekw",
      "COLLAB_WS_URL=ws://localhost:1234",
      "GIT_SYNC_REPO_PATH=./data/git-sync",
    ].join("\n");

    expect(readWorkspaceEnvFile("/ws", reader(body))).toEqual({
      NODE_ENV: "development",
      INSTANCE_ID: "local-dev",
      DATABASE_URL: "postgres://ekw@127.0.0.1:5433/ekw",
      COLLAB_WS_URL: "ws://localhost:1234",
      GIT_SYNC_REPO_PATH: "./data/git-sync",
    });
  });

  test("skips comments and blank lines", () => {
    expect(readWorkspaceEnvFile("/ws", reader("# note\n\n  \nA=1\n# tail"))).toEqual({ A: "1" });
  });

  test("accepts an export prefix", () => {
    expect(readWorkspaceEnvFile("/ws", reader("export A=1"))).toEqual({ A: "1" });
  });

  test("strips matching double and single quotes", () => {
    expect(readWorkspaceEnvFile("/ws", reader(`A="one two"\nB='three'`))).toEqual({
      A: "one two",
      B: "three",
    });
  });

  test("keeps an unmatched quote rather than mangling the value", () => {
    expect(readWorkspaceEnvFile("/ws", reader(`A="unbalanced`))).toEqual({ A: '"unbalanced' });
  });

  test("keeps '=' inside a value", () => {
    expect(readWorkspaceEnvFile("/ws", reader("URL=postgres://u:p@h/db?a=b&c=d"))).toEqual({
      URL: "postgres://u:p@h/db?a=b&c=d",
    });
  });

  test("allows an empty value", () => {
    expect(readWorkspaceEnvFile("/ws", reader("A="))).toEqual({ A: "" });
  });

  test("skips lines that are not assignments", () => {
    expect(readWorkspaceEnvFile("/ws", reader("just some prose\nA=1\n123=nope"))).toEqual({ A: "1" });
  });

  test("returns {} when there is no .env", () => {
    expect(readWorkspaceEnvFile("/ws", reader(null))).toEqual({});
  });

  test("returns {} for an empty .env", () => {
    expect(readWorkspaceEnvFile("/ws", reader(""))).toEqual({});
  });

  test("tolerates CRLF line endings", () => {
    expect(readWorkspaceEnvFile("/ws", reader("A=1\r\nB=2"))).toEqual({ A: "1", B: "2" });
  });
});

describe("buildLaunchEnv", () => {
  test("supplies variables the app needs that nothing else knows about", () => {
    // The regression: without these the production server died on its first real request.
    const env = buildLaunchEnv("/ws", {}, {}, reader("INSTANCE_ID=local-dev\nCOLLAB_WS_URL=ws://x"));

    expect(env["INSTANCE_ID"]).toBe("local-dev");
    expect(env["COLLAB_WS_URL"]).toBe("ws://x");
  });

  test("the real process environment wins over the checked-out .env", () => {
    // A container's or CI's configuration must never be silently replaced by a file.
    const env = buildLaunchEnv("/ws", { INSTANCE_ID: "from-container" }, {}, reader("INSTANCE_ID=from-file"));

    expect(env["INSTANCE_ID"]).toBe("from-container");
  });

  test("the pipeline's own overrides win over both", () => {
    // PORT and DATABASE_URL describe what THIS run provisioned.
    const env = buildLaunchEnv(
      "/ws",
      { PORT: "9999", DATABASE_URL: "postgres://stale" },
      { PORT: "3000", DATABASE_URL: "postgres://provisioned" },
      reader("PORT=1111\nDATABASE_URL=postgres://from-file"),
    );

    expect(env["PORT"]).toBe("3000");
    expect(env["DATABASE_URL"]).toBe("postgres://provisioned");
  });

  test("passes the process environment through when there is no .env", () => {
    const env = buildLaunchEnv("/ws", { PATH: "/usr/bin" }, { PORT: "3000" }, reader(null));

    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["PORT"]).toBe("3000");
  });

  test("an override is applied even when neither the file nor the environment has the key", () => {
    const env = buildLaunchEnv("/ws", {}, { DATABASE_URL: "postgres://x" }, reader(""));

    expect(env["DATABASE_URL"]).toBe("postgres://x");
  });
});
