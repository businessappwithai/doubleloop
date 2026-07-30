// src/modules/documents/document-schema.ts — the documents module's runtime SDL string and
// resolver factory (Implementation.md m11). `documentTypeDefs` intentionally mirrors
// `document-schema.graphql` byte-for-byte rather than reading that file at runtime: the `.graphql`
// file feeds `scripts/emit-schema.ts`'s *build-time* concatenation into `schema.graphql` (which
// the Relay compiler consumes), while this string is what the *runtime* executable schema (m15's
// `/api/graphql` route) merges in — two different consumers, at two different times, so the
// duplication is between build tooling and server runtime, not between two runtime paths that
// could silently drift against each other unnoticed.
//
// Resolvers are exposed as a factory, `createDocumentResolvers({ documents })`, rather than a
// pre-built static map: `src/server/registry.ts` (m15, not yet built) is what actually
// instantiates every module and merges `SchemaContribution`s, and a resolver can only close over
// the concrete `DocumentModule` instance `create()` produced for *that* orchestrator — a static
// map would either share module state across orchestrator instances (breaking test isolation) or
// require resolvers to fish the module out of `RequestContext`, which does not carry it
// (Architecture.md's `RequestContext` is deliberately I/O-free `core`). `index.ts`'s
// `createDocumentModuleDescriptor()` is what closes this factory over the instance it creates.
import { Buffer } from "node:buffer";
import type { GraphQLFieldResolver } from "graphql";
import { localIdOfType } from "../../core/global-id";
import type { RequestContext } from "../../core/context";
import { asConceptId } from "../../core/ids";
import { NotFoundError, ValidationError } from "../../core/errors";
import { blockPayloadSchema, type BlockPayload } from "./blocks";
import type { ConceptDocument, DocumentModule } from "./document-module";

export const documentTypeDefs = `
"""
The fluid half of a Concept (Database.md \`concept_documents\`): the Lexical block payload, the
Markdown projection used for full-text search and Git export, and the state needed to resume Yjs
CRDT collaboration.
"""
type ConceptDocument {
  conceptId: ID!
  """Serialized block tree — validated against this module's block schema on every read."""
  contentBlocks: JSON!
  bodyMarkdown: String!
  """Hex-64 SHA-256 digest of \`bodyMarkdown\`."""
  bodySha256: String!
  blockCount: Int!
  wordCount: Int!
  """Base64-encoded Yjs state vector; a reconnecting client sends this to request a diff."""
  crdtStateVectorB64: String!
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

input SaveDocumentInput {
  conceptId: ID!
  title: String!
  contentBlocks: JSON!
  expectedVersion: Int!
}

input ApplyCrdtUpdateInput {
  conceptId: ID!
  title: String!
  """Base64-encoded Yjs binary update."""
  updateB64: String!
  expectedVersion: Int!
}

extend type Query {
  conceptDocument(conceptId: ID!): ConceptDocument
}

extend type Mutation {
  """The non-CRDT write path: replaces \`contentBlocks\` wholesale under optimistic concurrency."""
  saveDocument(input: SaveDocumentInput!): ConceptDocument!
  """Merges a Yjs binary update into the document's CRDT state and returns the merged result."""
  applyCrdtUpdate(input: ApplyCrdtUpdateInput!): ConceptDocument!
}
`;

type Resolver<TArgs> = GraphQLFieldResolver<unknown, RequestContext, TArgs>;

interface ConceptDocumentGraphQL {
  readonly conceptId: string;
  readonly contentBlocks: BlockPayload;
  readonly bodyMarkdown: string;
  readonly bodySha256: string;
  readonly blockCount: number;
  readonly wordCount: number;
  readonly crdtStateVectorB64: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function serialize(document: ConceptDocument): ConceptDocumentGraphQL {
  return {
    conceptId: document.conceptId,
    contentBlocks: document.contentBlocks,
    bodyMarkdown: document.bodyMarkdown,
    bodySha256: document.bodySha256,
    blockCount: document.blockCount,
    wordCount: document.wordCount,
    crdtStateVectorB64: document.crdtStateVectorB64,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/** Parses GraphQL `JSON` scalar input against the block schema. Never coerces. */
function parseInputBlocks(raw: unknown): BlockPayload {
  const result = blockPayloadSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("document.invalidContentBlocks", {
      details: {
        reason: "document.invalidContentBlocks",
        issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  return result.data;
}

export interface DocumentResolversDeps {
  /**
   * A getter, not a plain `documents: DocumentModule` field: `index.ts` calls this factory before
   * `create()` has run, so the concrete instance must be resolved lazily, at each resolver's call
   * time, not destructured eagerly here (destructuring at factory-call time would capture
   * `undefined` forever, even from an accessor property).
   */
  readonly getDocuments: () => DocumentModule;
}

export interface DocumentResolvers {
  readonly Query: { readonly conceptDocument: Resolver<{ conceptId: string }> };
  readonly Mutation: {
    readonly saveDocument: Resolver<{
      input: { conceptId: string; title: string; contentBlocks: unknown; expectedVersion: number };
    }>;
    readonly applyCrdtUpdate: Resolver<{
      input: { conceptId: string; title: string; updateB64: string; expectedVersion: number };
    }>;
  };
}

export function createDocumentResolvers({ getDocuments }: DocumentResolversDeps): DocumentResolvers {
  const conceptDocument: Resolver<{ conceptId: string }> = async (_source, args) => {
    try {
      return serialize(await getDocuments().load(asConceptId(localIdOfType(args.conceptId, "Concept"))));
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null;
      }
      throw err;
    }
  };

  const saveDocument: DocumentResolvers["Mutation"]["saveDocument"] = async (_source, args, ctx) => {
    const document = await getDocuments().save({
      conceptId: asConceptId(localIdOfType(args.input.conceptId, "Concept")),
      title: args.input.title,
      contentBlocks: parseInputBlocks(args.input.contentBlocks),
      expectedVersion: args.input.expectedVersion,
      actorId: ctx.actor.id,
    });
    return serialize(document);
  };

  const applyCrdtUpdate: DocumentResolvers["Mutation"]["applyCrdtUpdate"] = async (_source, args, ctx) => {
    const document = await getDocuments().applyCrdtUpdate({
      conceptId: asConceptId(localIdOfType(args.input.conceptId, "Concept")),
      title: args.input.title,
      update: Buffer.from(args.input.updateB64, "base64"),
      expectedVersion: args.input.expectedVersion,
      actorId: ctx.actor.id,
    });
    return serialize(document);
  };

  return {
    Query: { conceptDocument },
    Mutation: { saveDocument, applyCrdtUpdate },
  };
}
