// src/server/adapters/random-ids.ts — the real IdGenerator adapter, backed by Node's built-in
// crypto.randomUUID() (a cryptographically strong v4 UUID — the exact shape every primary key in
// Database.md's DDL takes via `gen_random_uuid()`). The orchestrator is the only caller; every
// module and repository test instead injects `createSeqIds` from tests/helpers/fake-ports.ts for
// deterministic, sequential ids.
import { randomUUID } from "node:crypto";
import type { IdGenerator } from "../ports";

export function createRandomIds(): IdGenerator {
  return {
    uuid: () => randomUUID(),
  };
}
