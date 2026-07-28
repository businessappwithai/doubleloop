// src/modules/collab/collab-schema.ts — resolver map for collab-schema.graphql (Implementation.md
// m13). `collabTypeDefs` mirrors collab-schema.graphql byte-for-byte rather than reading it at
// runtime, for the same build-time-vs-runtime-consumer split `document-schema.ts` documents.
// `createCollabResolvers` is a factory closing over a getter (not a plain `CollabModule` field)
// for the same reason `document-schema.ts`'s `createDocumentResolvers` is: `index.ts` builds the
// resolver map before `create()` has produced the concrete module instance.
import type { GraphQLFieldResolver } from "graphql";
import type { RequestContext } from "../../core/context";
import { ValidationError } from "../../core/errors";
import { fromGlobalId } from "../../core/global-id";
import { asConceptId, type ConceptId } from "../../core/ids";
import type { CollabModule } from "./collab-module";
import { roomNameFor } from "./collab-module";
import type { PresenceEntry } from "./presence";

export const collabTypeDefs = `
"""A live collaborator currently present in a concept's collaboration room."""
type PresenceEntry {
  actorId: ID!
  displayName: String!
  color: String!
  lastSeenAt: DateTime!
}

extend type Query {
  """Live presence for a concept's collaboration room. \`[]\` when nobody is currently editing."""
  presence(conceptId: ID!): [PresenceEntry!]!
}
`;

type Resolver<TArgs> = GraphQLFieldResolver<unknown, RequestContext, TArgs>;

/** Throws `ValidationError('globalId.wrongType')` if `id` does not decode as a `Concept`. */
function decodeConceptId(id: string): ConceptId {
  const decoded = fromGlobalId(id);
  if (decoded.typeName !== "Concept") {
    throw new ValidationError("globalId.wrongType", {
      details: { id, expected: "Concept", actual: decoded.typeName },
    });
  }
  return asConceptId(decoded.localId);
}

interface PresenceEntryGraphQL {
  readonly actorId: string;
  readonly displayName: string;
  readonly color: string;
  readonly lastSeenAt: string;
}

function serialize(entry: PresenceEntry): PresenceEntryGraphQL {
  return {
    actorId: entry.actorId,
    displayName: entry.displayName,
    color: entry.color,
    lastSeenAt: entry.lastSeenAt,
  };
}

export interface CollabResolversDeps {
  /** See `document-schema.ts`'s `DocumentResolversDeps.getDocuments` for why this is a getter. */
  readonly getCollab: () => CollabModule;
}

export interface CollabResolvers {
  readonly Query: {
    readonly presence: Resolver<{ conceptId: string }>;
  };
}

export function createCollabResolvers({ getCollab }: CollabResolversDeps): CollabResolvers {
  const presence: Resolver<{ conceptId: string }> = (_source, args) => {
    const room = roomNameFor(decodeConceptId(args.conceptId));
    return getCollab().listPresence(room).map(serialize);
  };

  return {
    Query: { presence },
  };
}
