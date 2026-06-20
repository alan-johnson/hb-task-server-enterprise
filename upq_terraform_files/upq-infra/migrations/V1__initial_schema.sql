-- Flyway migration. Filename convention: V<version>__<description>.sql
-- Versions run in order, exactly once, tracked in the flyway_schema_history table.
-- This is plain MySQL DDL — no ORM, exactly your workflow.

CREATE TABLE IF NOT EXISTS users (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email         VARCHAR(255)    NOT NULL,
    password_hash VARCHAR(255)    NOT NULL,
    stripe_customer_id VARCHAR(64) DEFAULT NULL,
    created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subscriptions (
    id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id                BIGINT UNSIGNED NOT NULL,
    stripe_subscription_id VARCHAR(64)     NOT NULL,
    status                 VARCHAR(32)     NOT NULL,
    current_period_end     TIMESTAMP       NULL,
    created_at             TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sub_stripe (stripe_subscription_id),
    KEY idx_sub_user (user_id),
    CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
