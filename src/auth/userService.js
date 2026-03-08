const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { pool, encrypt, decrypt } = require('../db/db');
const cache = require('../db/cache');

class UserService {
  // server.js passes (process.env.DATA_DIR || './data') — accepted but ignored.
  constructor(_ignoredDataDir) {}

  async initialize() {
    try {
      await this._createTablesIfNeeded();
      console.log('UserService: connected to PostgreSQL');
    } catch (error) {
      console.error('Failed to initialize UserService:', error.message);
      throw error;
    }
  }

  async _createTablesIfNeeded() {
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    const sql = await fs.readFile(schemaPath, 'utf-8');
    await pool.query(sql);
  }

  // ---------- register ----------

  async register(username, password, email) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = Date.now().toString() + Math.random().toString(36).substring(2);
    const createdAt = new Date().toISOString();

    try {
      await pool.query(
        `INSERT INTO users (user_id, username, email, password_hash, created_at, default_provider)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, username, email || null, hashedPassword, createdAt, 'microsoft']
      );
    } catch (err) {
      if (err.code === '23505') throw new Error('Username already exists');
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
      return { userId: u.userId, username: u.username, email: u.email, defaultProvider: u.defaultProvider, showCompleted: u.showCompleted };
    }

    const result = await pool.query(
      'SELECT user_id, username, email, password_hash, created_at, default_provider, show_completed, stripe_customer_id, subscription_status, email_verified FROM users WHERE user_id = $1',
      [userId]
    );
    if (!result.rows[0]) return null;

    const user = this._mapRow(result.rows[0]);
    await cache.set(`user:id:${userId}`,             JSON.stringify(user));
    await cache.set(`user:name:${user.username}`,    JSON.stringify(user));

    return { userId: user.userId, username: user.username, email: user.email, defaultProvider: user.defaultProvider, showCompleted: user.showCompleted, stripeCustomerId: user.stripeCustomerId, subscriptionStatus: user.subscriptionStatus };
  }

  // ---------- storeCredentials ----------

  async storeCredentials(userId, provider, credentials) {
    const updatedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO user_credentials (user_id, provider, access_token, refresh_token, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token  = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         updated_at    = EXCLUDED.updated_at`,
      [userId, provider, encrypt(credentials.accessToken || null), encrypt(credentials.refreshToken || null), updatedAt]
    );

    const creds = {
      accessToken:  credentials.accessToken  || null,
      refreshToken: credentials.refreshToken || null,
      updatedAt,
    };
    await cache.set(`creds:${userId}:${provider}`, JSON.stringify(creds));
  }

  // ---------- getCredentials ----------

  async getCredentials(userId, provider) {
    const cached = await cache.get(`creds:${userId}:${provider}`);
    if (cached) return JSON.parse(cached);

    const result = await pool.query(
      'SELECT access_token, refresh_token, updated_at FROM user_credentials WHERE user_id = $1 AND provider = $2',
      [userId, provider]
    );
    if (!result.rows[0]) return null;

    const row = result.rows[0];
    const creds = {
      accessToken:  decrypt(row.access_token),
      refreshToken: decrypt(row.refresh_token),
      updatedAt:    row.updated_at.toISOString(),
    };
    await cache.set(`creds:${userId}:${provider}`, JSON.stringify(creds));
    return creds;
  }

  // ---------- removeCredentials ----------

  async removeCredentials(userId, provider) {
    const result = await pool.query(
      'DELETE FROM user_credentials WHERE user_id = $1 AND provider = $2',
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
      'UPDATE users SET default_provider = $2 WHERE user_id = $1 RETURNING username',
      [userId, provider]
    );
    if (result.rowCount > 0) {
      const username = result.rows[0].username;
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
      'UPDATE users SET verification_token = $2, verification_token_expires = $3 WHERE user_id = $1',
      [userId, token, expires.toISOString()]
    );
    // Invalidate cached user so the token is visible on next load
    const result = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
    if (result.rows[0]) {
      await cache.del(`user:id:${userId}`, `user:name:${result.rows[0].username}`);
    }
    return token;
  }

  async verifyEmailToken(token) {
    const result = await pool.query(
      `SELECT user_id, username, email, verification_token_expires
       FROM users
       WHERE verification_token = $1 AND email_verified = FALSE`,
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
       WHERE user_id = $1`,
      [row.user_id]
    );
    await cache.del(`user:id:${row.user_id}`, `user:name:${row.username}`);
    return { userId: row.user_id, username: row.username, email: row.email };
  }

  // Public alias used by the resend route
  async getUserByUsername(username) {
    return this._getUserByUsername(username);
  }

  // ---------- private helpers ----------

  async _getUserByUsername(username) {
    const cached = await cache.get(`user:name:${username}`);
    if (cached) return JSON.parse(cached);

    const result = await pool.query(
      'SELECT user_id, username, email, password_hash, created_at, default_provider, show_completed, stripe_customer_id, subscription_status, email_verified FROM users WHERE username = $1',
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
      'SELECT classification_rules FROM users WHERE user_id = $1',
      [userId]
    );
    const rules = result.rows[0]?.classification_rules || null;
    if (rules) await cache.set(cacheKey, JSON.stringify(rules));
    return rules;
  }

  async updateClassificationRules(userId, rules) {
    await pool.query(
      'UPDATE users SET classification_rules = $2 WHERE user_id = $1',
      [userId, JSON.stringify(rules)]
    );
    await cache.del(`classrules:${userId}`);
  }

  async resetClassificationRules(userId) {
    await pool.query(
      'UPDATE users SET classification_rules = NULL WHERE user_id = $1',
      [userId]
    );
    await cache.del(`classrules:${userId}`);
  }

  async updatePreferences(userId, { showCompleted }) {
    const result = await pool.query(
      'UPDATE users SET show_completed = $2 WHERE user_id = $1 RETURNING username',
      [userId, showCompleted]
    );
    if (result.rowCount > 0) {
      const username = result.rows[0].username;
      await cache.del(`user:id:${userId}`, `user:name:${username}`);
      return true;
    }
    return false;
  }

  async updateSubscription(userId, stripeCustomerId, status) {
    await pool.query(
      'UPDATE users SET stripe_customer_id = $2, subscription_status = $3 WHERE user_id = $1',
      [userId, stripeCustomerId, status]
    );
    await cache.del(`user:id:${userId}`);
    const result = await pool.query('SELECT username FROM users WHERE user_id = $1', [userId]);
    if (result.rows[0]) await cache.del(`user:name:${result.rows[0].username}`);
  }

  _mapRow(row) {
    return {
      userId:             row.user_id,
      username:           row.username,
      email:              row.email,
      passwordHash:       row.password_hash,
      createdAt:          row.created_at.toISOString(),
      defaultProvider:    row.default_provider,
      showCompleted:      row.show_completed,
      stripeCustomerId:   row.stripe_customer_id  || null,
      subscriptionStatus: row.subscription_status || 'none',
      emailVerified:      row.email_verified       ?? false,
    };
  }
}

module.exports = UserService;
