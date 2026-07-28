-- sql/migrations/002_identity_and_workspaces.sql — module m6. users (actors; no credential
-- columns), workspaces (top-level tenant container), and workspace_members (membership + role,
-- exactly one owner per workspace). Transcribed verbatim from Database.md's "## DDL" block.

CREATE TABLE IF NOT EXISTS users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL
                            CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
                            CHECK (length(email) <= 320),
  display_name  text        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  avatar_color  text        NOT NULL DEFAULT '#6b7280' CHECK (avatar_color ~ '^#[0-9a-f]{6}$'),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS workspaces (
  id          uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text COLLATE "C" NOT NULL
                              CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
                              CHECK (length(slug) <= 64),
  name        text            NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_by  uuid            NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  version     integer         NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz     NOT NULL DEFAULT now(),
  updated_at  timestamptz     NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_live_key
  ON workspaces (slug) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS workspaces_set_updated_at ON workspaces;
CREATE TRIGGER workspaces_set_updated_at BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         member_role NOT NULL DEFAULT 'viewer',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx
  ON workspace_members (user_id, workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_owner_idx
  ON workspace_members (workspace_id) WHERE role = 'owner';

DROP TRIGGER IF EXISTS workspace_members_set_updated_at ON workspace_members;
CREATE TRIGGER workspace_members_set_updated_at BEFORE UPDATE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
