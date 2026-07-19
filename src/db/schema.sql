-- hb-task-server-enterprise database schema
-- MySQL 8+

CREATE TABLE IF NOT EXISTS users (
    user_id                       VARCHAR(255) NOT NULL,
    username                      VARCHAR(255) NOT NULL,
    email                         VARCHAR(255),
    password_hash                 VARCHAR(255) NOT NULL,
    created_at                    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    default_provider              VARCHAR(50)  NOT NULL DEFAULT 'apple',
    show_completed                BOOLEAN      NOT NULL DEFAULT FALSE,
    classification_rules          JSON,
    stripe_customer_id            VARCHAR(255),
    subscription_status           VARCHAR(50)  NOT NULL DEFAULT 'none',
    subscription_period_end       DATETIME(3),
    trial_end                     DATETIME(3),
    trial_warning_sent_at         DATETIME(3),
    email_verified                BOOLEAN      NOT NULL DEFAULT FALSE,
    verification_token            VARCHAR(255),
    verification_token_expires    DATETIME(3),
    password_reset_token          VARCHAR(255),
    password_reset_token_expires  DATETIME(3),
    PRIMARY KEY (user_id),
    UNIQUE KEY idx_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_credentials (
    user_id       VARCHAR(255) NOT NULL,
    provider      VARCHAR(50)  NOT NULL,
    access_token  TEXT         NOT NULL,
    refresh_token TEXT,
    updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (user_id, provider),
    KEY idx_user_credentials_user_id (user_id),
    CONSTRAINT fk_uc_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bridge_api_keys (
    user_id    VARCHAR(255) NOT NULL,
    key_hash   VARCHAR(255) NOT NULL,
    created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (user_id),
    CONSTRAINT fk_bak_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Developer REST API / MCP beta (see V2__beta_api_tables.sql — keep in sync)

CREATE TABLE IF NOT EXISTS api_keys (
    id           VARCHAR(36)  NOT NULL,
    user_id      VARCHAR(255) NOT NULL,
    name         VARCHAR(255) NOT NULL DEFAULT 'default',
    key_prefix   VARCHAR(24)  NOT NULL,
    key_hash     VARCHAR(255) NOT NULL,
    scopes       VARCHAR(255) NOT NULL DEFAULT 'tasks:read,tasks:write',
    sandbox      BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_used_at DATETIME(3),
    revoked_at   DATETIME(3),
    PRIMARY KEY (id),
    KEY idx_api_keys_user_id (user_id),
    KEY idx_api_keys_key_hash (key_hash),
    CONSTRAINT fk_ak_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id               VARCHAR(36)  NOT NULL,
    user_id          VARCHAR(255) NOT NULL,
    idempotency_key  VARCHAR(255) NOT NULL,
    request_hash     VARCHAR(64)  NOT NULL,
    response_status  SMALLINT     NOT NULL,
    response_body    JSON         NOT NULL,
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY idx_idem_user_key (user_id, idempotency_key),
    CONSTRAINT fk_idem_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_usage_events (
    id          BIGINT AUTO_INCREMENT NOT NULL,
    user_id     VARCHAR(255) NOT NULL,
    api_key_id  VARCHAR(36),
    endpoint    VARCHAR(255) NOT NULL,
    category    VARCHAR(20)  NOT NULL,
    status_code SMALLINT     NOT NULL,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_usage_user_created (user_id, created_at),
    KEY idx_usage_category (category, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Triage engine (see docs/triage-engine-implementation-plan.md, Phase 0/1 —
-- V3__system_default_rules.sql + V4__system_default_to_predicate_tree.sql,
-- keep in sync). The seed below reflects the post-V4 state (schemaVersion:2
-- predicate tree) so a fresh install from this file matches an environment
-- that ran both migrations in order — behaviorally identical to the
-- original legacy-shape default: overdue-or-high-priority => now;
-- future-due-or-normal-priority => next; everything else => later.

CREATE TABLE IF NOT EXISTS system_classification_defaults (
    id          VARCHAR(36)  NOT NULL,
    org_id      VARCHAR(255) DEFAULT NULL,
    rules       JSON         NOT NULL,
    updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    updated_by  VARCHAR(255),
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO system_classification_defaults (id, org_id, rules, updated_by)
VALUES (
    'global',
    NULL,
    JSON_OBJECT(
        'schemaVersion', 2,
        'now', JSON_OBJECT('any', JSON_ARRAY(
                   JSON_OBJECT('field', 'dueDate', 'op', 'overdue'),
                   JSON_OBJECT('field', 'priority', 'op', 'eq', 'value', 'high')
               )),
        'next', JSON_OBJECT('any', JSON_ARRAY(
                   JSON_OBJECT('field', 'dueDate', 'op', 'future_due'),
                   JSON_OBJECT('field', 'priority', 'op', 'eq', 'value', 'normal')
               )),
        'later', JSON_OBJECT()
    ),
    'migration:V4'
);

-- Triage feedback signal log (see docs/triage-engine-implementation-plan.md,
-- Phase 4 §6, subsection 4a — signal collection only; see V5__triage_feedback.sql).
-- Append-only. Only bucket_override is written today (drag-and-drop bucket moves).

CREATE TABLE IF NOT EXISTS triage_feedback_events (
    id          BIGINT AUTO_INCREMENT NOT NULL,
    user_id     VARCHAR(255) NOT NULL,
    task_id     VARCHAR(255) NOT NULL,
    signal_type VARCHAR(30)  NOT NULL,  -- explicit_correction | bucket_override | snooze | completion_timing
    predicted   VARCHAR(20),
    observed    VARCHAR(20),
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_feedback_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Live manual bucket-override state for drag-and-drop task moves (see
-- V6__task_bucket_overrides.sql). Distinct from triage_feedback_events above:
-- this is the queryable "what bucket is this task pinned to right now" table
-- that annotateClassification() reads from; the feedback table is an
-- append-only log. Cleared (see src/classification/overrideService.js) when
-- due_date_snapshot/priority_snapshot no longer match the task's live values.
--
-- Surrogate `id` PRIMARY KEY, natural key as a UNIQUE KEY instead: a
-- composite PRIMARY KEY of user_id(255)+provider(50)+list_id(255)+task_id(255)
-- is 815 chars * 4 bytes (utf8mb4) = 3260 bytes, over InnoDB's 3072-byte
-- index limit (ER_TOO_LONG_KEY, hit against a real MySQL 8 instance) —
-- list_id/task_id are also capped at 200 chars to bring the composite under
-- the limit, well above real Microsoft Graph / Google Tasks / Apple bridge /
-- sandbox provider ID lengths.

CREATE TABLE IF NOT EXISTS task_bucket_overrides (
    id                 BIGINT AUTO_INCREMENT NOT NULL,
    user_id            VARCHAR(255) NOT NULL,
    provider           VARCHAR(50)  NOT NULL,
    list_id            VARCHAR(200) NOT NULL,
    task_id            VARCHAR(200) NOT NULL,
    bucket             VARCHAR(20)  NOT NULL,  -- now | next | later
    due_date_snapshot  VARCHAR(64),
    priority_snapshot  VARCHAR(20),
    created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY idx_tbo_lookup (user_id, provider, list_id, task_id),
    CONSTRAINT fk_tbo_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
