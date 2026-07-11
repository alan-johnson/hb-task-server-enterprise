const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { pool, encrypt, decrypt } = require('../db/db');
const cache = require('../db/cache');

// MySQL DATETIME(3) requires 'YYYY-MM-DD HH:MM:SS.mmm', not ISO 8601 'Z' format.
function toMySQL(date) {
  return new Date(date).toISOString().replace('T', ' ').replace('Z', '');
}

class UserService {
  // server.js passes (process.env.DATA_DIR || './data') — accepted but ignored.
  constructor(_ignoredDataDir) {}

  async initialize() {
    try {
      await this._createTablesIfNeeded();
      console.log('UserService: connected to MySQL');
    } catch (error) {
      console.error('Failed to initialize UserService:', error.message);
      throw error;
    }
  }

  async _createTablesIfNeeded() {
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    const sql = await fs.readFile(schemaPath, 'utf-8');
    // Execute each statement individually (mysql2 does not support multi-statement execute)
    const statements = sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    // Idempotent migration: add subscription date columns if missing
    const cols = await pool.query("SHOW COLUMNS FROM users LIKE 'subscription_period_end'");
    if (cols.rows.length === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN subscription_period_end DATETIME(3)');
      await pool.query('ALTER TABLE users ADD COLUMN trial_end DATETIME(3)');
      await pool.query('ALTER TABLE users ADD COLUMN trial_warning_sent_at DATETIME(3)');
    }
  }

  // ---------- register ----------

  async register(username, password, email) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = Date.now().toString() + Math.random().toString(36).substring(2);
    const createdAt = toMySQL(new Date());

    try {
      await pool.query(
        `INSERT INTO users (user_id, username, email, password_hash, created_at, default_provider)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, username, email || null, hashedPassword, createdAt, 'microsoft']
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new Error('Username already exists');
      throw err;
    }

    const user = {
      userId,
      username,
      email:           email || null,
      passwordHash:    hashedPassword,
      createdAt,
      defaultProvider: 'microsoft',
    };
    await cache.set(`user:id:${userId}`,       JSON.stringify(user));
    await cache.set(`user:name:${username}`,   JSON.stringify(user));

    return { userId, username, email: user.email, createdAt };
  }

  // ---------- authenticate ----------

  async authenticate(username, password) {
    let user = await this._getUserByUsername(username);
    if (!user) throw new Error('Invalid username or password');

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) throw new Error('Invalid username or password');

    if (!user.emailVerified) {
      const err = new Error('Please verify your email address before signing in.');
      err.code = 'EMAIL_NOT_VERIFIED';
      throw err;
    }

    return { userId: user.userId, username: user.username, email: user.email };
  }

  // ---------- getUser ----------

  async getUser(userId) {
    const cached = await cache.get(`user:id:${userId}`);
    if (cached) {
      const u = JSON.parse(cached);
      return { userId: u.userId, username: u.username, email: u.email, defaultProvider: u.defaultProvider, showCompleted: u.showCompleted, stripeCustomerId: u.stripeCustomerId, subscriptionStatus: u.subscriptionStatus, subscriptionPeriodEnd: u.subscriptionPeriodEnd, trialEnd: u.trialEnd, trialWarningSentAt: u.trialWarningSentAt };
    }

    const result = await pool.query(
      'SELECT user_id, username, email, password_hash, created_at, default_provider, show_completed, stripe_customer_id, subscription_status, subscription_period_end, trial_end, trial_warning_sent_at, email_verified FROM users WHERE user_id = ?',
      [userId]
    );
    if (!result.rows[0]) return null;

    const user = this._mapRow(result.rows[0]);
    await cache.set(`user:id:${userId}`,             JSON.stringify(user));
    await cache.set(`user:name:${user.username}`,    JSON.stringify(user));

    return { userId: user.userId, username: user.username, email: user.email, defaultProvider: user.defaultProvider, showCompleted: user.showCompleted, stripeCustomerId: user.stripeCustomerId, subscriptionStatus: user.subscriptionStatus, subscriptionPeriodEnd: user.subscriptionPeriodEnd, trialEnd: user.trialEnd, trialWarningSentAt: user.trialWarningSentAt };
  }

  // ---------- storeCredentials ----------

  async storeCredentials(userId, provider, credentials) {
    const updatedAt = toMySQL(new Date());
    await pool.query(
      `INSERT INTO user_credentials (user_id, provider, access_token, refresh_token, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = VALUES(refresh_token),
         updated_at    = VALUES(updated_at)`,
      [userId, provider, encrypt(credentials.accessToken || null), encrypt(credentials.refreshToken || null), updatedAt]
    );

    await cache.set(`creds:${userId}:${provider}`, JSON.stringify({
      accessToken:  encrypt(credentials.accessToken  || null),
      refreshToken: encrypt(credentials.refreshToken || null),
      updatedAt,
    }));
  }

  // ---------- getCredentials ----------

  async getCredentials(userId, provider) {
    const cached = await cache.get(`creds:${userId}:${provider}`);
    if (cached) {
      const c = JSON.parse(cached);
      return {
        accessToken:  decrypt(c.accessToken),
        refreshToken: decrypt(c.refreshToken),
        updatedAt:    c.updatedAt,
      };
    }

    const result = await pool.query(
      'SELECT access_token, refresh_token, updated_at FROM user_credentials WHERE user_id = ? AND provider = ?',
      [userId, provider]
    );
    if (!result.rows[0]) return null;

    const row = result.rows[0];
    const creds = {
      accessToken:  decrypt(row.access_token),
      refreshToken: decrypt(row.refresh_token),
      updatedAt:    new Date(row.updated_at).toISOString(),
    };
    await cache.set(`creds:${userId}:${provider}`, JSON.stringify({
      accessToken:  encrypt(creds.accessToken),
      refreshToken: encrypt(creds.refreshToken),
      updatedAt:    creds.updatedAt,
    }));
    return creds;
  }

  // ---------- removeCredentials ----------

  async removeCredentials(userId, provider) {
    const result = await pool.query(
      'DELETE FROM user_credentials WHERE user_id = ? AND provider = ?',
      [userId, provider]
    );
    if (result.rowCount > 0) {
      await cache.del(`creds:${userId}:${provider}`);
      return true;
    }
    return false;
  }

  // ---------- updateDefaultProvider ----------

  async updateDefaultProvider(userId, provider) {
    const result = await pool.query(
      'UPDATE users SET default_provider = ? WHERE user_id = ?',
      [provider, userId]
    );
    if (result.rowCount > 0) {
      const sel = await pool.query('SELECT username FROM users WHERE user_id = ?', [userId]);
      const username = sel.rows[0]?.username;
      await cache.del(`user:id:${userId}`, `user:name:${username}`);
      return true;
    }
    return false;
  }

  // ---------- email verification ----------

  async createVerificationToken(userId) {
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await pool.query(
      'UPDATE users SET verification_token = ?, verification_token_expires = ? WHERE user_id = ?',
      [token, toMySQL(expires), userId]
    );
    // Invalidate cached user so the token is visible on next load
    const result = await pool.query('SELECT username FROM users WHERE user_id = ?', [userId]);
    if (result.rows[0]) {
      await cache.del(`user:id:${userId}`, `user:name:${result.rows[0].username}`);
    }
    return token;
  }

  async verifyEmailToken(token) {
    const result = await pool.query(
      `SELECT user_id, username, email, verification_token_expires
       FROM users
       WHERE verification_token = ? AND email_verified = FALSE`,
      [token]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Invalid or already used verification link.');
    if (new Date(row.verification_token_expires) < new Date()) {
      throw new Error('Verification link has expired. Please request a new one.');
    }
    await pool.query(
      `UPDATE users
       SET email_verified = TRUE, verification_token = NULL, verification_token_expires = NULL
       WHERE user_id = ?`,
      [row.user_id]
    );
    await cache.del(`user:id:${row.user_id}`, `user:name:${row.username}`);
    return { userId: row.user_id, username: row.username, email: row.email };
  }

  // Public alias used by the resend route
  async getUserByUsername(username) {
    return this._getUserByUsername(username);
  }

  // ---------- password reset ----------

  async createPasswordResetToken(email) {
    const result = await pool.query(
      'SELECT user_id, username, email, email_verified FROM users WHERE email = ?',
      [email]
    );
    const row = result.rows[0];
    // Return null silently if not found or not verified — caller shows a generic message
    if (!row || !row.email_verified) return null;

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      'UPDATE users SET password_reset_token = ?, password_reset_token_expires = ? WHERE user_id = ?',
      [token, toMySQL(expires), row.user_id]
    );
    await cache.del(`user:id:${row.user_id}`, `user:name:${row.username}`);
    return { token, username: row.username, email: row.email };
  }

  async resetPassword(token, newPassword) {
    const result = await pool.query(
      'SELECT user_id, username, password_reset_token_expires FROM users WHERE password_reset_token = ?',
      [token]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Invalid or already used reset link.');
    if (new Date(row.password_reset_token_expires) < new Date()) {
      throw new Error('Reset link has expired. Please request a new one.');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = ?, password_reset_token = NULL, password_reset_token_expires = NULL
       WHERE user_id = ?`,
      [passwordHash, row.user_id]
    );
    await cache.del(`user:id:${row.user_id}`, `user:name:${row.username}`);
    return { userId: row.user_id, username: row.username };
  }

  // ---------- delete account ----------

  async verifyPassword(userId, password) {
    const result = await pool.query('SELECT password_hash FROM users WHERE user_id = ?', [userId]);
    if (!result.rows[0]) return false;
    return bcrypt.compare(password, result.rows[0].password_hash);
  }

  // user_credentials and bridge_api_keys cascade via ON DELETE CASCADE (see
  // V1__initial_schema.sql) — deleting the users row is sufficient at the DB level.
  async deleteUser(userId) {
    const result = await pool.query('SELECT username FROM users WHERE user_id = ?', [userId]);
    if (!result.rows[0]) return false;
    const { username } = result.rows[0];
    await pool.query('DELETE FROM users WHERE user_id = ?', [userId]);
    await cache.del(`user:id:${userId}`, `user:name:${username}`);
    return true;
  }

  // ---------- private helpers ----------

  async _getUserByUsername(username) {
    const cached = await cache.get(`user:name:${username}`);
    if (cached) return JSON.parse(cached);

    const result = await pool.query(
      'SELECT user_id, username, email, password_hash, created_at, default_provider, show_completed, stripe_customer_id, subscription_status, subscription_period_end, trial_end, trial_warning_sent_at, email_verified FROM users WHERE username = ?',
      [username]
    );
    if (!result.rows[0]) return null;

    const user = this._mapRow(result.rows[0]);
    await cache.set(`user:name:${username}`,     JSON.stringify(user));
    await cache.set(`user:id:${user.userId}`,    JSON.stringify(user));
    return user;
  }

  // ---------- classification rules ----------

  async getClassificationRules(userId) {
    const cacheKey = `classrules:${userId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const result = await pool.query(
      'SELECT classification_rules FROM users WHERE user_id = ?',
      [userId]
    );
    const rules = result.rows[0]?.classification_rules || null;
    if (rules) await cache.set(cacheKey, JSON.stringify(rules));
    return rules;
  }

  async updateClassificationRules(userId, rules) {
    await pool.query(
      'UPDATE users SET classification_rules = ? WHERE user_id = ?',
      [JSON.stringify(rules), userId]
    );
    await cache.del(`classrules:${userId}`);
  }

  async resetClassificationRules(userId) {
    await pool.query(
      'UPDATE users SET classification_rules = NULL WHERE user_id = ?',
      [userId]
    );
    await cache.del(`classrules:${userId}`);
  }

  async updatePreferences(userId, { showCompleted }) {
    const result = await pool.query(
      'UPDATE users SET show_completed = ? WHERE user_id = ?',
      [showCompleted, userId]
    );
    if (result.rowCount > 0) {
      const sel = await pool.query('SELECT username FROM users WHERE user_id = ?', [userId]);
      const username = sel.rows[0]?.username;
      await cache.del(`user:id:${userId}`, `user:name:${username}`);
      return true;
    }
    return false;
  }

  // ---------- bridge API keys ----------

  async generateBridgeApiKey(userId) {
    const key = crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    await pool.query(
      `INSERT INTO bridge_api_keys (user_id, key_hash, created_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE key_hash = VALUES(key_hash), created_at = NOW()`,
      [userId, keyHash]
    );
    return key;
  }

  async getUserIdByBridgeApiKey(apiKey) {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const result = await pool.query(
      'SELECT user_id FROM bridge_api_keys WHERE key_hash = ?',
      [keyHash]
    );
    return result.rows[0]?.user_id || null;
  }

  async revokeBridgeApiKey(userId) {
    const result = await pool.query(
      'DELETE FROM bridge_api_keys WHERE user_id = ?',
      [userId]
    );
    return result.rowCount > 0;
  }

  async hasBridgeApiKey(userId) {
    const result = await pool.query(
      'SELECT 1 FROM bridge_api_keys WHERE user_id = ?',
      [userId]
    );
    return result.rowCount > 0;
  }

  // ---------- subscription ----------

  async updateSubscription(userId, stripeCustomerId, status, periodEnd = null, trialEnd = null) {
    const periodEndVal = periodEnd ? toMySQL(periodEnd) : null;
    const trialEndVal  = trialEnd  ? toMySQL(trialEnd)  : null;
    await pool.query(
      `UPDATE users SET
         stripe_customer_id = ?,
         subscription_status = ?,
         subscription_period_end = ?,
         trial_end = ?,
         trial_warning_sent_at = CASE WHEN ? = 'trialing' THEN NULL ELSE trial_warning_sent_at END
       WHERE user_id = ?`,
      [stripeCustomerId, status, periodEndVal, trialEndVal, status, userId]
    );
    await cache.del(`user:id:${userId}`);
    const result = await pool.query('SELECT username FROM users WHERE user_id = ?', [userId]);
    if (result.rows[0]) await cache.del(`user:name:${result.rows[0].username}`);
  }

  async getUserByStripeCustomerId(customerId) {
    const result = await pool.query(
      'SELECT user_id, username, email, subscription_status, subscription_period_end, trial_end, trial_warning_sent_at, stripe_customer_id FROM users WHERE stripe_customer_id = ?',
      [customerId]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      userId:                 row.user_id,
      username:               row.username,
      email:                  row.email,
      stripeCustomerId:       row.stripe_customer_id,
      subscriptionStatus:     row.subscription_status || 'none',
      subscriptionPeriodEnd:  row.subscription_period_end ? new Date(row.subscription_period_end).toISOString() : null,
      trialEnd:               row.trial_end               ? new Date(row.trial_end).toISOString()               : null,
      trialWarningSentAt:     row.trial_warning_sent_at   ? new Date(row.trial_warning_sent_at).toISOString()   : null,
    };
  }

  _mapRow(row) {
    return {
      userId:                row.user_id,
      username:              row.username,
      email:                 row.email,
      passwordHash:          row.password_hash,
      createdAt:             new Date(row.created_at).toISOString(),
      defaultProvider:       row.default_provider,
      showCompleted:         !!row.show_completed,
      stripeCustomerId:      row.stripe_customer_id        || null,
      subscriptionStatus:    row.subscription_status       || 'none',
      subscriptionPeriodEnd: row.subscription_period_end   ? new Date(row.subscription_period_end).toISOString() : null,
      trialEnd:              row.trial_end                  ? new Date(row.trial_end).toISOString()               : null,
      trialWarningSentAt:    row.trial_warning_sent_at      ? new Date(row.trial_warning_sent_at).toISOString()   : null,
      emailVerified:         !!row.email_verified,
    };
  }
}

module.exports = UserService;
