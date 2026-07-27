// src/server/adapters/node-clock.ts — the real Clock adapter (Architecture.md "Central
// Orchestrator" rule 4: "nothing above the orchestrator knows about ... Date"). The orchestrator
// is the only caller; every module and repository test instead injects `createFakeClock` from
// tests/helpers/fake-ports.ts.
import type { Clock } from "../ports";

export function createNodeClock(): Clock {
  return {
    now: () => new Date(),
  };
}
