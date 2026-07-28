// src/modules/collab/index.ts — the collaboration module's registration point (Implementation.md
// m13; Architecture.md "How modules register"). Mirrors `documents/index.ts`'s stand-in
// `ModuleDescriptor` shape exactly, and for the same reason: `src/server/registry.ts` (m15) is not
// built yet, so `ModuleDescriptor`/`SchemaContribution`/`OrchestratorModules` do not exist as
// importable types in this repository.
//
// `dependsOn: ["documents"]` records the real dependency (Architecture.md's `CollabModule`
// section: "Depends on: DocumentModule ... Declared dependsOn: ["documents"]"), but `create()`
// does not import `document-module.ts` to satisfy it — per `collab-module.ts`'s header, modules
// never import each other directly. `deps["documents"]` is trusted to already be a
// `CollabDocumentPort`-shaped value by the time `create()` runs; bridging a real `DocumentModule`
// into that shape is composition-root work (the future registry, or `collab-server.ts`'s own
// standalone bootstrap), not this module's.
import { InternalError } from "../../core/errors";
import type { AppConfig } from "../../config/config";
import type { Ports } from "../../server/ports";
import { createCollabModule, type CollabModule, type CollabModuleDeps } from "./collab-module";
import { createCollabResolvers, collabTypeDefs, type CollabResolvers } from "./collab-schema";

export interface CollabModuleCreateArgs {
  readonly ports: Ports;
  readonly config: AppConfig;
  readonly deps: Record<string, unknown>;
}

export interface CollabModuleDescriptor {
  readonly name: "collab";
  readonly dependsOn: readonly ["documents"];
  readonly create: (args: CollabModuleCreateArgs) => CollabModule;
  readonly schema: {
    readonly typeDefs: string;
    readonly resolvers: CollabResolvers;
  };
}

export function createCollabModuleDescriptor(): CollabModuleDescriptor {
  let collab: CollabModule | undefined;

  function assertWired(): CollabModule {
    if (!collab) {
      throw new InternalError("collab module resolver invoked before create() wired it", {
        details: { module: "collab" },
      });
    }
    return collab;
  }

  const resolvers = createCollabResolvers({ getCollab: assertWired });

  return {
    name: "collab",
    dependsOn: ["documents"],
    create: ({ ports, deps }) => {
      collab = createCollabModule({
        documents: deps["documents"] as CollabModuleDeps["documents"],
        clock: ports.clock,
        logger: ports.logger.child({ module: "collab" }),
      });
      return collab;
    },
    schema: {
      typeDefs: collabTypeDefs,
      resolvers,
    },
  };
}

export type {
  CollabDocumentPort,
  CollabModule,
  CollabModuleDeps,
  JoinRoomInput,
  JoinRoomResult,
  PersistSnapshotInput,
  PresenceActor,
} from "./collab-module";
export { conceptIdFor, createCollabModule, roomNameFor } from "./collab-module";
export type { PresenceEntry, PresenceTracker, TouchPresenceInput } from "./presence";
export { createPresenceTracker, DEFAULT_IDLE_THRESHOLD_MS } from "./presence";
