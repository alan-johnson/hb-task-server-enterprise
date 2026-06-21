-- Flyway migration. Filename convention: V<version>__<description>.sql
-- Versions run in order, exactly once, tracked in the flyway_schema_history table.

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
