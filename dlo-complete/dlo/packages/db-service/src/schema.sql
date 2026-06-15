-- DLO Pipeline Database Schema
-- MariaDB/MySQL compatible

CREATE TABLE IF NOT EXISTS pipelines (
  id VARCHAR(36) PRIMARY KEY COMMENT 'UUID',
  project_name VARCHAR(255) NOT NULL COMMENT 'User-provided project name',
  objectives_markdown LONGTEXT COMMENT 'User-provided objectives + steering notes appended',
  workspace_dir VARCHAR(500) COMMENT 'Absolute path to workspace directory',
  phase VARCHAR(50) NOT NULL COMMENT 'Current phase (INIT, RESEARCH_RUNNING, GATE1_PENDING, etc.)',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME COMMENT 'When pipeline finished (COMPLETED/FAILED/ABORTED)',
  config_json JSON COMMENT 'DloConfig',
  error_message TEXT COMMENT 'Last error if any',
  app_url VARCHAR(500) COMMENT 'e.g., http://localhost:3001',
  db_connection_string VARCHAR(500) COMMENT 'Runtime DB connection string',
  db_container_id VARCHAR(100) COMMENT 'Docker container ID for runtime DB',
  KEY idx_project_name (project_name),
  KEY idx_phase (phase),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_phase_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL,
  phase VARCHAR(50) NOT NULL COMMENT 'Phase transitioned to',
  transitioned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_id (pipeline_id),
  KEY idx_transitioned_at (transitioned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_gates (
  id VARCHAR(36) PRIMARY KEY COMMENT 'Gate UUID',
  pipeline_id VARCHAR(36) NOT NULL,
  gate_kind VARCHAR(50) NOT NULL COMMENT 'DOMAIN_DOCUMENT, TRIPARTITE_PLAN, TOOL_INSTALL_PERMISSION, TERMINAL_PERMISSION, MODULE_ESCALATION',
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING, RESOLVED, REJECTED',
  exhibits_json JSON COMMENT 'Human-readable exhibits shown to user',
  context_json JSON COMMENT 'Additional context (nextAction, toolsToInstall, etc.)',
  decision VARCHAR(50) COMMENT 'APPROVE, STEER, REJECT, USE_CLAUDE',
  decision_instructions TEXT COMMENT 'User instructions for STEER',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME COMMENT 'When gate was resolved',
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_id (pipeline_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_domain_documents (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL UNIQUE,
  markdown LONGTEXT NOT NULL COMMENT 'Full Gemini research markdown',
  citations_json JSON COMMENT 'Array of {url, title}',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_id (pipeline_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_plans (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL UNIQUE,
  ceo_plan TEXT COMMENT '1-2 sentence business summary',
  architecture_plan TEXT COMMENT '1-2 sentence technical summary',
  engineering_plan_json JSON NOT NULL COMMENT 'Full EngineeringPlan: modules with title, description, stackTarget, prompt, touches, exitClauses, dependsOn',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_id (pipeline_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_modules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL,
  module_id VARCHAR(50) NOT NULL COMMENT 'm1, m2, m3, etc.',
  title VARCHAR(255) COMMENT 'Module title from plan',
  status VARCHAR(20) NOT NULL COMMENT 'PENDING, EXECUTING, PASSED, FAILED, EXHAUSTED',
  attempts_count INT NOT NULL DEFAULT 0,
  spec_json JSON NOT NULL COMMENT 'Full EngineeringModule spec',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  UNIQUE KEY uc_pipeline_module (pipeline_id, module_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_module_attempts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL,
  module_id VARCHAR(50) NOT NULL,
  attempt_index INT NOT NULL COMMENT '1-based attempt number',
  executor VARCHAR(50) COMMENT 'claude or codewhale',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  verdict VARCHAR(10) COMMENT 'PASS or FAIL',
  summary TEXT COMMENT 'Short summary of what was done',
  changes_json JSON COMMENT 'Array of {file, description}',
  critique TEXT COMMENT 'Failure critique if verdict=FAIL',
  clause_results_json JSON COMMENT 'Array of exit clause results',
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_module (pipeline_id, module_id),
  KEY idx_verdict (verdict)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_artifacts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL,
  artifact_type VARCHAR(50) NOT NULL COMMENT 'DOMAIN, PLAN, HANDOFF, CONTEXT, SOURCE_FILE, TEST_OUTPUT',
  file_path VARCHAR(500) COMMENT 'Relative path within workspace (e.g., src/App.tsx)',
  content LONGTEXT NOT NULL COMMENT 'Full file content',
  metadata_json JSON COMMENT 'Additional metadata {size, language, ...}',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_type (pipeline_id, artifact_type),
  KEY idx_artifact_type (artifact_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_steering_notes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL,
  note TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_id (pipeline_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_test_results (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL,
  passed BOOLEAN NOT NULL,
  output LONGTEXT COMMENT 'Test output (truncated to 5000 chars)',
  duration_ms INT COMMENT 'Test duration in milliseconds',
  supervisor_reasoning TEXT COMMENT 'Claude supervisor override reasoning if any',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_id (pipeline_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pipeline_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  pipeline_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(100) NOT NULL COMMENT 'PHASE_TRANSITION, GATE_CREATED, GATE_RESOLVED, MODULE_STARTED, MODULE_COMPLETED, ARTIFACT_SAVED, etc.',
  event_data_json JSON COMMENT 'Event-specific data payload',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE,
  KEY idx_pipeline_id (pipeline_id),
  KEY idx_event_type (event_type),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
