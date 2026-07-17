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
