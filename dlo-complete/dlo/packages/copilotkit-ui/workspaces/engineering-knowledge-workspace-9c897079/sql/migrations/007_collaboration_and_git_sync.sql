-- sql/migrations/007_collaboration_and_git_sync.sql
-- Transcribed verbatim from Database.md's "## DDL" block, section "007_collaboration_and_git_sync.sql".
-- collab_sessions (Yjs awareness/presence), git_remotes (per-bundle Git target), git_sync_runs
-- (one row per worker execution), and git_sync_files (per-file outcome of a run).

CREATE TABLE IF NOT EXISTS collab_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id       uuid        NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  actor_id         uuid        REFERENCES users (id) ON DELETE SET NULL,
  yjs_client_id    bigint      NOT NULL CHECK (yjs_client_id >= 0),
  connection_id    text        NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 64),
  connected_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  disconnected_at  timestamptz,
  presence         jsonb       NOT NULL DEFAULT '{}'::jsonb
                               CHECK (jsonb_typeof(presence) = 'object'),
  CONSTRAINT collab_sessions_time_order
    CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS collab_sessions_live_client_key
  ON collab_sessions (concept_id, yjs_client_id) WHERE disconnected_at IS NULL;

CREATE INDEX IF NOT EXISTS collab_sessions_live_idx
  ON collab_sessions (concept_id, last_seen_at DESC) WHERE disconnected_at IS NULL;

CREATE INDEX IF NOT EXISTS collab_sessions_reaper_idx
  ON collab_sessions (last_seen_at) WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS git_remotes (
  id                     uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id              uuid             NOT NULL UNIQUE REFERENCES bundles (id) ON DELETE CASCADE,
  repo_url               text             NOT NULL
                                          CHECK (repo_url ~ '^(https://|git@)')
                                          CHECK (length(repo_url) <= 2048),
  branch                 text             NOT NULL DEFAULT 'main'
                                          CHECK (branch ~ '^[A-Za-z0-9._/-]{1,255}$'),
  subdirectory           text COLLATE "C" NOT NULL DEFAULT ''
                                          CHECK (subdirectory = '' OR
                                                 subdirectory ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'),
  -- The NAME of an environment variable. Never a secret value.
  credential_ref         text             NOT NULL CHECK (credential_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  commit_author_name     text             NOT NULL DEFAULT 'Engineering Knowledge Workspace'
                                          CHECK (length(btrim(commit_author_name)) BETWEEN 1 AND 200),
  commit_author_email    text             NOT NULL
                                          CHECK (commit_author_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  enabled                boolean          NOT NULL DEFAULT true,
  sync_interval_seconds  integer          NOT NULL DEFAULT 300
                                          CHECK (sync_interval_seconds BETWEEN 30 AND 86400),
  last_synced_at         timestamptz,
  last_commit_sha        text             CHECK (last_commit_sha IS NULL OR last_commit_sha ~ '^[0-9a-f]{40}$'),
  version                integer          NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at             timestamptz      NOT NULL DEFAULT now(),
  updated_at             timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS git_remotes_due_idx
  ON git_remotes (last_synced_at NULLS FIRST) WHERE enabled;

DROP TRIGGER IF EXISTS git_remotes_set_updated_at ON git_remotes;
CREATE TRIGGER git_remotes_set_updated_at BEFORE UPDATE ON git_remotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS git_sync_runs (
  id               uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_id        uuid             NOT NULL REFERENCES git_remotes (id) ON DELETE CASCADE,
  bundle_id        uuid             NOT NULL REFERENCES bundles (id) ON DELETE CASCADE,
  status           git_sync_status  NOT NULL DEFAULT 'pending',
  trigger          git_sync_trigger NOT NULL,
  started_at       timestamptz      NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  commit_sha       text             CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
  files_written    integer          NOT NULL DEFAULT 0 CHECK (files_written >= 0),
  files_deleted    integer          NOT NULL DEFAULT 0 CHECK (files_deleted >= 0),
  files_unchanged  integer          NOT NULL DEFAULT 0 CHECK (files_unchanged >= 0),
  error_code       text             CHECK (error_code IS NULL OR length(error_code) <= 128),
  error_message    text             CHECK (error_message IS NULL OR length(error_message) <= 8192),
  CONSTRAINT git_sync_runs_terminal_finished
    CHECK ((status IN ('succeeded', 'failed', 'skipped')) = (finished_at IS NOT NULL)),
  CONSTRAINT git_sync_runs_failure_has_code
    CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS git_sync_runs_bundle_idx
  ON git_sync_runs (bundle_id, started_at DESC, id);

-- At most one in-flight run per remote. Enforced by the database, not by hope.
CREATE UNIQUE INDEX IF NOT EXISTS git_sync_runs_active_key
  ON git_sync_runs (remote_id) WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS git_sync_files (
  run_id          uuid             NOT NULL REFERENCES git_sync_runs (id) ON DELETE CASCADE,
  file_path       text COLLATE "C" NOT NULL
                                   CHECK (file_path ~ '\.md$')
                                   CHECK (file_path !~ '(^|/)\.\.(/|$)')
                                   CHECK (left(file_path, 1) <> '/')
                                   CHECK (length(file_path) <= 1024),
  concept_id      uuid             REFERENCES concepts (id) ON DELETE SET NULL,
  action          git_file_action  NOT NULL,
  content_sha256  text             CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       integer          NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  PRIMARY KEY (run_id, file_path),
  CONSTRAINT git_sync_files_delete_has_no_hash
    CHECK ((action = 'deleted') = (content_sha256 IS NULL))
);

CREATE INDEX IF NOT EXISTS git_sync_files_concept_idx
  ON git_sync_files (concept_id, run_id) WHERE concept_id IS NOT NULL;
