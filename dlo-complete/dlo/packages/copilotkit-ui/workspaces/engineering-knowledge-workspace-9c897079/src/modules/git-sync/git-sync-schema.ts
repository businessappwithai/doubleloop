// src/modules/git-sync/git-sync-schema.ts — the git-sync module's runtime SDL string and resolver
// factory (Implementation.md m14). `gitSyncTypeDefs` intentionally mirrors
// `git-sync-schema.graphql` byte-for-byte rather than reading that file at runtime, for the same
// build-time-vs-runtime-consumer reason `document-schema.ts`'s header documents.
//
// `createGitSyncResolvers({ getGitSync })` is a factory closing over a getter, not a static map —
// same reasoning and same shape as `document-schema.ts`/`collab/index.ts`: `index.ts`'s
// `createGitSyncModuleDescriptor()` is what resolves the getter once `create()` has run.
import type { GraphQLFieldResolver } from "graphql";
import type { Connection, ConnectionArgs } from "../../core/connection";
import { localIdOfType } from "../../core/global-id";
import type { RequestContext } from "../../core/context";
import { asBundleId } from "../../core/ids";
import type { GitSyncModule, GitSyncRun, GitSyncRunStatus, GitSyncTrigger } from "./git-sync-module";

export const gitSyncTypeDefs = `
"""Database.md \`git_sync_status\`."""
enum GitSyncRunStatus {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED
  SKIPPED
}

"""Database.md \`git_sync_trigger\`."""
enum GitSyncTrigger {
  SCHEDULE
  MANUAL
  STARTUP
}

"""One execution of the Git-sync worker (Database.md \`git_sync_runs\`)."""
type GitSyncRun {
  id: ID!
  bundleId: ID!
  remoteId: ID!
  status: GitSyncRunStatus!
  trigger: GitSyncTrigger!
  startedAt: DateTime!
  finishedAt: DateTime
  """Hex-40 commit SHA. \`null\` unless \`status\` is \`SUCCEEDED\`."""
  commitSha: String
  filesWritten: Int!
  filesDeleted: Int!
  filesUnchanged: Int!
  """The \`AppError\`-style machine-readable code. \`null\` unless \`status\` is \`FAILED\`."""
  errorCode: String
  """Redacted failure message. \`null\` unless \`status\` is \`FAILED\`."""
  errorMessage: String
}

type GitSyncRunEdge {
  node: GitSyncRun!
  cursor: String!
}

type GitSyncRunConnection {
  edges: [GitSyncRunEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

extend type Query {
  """Run history for a bundle, most recent first."""
  gitSyncRuns(bundleId: ID!, first: Int, after: String, last: Int, before: String): GitSyncRunConnection!
}

input TriggerGitSyncInput {
  bundleId: ID!
}

type TriggerGitSyncPayload {
  run: GitSyncRun!
}

extend type Mutation {
  """Runs the full export → commit → push cycle for a bundle on demand (\`trigger: MANUAL\`)."""
  triggerGitSync(input: TriggerGitSyncInput!): TriggerGitSyncPayload!
}
`;

type Resolver<TArgs> = GraphQLFieldResolver<unknown, RequestContext, TArgs>;

const STATUS_TO_GRAPHQL: Readonly<Record<GitSyncRunStatus, string>> = {
  pending: "PENDING",
  running: "RUNNING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  skipped: "SKIPPED",
};

const TRIGGER_TO_GRAPHQL: Readonly<Record<GitSyncTrigger, string>> = {
  schedule: "SCHEDULE",
  manual: "MANUAL",
  startup: "STARTUP",
};

interface GitSyncRunGraphQL {
  readonly id: string;
  readonly bundleId: string;
  readonly remoteId: string;
  readonly status: string;
  readonly trigger: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly commitSha: string | null;
  readonly filesWritten: number;
  readonly filesDeleted: number;
  readonly filesUnchanged: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

function serialize(run: GitSyncRun): GitSyncRunGraphQL {
  return {
    id: run.id,
    bundleId: run.bundleId,
    remoteId: run.remoteId,
    status: STATUS_TO_GRAPHQL[run.status],
    trigger: TRIGGER_TO_GRAPHQL[run.trigger],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    commitSha: run.commitSha,
    filesWritten: run.filesWritten,
    filesDeleted: run.filesDeleted,
    filesUnchanged: run.filesUnchanged,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
  };
}

interface GitSyncRunConnectionGraphQL {
  readonly edges: ReadonlyArray<{ readonly node: GitSyncRunGraphQL; readonly cursor: string }>;
  readonly pageInfo: Connection<GitSyncRun>["pageInfo"];
  readonly totalCount: number;
}

function serializeConnection(connection: Connection<GitSyncRun>): GitSyncRunConnectionGraphQL {
  return {
    edges: connection.edges.map((edge) => ({ node: serialize(edge.node), cursor: edge.cursor })),
    pageInfo: connection.pageInfo,
    totalCount: connection.totalCount,
  };
}

export interface GitSyncResolversDeps {
  /** Lazily resolved: `index.ts` calls this factory before `create()` has wired the instance. */
  readonly getGitSync: () => GitSyncModule;
}

export interface GitSyncResolvers {
  readonly Query: {
    readonly gitSyncRuns: Resolver<{
      bundleId: string;
      first?: number;
      after?: string;
      last?: number;
      before?: string;
    }>;
  };
  readonly Mutation: {
    readonly triggerGitSync: Resolver<{ input: { bundleId: string } }>;
  };
}

export function createGitSyncResolvers({ getGitSync }: GitSyncResolversDeps): GitSyncResolvers {
  const gitSyncRuns: GitSyncResolvers["Query"]["gitSyncRuns"] = async (_source, args) => {
    const connectionArgs: ConnectionArgs = {
      ...(args.first != null ? { first: args.first } : {}),
      ...(args.after != null ? { after: args.after } : {}),
      ...(args.last != null ? { last: args.last } : {}),
      ...(args.before != null ? { before: args.before } : {}),
    };
    const connection = await getGitSync().runs(asBundleId(localIdOfType(args.bundleId, "Bundle")), connectionArgs);
    return serializeConnection(connection);
  };

  const triggerGitSync: GitSyncResolvers["Mutation"]["triggerGitSync"] = async (_source, args, ctx) => {
    const run = await getGitSync().syncBundle(ctx, asBundleId(localIdOfType(args.input.bundleId, "Bundle")), "manual");
    return { run: serialize(run) };
  };

  return {
    Query: { gitSyncRuns },
    Mutation: { triggerGitSync },
  };
}
