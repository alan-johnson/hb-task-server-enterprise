-- Flyway migration. Filename convention: V<version>__<description>.sql
-- Versions run in order, exactly once, tracked in the flyway_schema_history table.
--
-- Adds the system-wide default classification rules table (see
-- docs/triage-engine-implementation-plan.md, Phase 0). Replaces the boot-time
-- TOML file (config/classification.toml) as the source of the server-wide
-- default ruleset used when a user has no custom rules of their own.
--
-- id='global' is the single system-wide default row, guaranteed unique by
-- being the primary key (not by a UNIQUE KEY on org_id — MySQL/InnoDB allows
-- multiple NULLs in a unique index, so a NULL-based uniqueness constraint
-- would not actually have prevented a second global-default row). org_id
-- is reserved, unused, for a future per-org enterprise default — out of
-- scope for this migration.

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
        'now',   JSON_OBJECT('label', 'Now',   'overdue', true, 'priorities', JSON_ARRAY('high')),
        'next',  JSON_OBJECT('label', 'Next',  'future_due', true, 'priorities', JSON_ARRAY('normal')),
        'later', JSON_OBJECT('label', 'Later')
    ),
    NULL
);
