-- sql/migrations/001_extensions_enums_functions.sql — module m6 (SQL migrations and the
-- migration runner). Extensions, the OKF full-text search configuration, every enum type, the
-- shared `set_updated_at()` trigger function, and the migration ledger itself. Transcribed
-- verbatim from Database.md's "## DDL" block — that document is the only authority on shape; if
-- this file and Database.md ever disagree, Database.md changes first and this file follows.
-- Every CREATE here is idempotent (IF NOT EXISTS, or a DO $$ … $$ guard for the enums, which have
-- no CREATE TYPE IF NOT EXISTS), so re-running this file against a partially-migrated database is
-- safe.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Text-search configuration used by every generated tsvector column.
-- Created explicitly so the schema does not depend on the server default,
-- and so accent folding is applied before stemming.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'okf_english') THEN
    CREATE TEXT SEARCH CONFIGURATION okf_english (COPY = pg_catalog.english);
    ALTER TEXT SEARCH CONFIGURATION okf_english
      ALTER MAPPING FOR hword, hword_part, word
      WITH unaccent, english_stem;
  END IF;
END
$$;

-- Enum types. CREATE TYPE has no IF NOT EXISTS, hence the guards.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') THEN
    CREATE TYPE member_role AS ENUM ('owner', 'admin', 'editor', 'viewer');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trust_level') THEN
    CREATE TYPE trust_level AS ENUM ('unverified', 'machine_confirmed', 'human_reviewed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lifecycle_state') THEN
    CREATE TYPE lifecycle_state AS ENUM ('draft', 'review', 'published', 'deprecated', 'archived');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_kind') THEN
    CREATE TYPE link_kind AS ENUM ('absolute', 'relative', 'external', 'anchor');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_resolution') THEN
    CREATE TYPE link_resolution AS ENUM ('resolved', 'unresolved', 'external');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'revision_source') THEN
    CREATE TYPE revision_source AS ENUM ('editor', 'git_import', 'git_export', 'api', 'migration');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'git_sync_status') THEN
    CREATE TYPE git_sync_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'git_sync_trigger') THEN
    CREATE TYPE git_sync_trigger AS ENUM ('schedule', 'manual', 'startup');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'git_file_action') THEN
    CREATE TYPE git_file_action AS ENUM ('created', 'updated', 'deleted', 'unchanged');
  END IF;
END
$$;

-- updated_at maintenance. Application code never writes updated_at.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      integer     PRIMARY KEY,
  name         text        NOT NULL,
  checksum     text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms  integer     NOT NULL CHECK (duration_ms >= 0)
);
