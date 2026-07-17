-- Flyway migration. Filename convention: V<version>__<description>.sql
-- Versions run in order, exactly once, tracked in the flyway_schema_history table.
--
-- Adds tables for the developer REST API / MCP beta:
-- api_keys (machine-client credentials), idempotency_keys (write dedup),
-- api_usage_events (triage-vs-retention instrumentation).

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
