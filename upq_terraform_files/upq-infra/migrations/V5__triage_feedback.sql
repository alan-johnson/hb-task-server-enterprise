-- Flyway migration. Filename convention: V<version>__<description>.sql
-- Versions run in order, exactly once, tracked in the flyway_schema_history table.
--
-- Adds the triage feedback signal log (see docs/triage-engine-implementation-plan.md,
-- Phase 4 §6, subsection 4a — signal collection only). This is an append-only event
-- log, not a queryable "current state" table; see V6__task_bucket_overrides.sql for
-- the table that actually drives live classification.
--
-- Only the bucket_override signal_type is written today (from the drag-and-drop
-- bucket-move feature). explicit_correction / snooze / completion_timing are not
-- yet produced by any route — the column allows for them without a schema change
-- when/if those are built.

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
