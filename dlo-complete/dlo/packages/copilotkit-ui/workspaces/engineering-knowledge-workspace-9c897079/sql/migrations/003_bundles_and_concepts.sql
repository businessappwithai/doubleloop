<<<<<<< HEAD
-- sql/migrations/003_bundles_and_concepts.sql
-- Transcribed verbatim from Database.md's "## DDL" block, section "003_bundles_and_concepts.sql".
-- bundles (OKF Knowledge Bundle) and concepts (OKF Concept hierarchy), including the composite
-- FK that pins a child to its parent's bundle, the cycle-rejection constraint trigger, and the
-- denormalised child_count/concept_count maintenance trigger.
=======
-- sql/migrations/003_bundles_and_concepts.sql — module m6. `bundles`, `concepts`, the cycle-
-- rejection constraint trigger, and the denormalised child/concept-count maintenance trigger.
-- Transcribed verbatim from Database.md's "## DDL" block.
>>>>>>> origin/claude/engineering-knowledge-workspace-uknsck

CREATE TABLE IF NOT EXISTS bundles (
  id             uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid             NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slug           text COLLATE "C" NOT NULL
                                  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
                                  CHECK (length(slug) <= 96),
  title          text             NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  description    text             NOT NULL DEFAULT '' CHECK (length(description) <= 8192),
  okf_version    text             NOT NULL DEFAULT '1.0' CHECK (okf_version ~ '^[0-9]+\.[0-9]+$'),
  default_trust  trust_level      NOT NULL DEFAULT 'unverified',
  created_by     uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  concept_count  integer          NOT NULL DEFAULT 0 CHECK (concept_count >= 0),
  version        integer          NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     timestamptz      NOT NULL DEFAULT now(),
  updated_at     timestamptz      NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS bundles_workspace_slug_live_key
  ON bundles (workspace_id, slug) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS bundles_workspace_list_idx
  ON bundles (workspace_id, title COLLATE "C", id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS bundles_set_updated_at ON bundles;
CREATE TRIGGER bundles_set_updated_at BEFORE UPDATE ON bundles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS concepts (
  id           uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id    uuid             NOT NULL REFERENCES bundles (id) ON DELETE CASCADE,
  parent_id    uuid,
  slug         text COLLATE "C" NOT NULL
                                CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
                                CHECK (length(slug) <= 96),
  path         text COLLATE "C" NOT NULL
                                CHECK (path ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$')
                                CHECK (length(path) <= 1024),
  title        text             NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  sort_key     text COLLATE "C" NOT NULL CHECK (sort_key ~ '^[0-9A-Za-z]{1,64}$'),
  depth        smallint         NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 64),
  is_index     boolean          NOT NULL DEFAULT false,
  child_count  integer          NOT NULL DEFAULT 0 CHECK (child_count >= 0),
  created_by   uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  version      integer          NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   timestamptz      NOT NULL DEFAULT now(),
  updated_at   timestamptz      NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  title_tsv    tsvector         GENERATED ALWAYS AS
                                (setweight(to_tsvector('okf_english', coalesce(title, '')), 'A')) STORED,
  CONSTRAINT concepts_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT concepts_id_bundle_key UNIQUE (id, bundle_id),
  -- A child MUST live in the same bundle as its parent. Enforced structurally.
  CONSTRAINT concepts_parent_same_bundle_fkey
    FOREIGN KEY (parent_id, bundle_id) REFERENCES concepts (id, bundle_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS concepts_sibling_slug_live_key
  ON concepts (bundle_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS concepts_bundle_path_live_key
  ON concepts (bundle_id, path) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS concepts_children_idx
  ON concepts (bundle_id, parent_id, sort_key, id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS concepts_bundle_updated_idx
  ON concepts (bundle_id, updated_at DESC, id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS concepts_trash_idx
  ON concepts (bundle_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS concepts_title_trgm_idx
  ON concepts USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS concepts_title_tsv_idx
  ON concepts USING gin (bundle_id, title_tsv);

DROP TRIGGER IF EXISTS concepts_set_updated_at ON concepts;
CREATE TRIGGER concepts_set_updated_at BEFORE UPDATE ON concepts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cycle rejection. The composite FK guarantees same-bundle parentage but not
-- acyclicity; a self-referencing FK cannot express that. This walks ancestors.
CREATE OR REPLACE FUNCTION concepts_reject_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  walker uuid := NEW.parent_id;
  steps  integer := 0;
BEGIN
  WHILE walker IS NOT NULL LOOP
    IF walker = NEW.id THEN
      RAISE EXCEPTION 'concept hierarchy cycle through %', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'concepts_no_cycle';
    END IF;
    steps := steps + 1;
    IF steps > 64 THEN
      RAISE EXCEPTION 'concept hierarchy exceeds 64 levels at %', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'concepts_no_cycle';
    END IF;
    SELECT parent_id INTO walker FROM concepts WHERE id = walker;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS concepts_no_cycle ON concepts;
CREATE CONSTRAINT TRIGGER concepts_no_cycle
  AFTER INSERT OR UPDATE OF parent_id ON concepts
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION concepts_reject_cycle();

-- Denormalised counters. Maintained here so no write path can forget them.
CREATE OR REPLACE FUNCTION concepts_maintain_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  was_live boolean := (TG_OP <> 'INSERT') AND (OLD.deleted_at IS NULL);
  is_live  boolean := (TG_OP <> 'DELETE') AND (NEW.deleted_at IS NULL);
BEGIN
  IF was_live THEN
    IF OLD.parent_id IS NOT NULL THEN
      UPDATE concepts SET child_count = child_count - 1 WHERE id = OLD.parent_id;
    END IF;
    UPDATE bundles SET concept_count = concept_count - 1 WHERE id = OLD.bundle_id;
  END IF;
  IF is_live THEN
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE concepts SET child_count = child_count + 1 WHERE id = NEW.parent_id;
    END IF;
    UPDATE bundles SET concept_count = concept_count + 1 WHERE id = NEW.bundle_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS concepts_counts ON concepts;
CREATE TRIGGER concepts_counts
  AFTER INSERT OR DELETE OR UPDATE OF parent_id, bundle_id, deleted_at ON concepts
  FOR EACH ROW EXECUTE FUNCTION concepts_maintain_counts();
