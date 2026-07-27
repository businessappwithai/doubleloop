-- sql/migrations/004_concept_documents_and_crdt.sql — module m6. `concept_documents` (the CRDT
-- state + Lexical block payload, 1:1 with `concepts`) and `yjs_updates` (the append-only CRDT
-- update log). Transcribed verbatim from Database.md's "## DDL" block.

CREATE TABLE IF NOT EXISTS concept_documents (
  concept_id         uuid        PRIMARY KEY REFERENCES concepts (id) ON DELETE CASCADE,
  bundle_id          uuid        NOT NULL,
  crdt_state         bytea       NOT NULL DEFAULT '\x'::bytea
                                 CHECK (octet_length(crdt_state) <= 33554432),
  crdt_state_vector  bytea       NOT NULL DEFAULT '\x'::bytea
                                 CHECK (octet_length(crdt_state_vector) <= 65536),
  compacted_through  bigint      NOT NULL DEFAULT 0 CHECK (compacted_through >= 0),
  content_blocks     jsonb       NOT NULL DEFAULT '{"root":{"type":"root","children":[]}}'::jsonb
                                 CHECK (jsonb_typeof(content_blocks) = 'object')
                                 CHECK (content_blocks ? 'root'),
  body_markdown      text        NOT NULL DEFAULT '',
  body_sha256        text        NOT NULL DEFAULT repeat('0', 64)
                                 CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  block_count        integer     NOT NULL DEFAULT 0 CHECK (block_count >= 0),
  word_count         integer     NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  version            integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  body_tsv           tsvector    GENERATED ALWAYS AS
                                 (setweight(to_tsvector('okf_english', coalesce(body_markdown, '')), 'B')) STORED,
  CONSTRAINT concept_documents_bundle_fkey
    FOREIGN KEY (concept_id, bundle_id) REFERENCES concepts (id, bundle_id) ON DELETE CASCADE
);

-- Yjs updates are already compact binary; PGLZ buys nothing and costs CPU.
ALTER TABLE concept_documents ALTER COLUMN crdt_state SET STORAGE EXTERNAL;
ALTER TABLE concept_documents ALTER COLUMN crdt_state_vector SET STORAGE EXTERNAL;

-- THE containment index mandated by the research. jsonb_path_ops supports @> only.
CREATE INDEX IF NOT EXISTS concept_documents_blocks_gin
  ON concept_documents USING gin (content_blocks jsonb_path_ops);

CREATE INDEX IF NOT EXISTS concept_documents_body_tsv_gin
  ON concept_documents USING gin (bundle_id, body_tsv);

CREATE INDEX IF NOT EXISTS concept_documents_bundle_idx
  ON concept_documents (bundle_id, updated_at DESC);

DROP TRIGGER IF EXISTS concept_documents_set_updated_at ON concept_documents;
CREATE TRIGGER concept_documents_set_updated_at BEFORE UPDATE ON concept_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS yjs_updates (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  concept_id        uuid        NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  update_bytes      bytea       NOT NULL
                                CHECK (octet_length(update_bytes) BETWEEN 1 AND 4194304),
  origin_client_id  bigint      NOT NULL CHECK (origin_client_id >= 0),
  actor_id          uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE yjs_updates ALTER COLUMN update_bytes SET STORAGE EXTERNAL;

CREATE INDEX IF NOT EXISTS yjs_updates_concept_idx ON yjs_updates (concept_id, id);
