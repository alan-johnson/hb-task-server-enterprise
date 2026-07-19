-- Flyway migration. Filename convention: V<version>__<description>.sql
-- Versions run in order, exactly once, tracked in the flyway_schema_history table.
--
-- Adds live manual bucket-override state for drag-and-drop task moves between
-- Now/Next/Later. Classification is otherwise computed on every read from
-- dueDate/priority against the caller's rules (see src/classification/classify.js)
-- — this table lets a user pin a task to a bucket regardless of what the rules
-- would compute, until the task's dueDate or priority changes (checked via
-- due_date_snapshot/priority_snapshot on read; see src/classification/overrideService.js).
--
-- Distinct from triage_feedback_events (V5): that's an append-only signal log for
-- future calibration; this is the queryable "what bucket is this task pinned to
-- right now" table that annotateClassification() actually reads from.

-- user_id(255)+provider(50)+list_id(255)+task_id(255) as a composite PRIMARY
-- KEY would be 815 chars * 4 bytes (utf8mb4) = 3260 bytes, over InnoDB's
-- 3072-byte index limit (confirmed by ER_TOO_LONG_KEY against a real local
-- MySQL 8 instance, not just calculated) — hence the surrogate `id` PK below
-- with the natural key as a UNIQUE KEY instead, and list_id/task_id capped at
-- 200 chars (well above real Microsoft Graph / Google Tasks / Apple bridge /
-- sandbox provider ID lengths) to bring the composite under the limit.

CREATE TABLE IF NOT EXISTS task_bucket_overrides (
    id                 BIGINT AUTO_INCREMENT NOT NULL,
    user_id            VARCHAR(255) NOT NULL,
    provider           VARCHAR(50)  NOT NULL,
    list_id            VARCHAR(200) NOT NULL,
    task_id            VARCHAR(200) NOT NULL,
    bucket             VARCHAR(20)  NOT NULL,  -- now | next | later
    due_date_snapshot  VARCHAR(64),            -- task.dueDate at override time
    priority_snapshot  VARCHAR(20),            -- task.priority at override time
    created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY idx_tbo_lookup (user_id, provider, list_id, task_id),
    CONSTRAINT fk_tbo_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
