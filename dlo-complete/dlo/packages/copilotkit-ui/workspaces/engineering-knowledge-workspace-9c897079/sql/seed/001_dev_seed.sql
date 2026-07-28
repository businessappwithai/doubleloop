<<<<<<< HEAD
-- sql/seed/001_dev_seed.sql
-- Development seed (Database.md "Seed & Fixture Strategy" §1). Populates one recognisable,
-- non-trivial workspace so the sidebar, editor, frontmatter panel, search, and Git-sync UI all
-- have something real to render on first `pnpm dev`.
--
-- - Deterministic UUIDs from the reserved namespace 00000000-0000-4000-8000-0000000000NN, so
--   screenshots, bug reports, and manual GraphQL queries stay stable across re-seeds.
-- - Idempotent: every statement ends ON CONFLICT (id) DO NOTHING (or the equivalent primary-key
--   conflict target for tables without a synthetic id), so re-running the seed is a no-op.
-- - Guarded by the runner, not by anything in this file: the caller (a later module's
--   `pnpm db:seed` script) refuses to run when NODE_ENV === "production" and throws
--   `ConfigError('seed.refusedInProduction')` before this file is ever executed.
-- - No CRDT bytes are seeded: crdt_state / crdt_state_vector stay at their '\x' default. The
--   document module materialises a Yjs doc from content_blocks on first open.
-- - body_sha256 is computed from body_markdown at insert time (encode(sha256(...), 'hex')) so
--   the two columns can never drift, rather than hand-computing and hardcoding a hex digest.

BEGIN;

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------

INSERT INTO users (id, email, display_name, avatar_color, is_active)
VALUES ('00000000-0000-4000-8000-000000000001', 'ada@example.test', 'Ada Lovelace', '#7c3aed', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, email, display_name, avatar_color, is_active)
VALUES ('00000000-0000-4000-8000-000000000002', 'grace@example.test', 'Grace Hopper', '#0ea5e9', true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Workspace + membership
-- ---------------------------------------------------------------------

INSERT INTO workspaces (id, slug, name, created_by)
VALUES ('00000000-0000-4000-8000-000000000010', 'platform', 'Platform Engineering', '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'owner')
ON CONFLICT (workspace_id, user_id) DO NOTHING;

INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000002', 'editor')
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Bundles
-- ---------------------------------------------------------------------

INSERT INTO bundles (id, workspace_id, slug, title, description, default_trust, created_by)
VALUES (
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000010',
  'api-reference',
  'API Reference',
  'Public and internal HTTP API documentation for the Platform Engineering org.',
  'unverified',
  '00000000-0000-4000-8000-000000000001'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO bundles (id, workspace_id, slug, title, description, default_trust, created_by)
VALUES (
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000010',
  'runbooks',
  'Runbooks',
  'On-call runbooks for platform services.',
  'unverified',
  '00000000-0000-4000-8000-000000000001'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Concepts — api-reference bundle, 14 concepts across 3 nesting levels.
--
-- getting-started (index)         rest-api (index)                sdk-reference
--  |- installation                 |- authentication (index)      troubleshooting (deprecated)
--  |- quickstart (code block)      |   |- api-keys (broken link)  changelog (archived)
--  |- configuration                |   |- oauth
--                                  |- rate-limiting (machine_confirmed trust)
--                                  |- webhooks
--                                  |- errors (resolved link -> troubleshooting)
-- ---------------------------------------------------------------------

INSERT INTO concepts (id, bundle_id, parent_id, slug, path, title, sort_key, depth, is_index, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000020', NULL,
   'getting-started', 'getting-started', 'Getting Started', 'a', 0, true, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000030',
   'installation', 'getting-started/installation', 'Installation', 'a', 1, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000030',
   'quickstart', 'getting-started/quickstart', 'Quickstart', 'b', 1, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000030',
   'configuration', 'getting-started/configuration', 'Configuration', 'c', 1, false, '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000020', NULL,
   'rest-api', 'rest-api', 'REST API', 'b', 0, true, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000034',
   'authentication', 'rest-api/authentication', 'Authentication', 'a', 1, true, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000036', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000034',
   'rate-limiting', 'rest-api/rate-limiting', 'Rate Limiting', 'b', 1, false, '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000037', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000034',
   'webhooks', 'rest-api/webhooks', 'Webhooks', 'c', 1, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000038', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000034',
   'errors', 'rest-api/errors', 'Error Codes', 'd', 1, false, '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000039', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000035',
   'api-keys', 'rest-api/authentication/api-keys', 'API Keys', 'a', 2, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000003a', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000035',
   'oauth', 'rest-api/authentication/oauth', 'OAuth 2.0', 'b', 2, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000003b', '00000000-0000-4000-8000-000000000020', NULL,
   'sdk-reference', 'sdk-reference', 'SDK Reference', 'c', 0, false, '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000003c', '00000000-0000-4000-8000-000000000020', NULL,
   'troubleshooting', 'troubleshooting', 'Troubleshooting', 'd', 0, false, '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-00000000003d', '00000000-0000-4000-8000-000000000020', NULL,
   'changelog', 'changelog', 'Changelog', 'e', 0, false, '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Frontmatter — one row per concept. Covers all three trust levels and all
-- five lifecycle states across the set.
-- ---------------------------------------------------------------------

INSERT INTO concept_frontmatter (concept_id, bundle_id, trust, lifecycle, tags, owners)
VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{onboarding}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{onboarding,setup}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000020', 'unverified', 'review', '{onboarding}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{onboarding,config}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{api}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{api,security}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000036', '00000000-0000-4000-8000-000000000020', 'machine_confirmed', 'draft', '{api,operations}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000037', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{api}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000038', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{api,reference}', '{platform-eng}'),
  ('00000000-0000-4000-8000-000000000039', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{api,security}', '{platform-eng}'),
  ('00000000-0000-4000-8000-00000000003a', '00000000-0000-4000-8000-000000000020', 'unverified', 'draft', '{api,security}', '{platform-eng}'),
  ('00000000-0000-4000-8000-00000000003b', '00000000-0000-4000-8000-000000000020', 'human_reviewed', 'published', '{sdk,reference}', '{platform-eng}'),
  ('00000000-0000-4000-8000-00000000003c', '00000000-0000-4000-8000-000000000020', 'unverified', 'deprecated', '{support}', '{platform-eng}'),
  ('00000000-0000-4000-8000-00000000003d', '00000000-0000-4000-8000-000000000020', 'unverified', 'archived', '{history}', '{platform-eng}')
ON CONFLICT (concept_id) DO NOTHING;

-- sdk-reference is the one `human_reviewed` concept; the review-consistency CHECK requires
-- verified_at whenever trust = 'human_reviewed'.
UPDATE concept_frontmatter
SET verified_at = now(), verified_by = '00000000-0000-4000-8000-000000000001'
WHERE concept_id = '00000000-0000-4000-8000-00000000003b' AND verified_at IS NULL;

-- ---------------------------------------------------------------------
-- Documents — real Lexical EditorState JSON + matching body_markdown per concept.
-- ---------------------------------------------------------------------

WITH body AS (SELECT $md$# Getting Started

This bundle documents the Platform Engineering HTTP API and the tools built on top of it. Start
here, then move on to Installation and Quickstart.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000030'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Getting Started"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"This bundle documents the Platform Engineering HTTP API and the tools built on top of it. Start here, then move on to Installation and Quickstart."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 26
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Installation

Install the `okf` CLI from npm:

```bash
npm install -g @okf/cli
```

Verify the install with `okf --version`. The CLI talks to the API over HTTPS and stores its
config in `~/.okf/config.json`.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000031'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Installation"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Install the okf CLI from npm:"}]},
    {"type":"code","language":"bash","version":1,"children":[{"type":"code-highlight","version":1,"text":"npm install -g @okf/cli"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Verify the install with okf --version. The CLI talks to the API over HTTPS and stores its config in ~/.okf/config.json."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 4, 34
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Quickstart

Create your first bundle and push a concept:

```bash
okf init my-bundle
okf concept create my-bundle/hello-world --title "Hello World"
okf push
```

The push command commits every changed concept as a Markdown file with YAML frontmatter.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000032'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Quickstart"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Create your first bundle and push a concept:"}]},
    {"type":"code","language":"bash","version":1,"children":[{"type":"code-highlight","version":1,"text":"okf init my-bundle\nokf concept create my-bundle/hello-world --title \"Hello World\"\nokf push"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"The push command commits every changed concept as a Markdown file with YAML frontmatter."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 4, 36
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Configuration

The CLI and the collaboration server both read configuration from environment variables only —
never from a committed file. See the Architecture document for the full variable list.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000033'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Configuration"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"The CLI and the collaboration server both read configuration from environment variables only — never from a committed file. See the Architecture document for the full variable list."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 30
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# REST API

The API is served at `/api/graphql`. All mutations require an authenticated actor; see
Authentication for how to obtain one.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000034'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"REST API"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"The API is served at /api/graphql. All mutations require an authenticated actor; see Authentication for how to obtain one."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 22
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Authentication

Every request carries a bearer token in the `Authorization` header. Tokens are issued per user
and scoped to a single workspace. See API Keys and OAuth 2.0 for the two supported issuance
flows.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000035'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Authentication"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Every request carries a bearer token in the Authorization header. Tokens are issued per user and scoped to a single workspace. See API Keys and OAuth 2.0 for the two supported issuance flows."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 32
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Rate Limiting

Every workspace is limited to 600 requests per minute per actor, enforced at the GraphQL
resolver boundary. Exceeding the limit returns a `rateLimited` error extension with a
`retryAfterMs` field.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000036'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Rate Limiting"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Every workspace is limited to 600 requests per minute per actor, enforced at the GraphQL resolver boundary. Exceeding the limit returns a rateLimited error extension with a retryAfterMs field."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 33
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Webhooks

Bundles can register a webhook that fires on every Git-sync commit. The payload includes the
commit SHA and the list of changed concept paths.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000037'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Webhooks"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Bundles can register a webhook that fires on every Git-sync commit. The payload includes the commit SHA and the list of changed concept paths."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 27
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Error Codes

Every error extension carries a machine-readable `code`. See
[Troubleshooting](../troubleshooting) for the operator-facing playbook that maps each code to a
remediation.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000038'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Error Codes"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Every error extension carries a machine-readable code. See "},{"type":"link","version":1,"url":"../troubleshooting","children":[{"type":"text","version":1,"text":"Troubleshooting"}]},{"type":"text","version":1,"text":" for the operator-facing playbook that maps each code to a remediation."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 24
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# API Keys

Generate a key from the workspace settings page. Keys are shown once; store them in a secret
manager, never in a committed file. See also
[Nonexistent Concept](../nonexistent-concept) — deliberately left unresolved so the broken-link
report has something to show.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-000000000039'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"API Keys"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Generate a key from the workspace settings page. Keys are shown once; store them in a secret manager, never in a committed file. See also "},{"type":"link","version":1,"url":"../nonexistent-concept","children":[{"type":"text","version":1,"text":"Nonexistent Concept"}]},{"type":"text","version":1,"text":" — deliberately left unresolved so the broken-link report has something to show."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 38
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# OAuth 2.0

The API supports the authorization-code grant with PKCE for interactive clients, and the
client-credentials grant for service-to-service calls.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-00000000003a'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"OAuth 2.0"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"The API supports the authorization-code grant with PKCE for interactive clients, and the client-credentials grant for service-to-service calls."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 24
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# SDK Reference

Official SDKs are published for TypeScript and Go. Both wrap the GraphQL API and expose a typed
client generated from `schema.graphql`. This page has been reviewed and verified by a human.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-00000000003b'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"SDK Reference"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"Official SDKs are published for TypeScript and Go. Both wrap the GraphQL API and expose a typed client generated from schema.graphql. This page has been reviewed and verified by a human."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 31
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Troubleshooting

This page describes the legacy debug endpoints, which are deprecated in favor of structured
error extensions. It is kept for historical incident reports that still reference it.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-00000000003c'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Troubleshooting"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"text":"This page describes the legacy debug endpoints, which are deprecated in favor of structured error extensions. It is kept for historical incident reports that still reference it."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 29
FROM body
ON CONFLICT (concept_id) DO NOTHING;

WITH body AS (SELECT $md$# Changelog

**v1** — Initial public release of the REST API surface described in this bundle. Superseded by
the GraphQL API; kept archived for reference.
$md$ AS md)
INSERT INTO concept_documents (concept_id, bundle_id, content_blocks, body_markdown, body_sha256, block_count, word_count)
SELECT '00000000-0000-4000-8000-00000000003d'::uuid, '00000000-0000-4000-8000-000000000020'::uuid,
  $json${"root":{"type":"root","version":1,"children":[
    {"type":"heading","tag":"h1","version":1,"children":[{"type":"text","version":1,"text":"Changelog"}]},
    {"type":"paragraph","version":1,"children":[{"type":"text","version":1,"bold":true,"text":"v1"},{"type":"text","version":1,"text":" — Initial public release of the REST API surface described in this bundle. Superseded by the GraphQL API; kept archived for reference."}]}
  ]}}$json$::jsonb,
  body.md, encode(sha256(convert_to(body.md, 'UTF8')), 'hex'), 2, 22
FROM body
ON CONFLICT (concept_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Links — one resolved relative link, one deliberately broken relative link.
-- ---------------------------------------------------------------------

INSERT INTO concept_links (id, bundle_id, source_concept_id, target_concept_id, raw_href, kind, resolution, occurrences)
VALUES (
  '00000000-0000-4000-8000-000000000050',
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000038',
  '00000000-0000-4000-8000-00000000003c',
  '../troubleshooting',
  'relative',
  'resolved',
  1
)
ON CONFLICT (source_concept_id, raw_href) DO NOTHING;

INSERT INTO concept_links (id, bundle_id, source_concept_id, target_concept_id, raw_href, kind, resolution, occurrences)
VALUES (
  '00000000-0000-4000-8000-000000000051',
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000039',
  NULL,
  '../nonexistent-concept',
  'relative',
  'unresolved',
  1
)
ON CONFLICT (source_concept_id, raw_href) DO NOTHING;

COMMIT;
=======
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
>>>>>>> origin/claude/engineering-knowledge-workspace-uknsck
