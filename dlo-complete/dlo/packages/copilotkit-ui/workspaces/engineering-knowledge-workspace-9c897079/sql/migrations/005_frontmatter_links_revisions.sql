<<<<<<< HEAD
-- sql/migrations/005_frontmatter_links_revisions.sql
-- Transcribed verbatim from Database.md's "## DDL" block, section "005_frontmatter_links_revisions.sql".
-- concept_frontmatter (1:1 OKF YAML frontmatter), concept_links (resolved cross-links), and
-- concept_revisions (immutable snapshot history).
=======
-- sql/migrations/005_frontmatter_links_revisions.sql — module m6. `concept_frontmatter` (OKF YAML
-- metadata, 1:1 with `concepts`), `concept_links` (resolved cross-links), and `concept_revisions`
-- (immutable snapshot history). Transcribed verbatim from Database.md's "## DDL" block.
>>>>>>> origin/claude/engineering-knowledge-workspace-uknsck

CREATE TABLE IF NOT EXISTS concept_frontmatter (
  concept_id   uuid            PRIMARY KEY REFERENCES concepts (id) ON DELETE CASCADE,
  bundle_id    uuid            NOT NULL,
  trust        trust_level     NOT NULL DEFAULT 'unverified',
  lifecycle    lifecycle_state NOT NULL DEFAULT 'draft',
  provenance   jsonb           NOT NULL DEFAULT '{}'::jsonb
                               CHECK (jsonb_typeof(provenance) = 'object'),
  tags         text[]          NOT NULL DEFAULT '{}'::text[]
                               CHECK (array_position(tags, NULL) IS NULL)
                               CHECK (cardinality(tags) <= 64),
  owners       text[]          NOT NULL DEFAULT '{}'::text[]
                               CHECK (array_position(owners, NULL) IS NULL)
                               CHECK (cardinality(owners) <= 32),
  source_uri   text            CHECK (source_uri IS NULL OR length(source_uri) <= 2048),
  verified_at  timestamptz,
  verified_by  uuid            REFERENCES users (id) ON DELETE SET NULL,
  extra        jsonb           NOT NULL DEFAULT '{}'::jsonb
                               CHECK (jsonb_typeof(extra) = 'object'),
  key_order    text[]          NOT NULL DEFAULT '{}'::text[]
                               CHECK (array_position(key_order, NULL) IS NULL),
  raw_yaml     text            NOT NULL DEFAULT '' CHECK (length(raw_yaml) <= 262144),
  version      integer         NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   timestamptz     NOT NULL DEFAULT now(),
  updated_at   timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT concept_frontmatter_bundle_fkey
    FOREIGN KEY (concept_id, bundle_id) REFERENCES concepts (id, bundle_id) ON DELETE CASCADE,
  CONSTRAINT concept_frontmatter_review_consistent
    CHECK ((trust = 'human_reviewed') = (verified_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS concept_frontmatter_trust_idx
  ON concept_frontmatter (bundle_id, trust, concept_id);

CREATE INDEX IF NOT EXISTS concept_frontmatter_lifecycle_idx
  ON concept_frontmatter (bundle_id, lifecycle, concept_id);

CREATE INDEX IF NOT EXISTS concept_frontmatter_tags_gin
  ON concept_frontmatter USING gin (tags);

CREATE INDEX IF NOT EXISTS concept_frontmatter_provenance_gin
  ON concept_frontmatter USING gin (provenance jsonb_path_ops);

DROP TRIGGER IF EXISTS concept_frontmatter_set_updated_at ON concept_frontmatter;
CREATE TRIGGER concept_frontmatter_set_updated_at BEFORE UPDATE ON concept_frontmatter
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS concept_links (
  id                 uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id          uuid            NOT NULL,
  source_concept_id  uuid            NOT NULL,
  target_concept_id  uuid            REFERENCES concepts (id) ON DELETE SET NULL,
  raw_href           text            NOT NULL CHECK (length(raw_href) BETWEEN 1 AND 2048),
  kind               link_kind       NOT NULL,
  resolution         link_resolution NOT NULL DEFAULT 'unresolved',
  anchor             text            CHECK (anchor IS NULL OR length(anchor) <= 256),
  occurrences        integer         NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  created_at         timestamptz     NOT NULL DEFAULT now(),
  updated_at         timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT concept_links_source_fkey
    FOREIGN KEY (source_concept_id, bundle_id) REFERENCES concepts (id, bundle_id) ON DELETE CASCADE,
  CONSTRAINT concept_links_resolution_consistent
    CHECK ((resolution = 'resolved') = (target_concept_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS concept_links_source_href_key
  ON concept_links (source_concept_id, raw_href);

CREATE INDEX IF NOT EXISTS concept_links_backlinks_idx
  ON concept_links (target_concept_id, source_concept_id) WHERE target_concept_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS concept_links_broken_idx
  ON concept_links (bundle_id, source_concept_id) WHERE resolution = 'unresolved';

DROP TRIGGER IF EXISTS concept_links_set_updated_at ON concept_links;
CREATE TRIGGER concept_links_set_updated_at BEFORE UPDATE ON concept_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS concept_revisions (
  id              uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id      uuid            NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  revision_no     integer         NOT NULL CHECK (revision_no >= 1),
  source          revision_source NOT NULL,
  title           text            NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  body_markdown   text            NOT NULL,
  frontmatter     jsonb           NOT NULL DEFAULT '{}'::jsonb
                                  CHECK (jsonb_typeof(frontmatter) = 'object'),
  content_blocks  jsonb           NOT NULL CHECK (jsonb_typeof(content_blocks) = 'object'),
  body_sha256     text            NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  author_id       uuid            REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT concept_revisions_concept_no_key UNIQUE (concept_id, revision_no)
);

CREATE INDEX IF NOT EXISTS concept_revisions_concept_time_idx
  ON concept_revisions (concept_id, created_at DESC, id);
