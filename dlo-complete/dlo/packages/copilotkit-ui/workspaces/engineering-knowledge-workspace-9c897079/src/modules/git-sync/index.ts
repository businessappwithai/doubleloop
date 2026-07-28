// src/modules/git-sync/index.ts — the git-sync module's registration point (Implementation.md
// m14; Architecture.md "How modules register"). Mirrors `collab/index.ts`'s
// `createXModuleDescriptor()` shape exactly, and for the same reason: `src/server/registry.ts`
// (m15) is not built yet, so `ModuleDescriptor`/`SchemaContribution`/`OrchestratorModules` do not
// exist as importable types in this repository. `dependsOn: []`: this module reads
// `concepts`/`concept_documents`/`concept_frontmatter`/`git_remotes` directly by SQL — see
// `git-sync-module.ts`'s header for why that mirrors `hierarchy/index.ts`'s own precedent rather
// than declaring a dependency edge on the `concepts`/`hierarchy`/`documents` modules.
import { InternalError } from "../../core/errors";
import type { AppConfig } from "../../config/config";
import type { Ports } from "../../server/ports";
import { createGitSyncModule, type GitSyncModule } from "./git-sync-module";
import { createGitSyncResolvers, gitSyncTypeDefs, type GitSyncResolvers } from "./git-sync-schema";

export interface GitSyncModuleCreateArgs {
  readonly ports: Ports;
  readonly config: AppConfig;
  readonly deps: Record<string, unknown>;
}

export interface GitSyncModuleDescriptor {
  readonly name: "gitSync";
  readonly dependsOn: readonly [];
  readonly create: (args: GitSyncModuleCreateArgs) => GitSyncModule;
  readonly schema: {
    readonly typeDefs: string;
    readonly resolvers: GitSyncResolvers;
  };
}

export function createGitSyncModuleDescriptor(): GitSyncModuleDescriptor {
  let gitSync: GitSyncModule | undefined;

  function assertWired(): GitSyncModule {
    if (!gitSync) {
      throw new InternalError("git-sync module resolver invoked before create() wired it", {
        details: { module: "gitSync" },
      });
    }
    return gitSync;
  }

  const resolvers = createGitSyncResolvers({ getGitSync: assertWired });

  return {
    name: "gitSync",
    dependsOn: [],
    create: ({ ports, config }) => {
      gitSync = createGitSyncModule({
        db: ports.db,
        fs: ports.fs,
        git: ports.git,
        clock: ports.clock,
        ids: ports.ids,
        logger: ports.logger.child({ module: "gitSync" }),
        repoDir: config.gitSync.repoPath,
        intervalMs: config.gitSync.intervalMs,
      });
      return gitSync;
    },
    schema: {
      typeDefs: gitSyncTypeDefs,
      resolvers,
    },
  };
}

export type {
  CreateGitSyncModuleDeps,
  GitFileAction,
  GitSyncModule,
  GitSyncRun,
  GitSyncRunStatus,
  GitSyncTimer,
  GitSyncTimerHandle,
  GitSyncTrigger,
} from "./git-sync-module";
export { createGitSyncModule, GitSyncError } from "./git-sync-module";
export type { ExportConcept, ExportConceptInput, ExportFile, ExportPlan } from "./exporter";
export { exportedFilePath, planExport } from "./exporter";
export type { BrokenLink, LinkKind, RewriteContext, RewriteResult } from "./link-rewriter";
export { classifyHref, rewriteLinks } from "./link-rewriter";
export * from "./git-sync-schema";
