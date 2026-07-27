// src/modules/documents/index.ts — the documents module's registration point (Implementation.md
// m11; Architecture.md "How modules register"). `src/server/registry.ts` (m15) is not built yet,
// so `ModuleDescriptor`/`SchemaContribution`/`OrchestratorModules` do not exist as importable
// types in this repository — `DocumentModuleDescriptor` below is this module's own, deliberately
// structurally-compatible, stand-in: once m15 adds the real generic types, this shape is written
// to satisfy them (`name`, `dependsOn`, `create({ports, config, deps})`, `schema`) without needing
// to change.
//
// `createDocumentModuleDescriptor()` is a factory, not a pre-built constant, precisely so `schema`
// can close over the exact `DocumentModule` instance `create()` builds for one orchestrator — see
// `document-schema.ts`'s module comment for why a static resolver map cannot do that safely.
// `documents` is assigned synchronously inside `create()`, which — per Architecture.md's
// "Orchestrator ... Responsibilities" — always runs during module wiring, strictly before
// `schema()` is ever built or a resolver ever executes; `assertWired` exists only to turn a
// wiring-order bug (a resolver invoked before `create()` ran) into a loud `InternalError` instead
// of a `documents` `undefined` crash deep inside a resolver.
import { InternalError } from "../../core/errors";
import type { AppConfig } from "../../config/config";
import type { Ports } from "../../server/ports";
import { createDocumentModule, type DocumentModule } from "./document-module";
import { createDocumentRepository } from "./document-repository";
import { createDocumentResolvers, documentTypeDefs, type DocumentResolvers } from "./document-schema";

export interface DocumentModuleCreateArgs {
  readonly ports: Ports;
  readonly config: AppConfig;
  readonly deps: Record<string, unknown>;
}

export interface DocumentModuleDescriptor {
  readonly name: "documents";
  readonly dependsOn: readonly [];
  readonly create: (args: DocumentModuleCreateArgs) => DocumentModule;
  readonly schema: {
    readonly typeDefs: string;
    readonly resolvers: DocumentResolvers;
  };
}

export function createDocumentModuleDescriptor(): DocumentModuleDescriptor {
  let documents: DocumentModule | undefined;

  function assertWired(): DocumentModule {
    if (!documents) {
      throw new InternalError("documents module resolver invoked before create() wired it", {
        details: { module: "documents" },
      });
    }
    return documents;
  }

  const resolvers = createDocumentResolvers({ getDocuments: assertWired });

  return {
    name: "documents",
    dependsOn: [],
    create: ({ ports }) => {
      documents = createDocumentModule({
        repo: createDocumentRepository(ports.db),
        ids: ports.ids,
        logger: ports.logger.child({ module: "documents" }),
      });
      return documents;
    },
    schema: {
      typeDefs: documentTypeDefs,
      resolvers,
    },
  };
}

export type { ConceptDocument, DocumentModule, DocumentModuleDeps } from "./document-module";
export type { ConceptDocumentRow, DocumentRepository, RevisionSource } from "./document-repository";
export { createDocumentModule } from "./document-module";
export { createDocumentRepository } from "./document-repository";
export * from "./blocks";
export * from "./crdt";
