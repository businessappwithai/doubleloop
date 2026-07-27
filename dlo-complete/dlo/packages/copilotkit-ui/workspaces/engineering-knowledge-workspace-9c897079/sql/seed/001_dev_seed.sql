-- sql/seed/001_dev_seed.sql — module m6. Populates a recognisable, non-trivial workspace so the
-- sidebar, editor, frontmatter panel, search, and Git-sync UI all have something real to render on
-- first `pnpm dev` (Database.md "Seed & Fixture Strategy" §1).
--
-- Every row uses a fixed, human-readable UUID from the reserved namespace
-- `00000000-0000-4000-8000-0000000000NN`, so screenshots and manual GraphQL queries stay stable
-- across re-seeds. Every statement ends `ON CONFLICT (id) DO NOTHING` (or the table's actual
-- primary key, for the two tables whose key is not `id`), so re-running this file is a no-op, not
-- a duplicate-key crash. The runner that invokes this file is responsible for refusing to run it
-- when `NODE_ENV === "production"` (`ConfigError('seed.refusedInProduction')`) — that guard is not
-- expressed in SQL.
--
-- No CRDT bytes are seeded: `concept_documents.crdt_state` stays at its default `'\x'`. The
-- document module materialises a Yjs document from `content_blocks` on first open; hand-authoring
-- valid Yjs binary in SQL would be unverifiable.

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

INSERT INTO users (id, email, display_name, avatar_color, is_active)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'ada@example.test',   'Ada Lovelace',   '#7c3aed', true),
  ('00000000-0000-4000-8000-000000000002', 'grace@example.test', 'Grace Hopper',   '#0ea5e9', true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Workspace and membership
-- ---------------------------------------------------------------------------

INSERT INTO workspaces (id, slug, name, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000010', 'platform', 'Platform Engineering', '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'owner'),
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000002', 'editor')
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Bundles
-- ---------------------------------------------------------------------------

INSERT INTO bundles (id, workspace_id, slug, title, description, okf_version, default_trust, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000010',
   'api-reference', 'API Reference',
   'The OKF Knowledge Bundle documenting every public endpoint, SDK, and integration pattern.',
   '1.0', 'unverified', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000010',
   'runbooks', 'Operational Runbooks',
   'Incident response and on-call runbooks for the platform team.',
   '1.0', 'unverified', '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Concepts — api-reference bundle, 14 concepts across 3 nesting levels.
-- Depth 0: getting-started (is_index, has children), authentication, rate-limiting, webhooks,
--          errors, pagination, changelog, sdks.
-- Depth 1: getting-started/installation, getting-started/quickstart,
--          sdks/python, sdks/node, sdks/broken-link-example.
-- Depth 2: getting-started/quickstart/node-example (leaf with a code block).
-- ---------------------------------------------------------------------------

-- Depth 0
INSERT INTO concepts (id, bundle_id, parent_id, slug, path, title, sort_key, depth, is_index, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000020', NULL,
   'getting-started', 'getting-started', 'Getting Started', 'a0', 0, true,
   '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000020', NULL,
   'authentication', 'authentication', 'Authentication', 'a1', 0, false,
   '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000020', NULL,
   'rate-limiting', 'rate-limiting', 'Rate Limiting', 'a2', 0, false,
   '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000020', NULL,
   'webhooks', 'webhooks', 'Webhooks', 'a3', 0, false,
   '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000020', NULL,
   'errors', 'errors', 'Error Codes', 'a4', 0, false,
   '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000020', NULL,
   'pagination', 'pagination', 'Pagination', 'a5', 0, false,
   '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000020', NULL,
   'changelog', 'changelog', 'Changelog', 'a6', 0, false,
   '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000020', NULL,
   'sdks', 'sdks', 'Client SDKs', 'a7', 0, false,
   '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- Depth 1
INSERT INTO concepts (id, bundle_id, parent_id, slug, path, title, sort_key, depth, is_index, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000110', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000100', 'installation', 'getting-started/installation',
   'Installation', 'a0', 1, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000100', 'quickstart', 'getting-started/quickstart',
   'Quickstart', 'a1', 1, true, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000120', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000107', 'python', 'sdks/python',
   'Python SDK', 'a0', 1, false, '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000107', 'node', 'sdks/node',
   'Node.js SDK', 'a1', 1, false, '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000122', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000107', 'broken-link-example', 'sdks/broken-link-example',
   'Broken Link Example', 'a2', 1, false, '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- Depth 2
INSERT INTO concepts (id, bundle_id, parent_id, slug, path, title, sort_key, depth, is_index, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000130', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000111', 'node-example', 'getting-started/quickstart/node-example',
   'Node.js Quickstart Example', 'a0', 2, false, '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Concept documents — real Lexical EditorState + matching Markdown body per concept.
-- ---------------------------------------------------------------------------

INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, block_count, word_count)
VALUES
  ('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"paragraph","children":[{"type":"text","text":"Welcome to the API Reference bundle. Start with Installation, then Quickstart."}]}
   ]}}
   $blocks$::jsonb,
   $md$Welcome to the API Reference bundle. Start with Installation, then Quickstart.$md$,
   1, 12),

  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Authentication"}]},
     {"type":"paragraph","children":[{"type":"text","text":"Every request must carry a bearer token issued by the platform's OAuth2 token endpoint. Tokens expire after one hour and must be refreshed before then."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Authentication

Every request must carry a bearer token issued by the platform's OAuth2 token endpoint. Tokens expire after one hour and must be refreshed before then.$md$,
   2, 26),

  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Rate Limiting"}]},
     {"type":"paragraph","children":[{"type":"text","text":"The API enforces 600 requests per minute per token, returned via the X-RateLimit-Remaining header. Exceeding the limit returns HTTP 429."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Rate Limiting

The API enforces 600 requests per minute per token, returned via the X-RateLimit-Remaining header. Exceeding the limit returns HTTP 429.$md$,
   2, 24),

  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Webhooks"}]},
     {"type":"paragraph","children":[{"type":"text","text":"Subscribe to concept.published and bundle.synced events. Each delivery is signed with an HMAC-SHA256 signature in the X-OKF-Signature header."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Webhooks

Subscribe to concept.published and bundle.synced events. Each delivery is signed with an HMAC-SHA256 signature in the X-OKF-Signature header.$md$,
   2, 24),

  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Error Codes"}]},
     {"type":"paragraph","children":[{"type":"text","text":"This page is a work in progress. It will list every machine-readable error code returned by the GraphQL layer alongside its httpStatus and meaning."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Error Codes

This page is a work in progress. It will list every machine-readable error code returned by the GraphQL layer alongside its httpStatus and meaning.$md$,
   2, 26),

  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Pagination"}]},
     {"type":"paragraph","children":[{"type":"text","text":"Superseded by the Relay cursor Connections documented on every list query. This page is kept only for links from older bookmarks."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Pagination

Superseded by the Relay cursor Connections documented on every list query. This page is kept only for links from older bookmarks.$md$,
   2, 22),

  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Changelog"}]},
     {"type":"paragraph","children":[{"type":"text","text":"2024-01-01 — initial public release of the API Reference bundle."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Changelog

2024-01-01 — initial public release of the API Reference bundle.$md$,
   2, 10),

  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Client SDKs"}]},
     {"type":"paragraph","children":[{"type":"text","text":"Official SDKs are published for Python and Node.js. Both wrap the GraphQL API and handle token refresh automatically."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Client SDKs

Official SDKs are published for Python and Node.js. Both wrap the GraphQL API and handle token refresh automatically.$md$,
   2, 20),

  ('00000000-0000-4000-8000-000000000110', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Installation"}]},
     {"type":"paragraph","children":[{"type":"text","text":"Run npm install @okf/sdk (Node.js) or pip install okf-sdk (Python) to get started."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Installation

Run npm install @okf/sdk (Node.js) or pip install okf-sdk (Python) to get started.$md$,
   2, 18),

  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Quickstart"}]},
     {"type":"paragraph","children":[{"type":"text","text":"Pick your language below for a runnable first-request example."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Quickstart

Pick your language below for a runnable first-request example.$md$,
   2, 12),

  ('00000000-0000-4000-8000-000000000120', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Python SDK"}]},
     {"type":"paragraph","children":[{"type":"text","text":"pip install okf-sdk. Requires Python 3.10 or newer."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Python SDK

pip install okf-sdk. Requires Python 3.10 or newer.$md$,
   2, 12),

  ('00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Node.js SDK"}]},
     {"type":"paragraph","children":[{"type":"text","text":"npm install @okf/sdk. See "},{"type":"link","url":"../authentication","children":[{"type":"text","text":"Authentication"}]},{"type":"text","text":" for how to obtain a token."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Node.js SDK

npm install @okf/sdk. See [Authentication](../authentication) for how to obtain a token.$md$,
   2, 16),

  ('00000000-0000-4000-8000-000000000122', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Broken Link Example"}]},
     {"type":"paragraph","children":[{"type":"text","text":"This page deliberately links to "},{"type":"link","url":"../nonexistent","children":[{"type":"text","text":"a page that does not exist"}]},{"type":"text","text":", so the broken-link report has something to show."}]}
   ]}}
   $blocks$::jsonb,
   $md$# Broken Link Example

This page deliberately links to [a page that does not exist](../nonexistent), so the broken-link report has something to show.$md$,
   2, 20),

  ('00000000-0000-4000-8000-000000000130', '00000000-0000-4000-8000-000000000020',
   $blocks$
   {"root":{"type":"root","children":[
     {"type":"heading","tag":"h1","children":[{"type":"text","text":"Node.js Quickstart Example"}]},
     {"type":"paragraph","children":[{"type":"text","text":"Install the SDK and make your first authenticated request."}]},
     {"type":"code","language":"javascript","children":[{"type":"text","text":"import { Client } from \"@okf/sdk\";\n\nconst client = new Client({ apiKey: process.env.OKF_API_KEY });\nconst bundle = await client.bundles.get(\"api-reference\");\nconsole.log(bundle.title);"}]}
   ]}}
   $blocks$::jsonb,
   $md$# Node.js Quickstart Example

Install the SDK and make your first authenticated request.

```javascript
import { Client } from "@okf/sdk";

const client = new Client({ apiKey: process.env.OKF_API_KEY });
const bundle = await client.bundles.get("api-reference");
console.log(bundle.title);
```
$md$,
   3, 22)
ON CONFLICT (concept_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Frontmatter — one concept per trust_level, one per lifecycle_state.
-- Defaults (unverified / draft) are left implicit for concepts not listed here.
-- ---------------------------------------------------------------------------

INSERT INTO concept_frontmatter (concept_id, bundle_id, trust, lifecycle, tags, owners, verified_at, verified_by)
VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000020',
   'machine_confirmed', 'published', ARRAY['auth', 'security'], ARRAY['platform-team'], NULL, NULL),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000020',
   'human_reviewed', 'review', ARRAY['limits'], ARRAY['grace@example.test'],
   '2026-01-15T09:00:00Z', '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000020',
   'unverified', 'draft', ARRAY['errors'], ARRAY[]::text[], NULL, NULL),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000020',
   'unverified', 'deprecated', ARRAY['pagination'], ARRAY[]::text[], NULL, NULL),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000020',
   'unverified', 'archived', ARRAY[]::text[], ARRAY[]::text[], NULL, NULL)
ON CONFLICT (concept_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Links — one resolved relative link, one deliberately broken.
-- ---------------------------------------------------------------------------

INSERT INTO concept_links (id, bundle_id, source_concept_id, target_concept_id, raw_href, kind, resolution)
VALUES
  ('00000000-0000-4000-8000-000000000200', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000101',
   '../authentication', 'relative', 'resolved'),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000122', NULL,
   '../nonexistent', 'relative', 'unresolved')
ON CONFLICT (id) DO NOTHING;
