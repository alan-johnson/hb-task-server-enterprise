-- hb-task-server-enterprise database schema
-- PostgreSQL 18

CREATE TABLE IF NOT EXISTS users (
    user_id          TEXT PRIMARY KEY,
    username         TEXT NOT NULL UNIQUE,
    email            TEXT,
    password_hash    TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    default_provider TEXT NOT NULL DEFAULT 'apple'
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

ALTER TABLE users ADD COLUMN IF NOT EXISTS show_completed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS user_credentials (
    user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider      TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
