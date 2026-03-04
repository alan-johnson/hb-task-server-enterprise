const bcrypt = require('bcrypt');
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
        [userId, username, email || null, hashedPassword, createdAt, 'apple']
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
      defaultProvider: 'apple',
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

    return { userId: user.userId, username: user.username, email: user.email };
  }

  // ---------- getUser ----------

  async getUser(userId) {
    const cached = await cache.get(`user:id:${userId}`);
    if (cached) {
      const u = JSON.parse(cached);
      return { userId: u.userId, username: u.username, email: u.email, defaultProvider: u.defaultProvider };
    }

    const result = await pool.query(
      'SELECT user_id, username, email, password_hash, created_at, default_provider FROM users WHERE user_id = $1',
      [userId]
    );
    if (!result.rows[0]) return null;

    const user = this._mapRow(result.rows[0]);
    await cache.set(`user:id:${userId}`,             JSON.stringify(user));
    await cache.set(`user:name:${user.username}`,    JSON.stringify(user));

    return { userId: user.userId, username: user.username, email: user.email, defaultProvider: user.defaultProvider };
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

  // ---------- private helpers ----------

  async _getUserByUsername(username) {
    const cached = await cache.get(`user:name:${username}`);
    if (cached) return JSON.parse(cached);

    const result = await pool.query(
      'SELECT user_id, username, email, password_hash, created_at, default_provider FROM users WHERE username = $1',
      [username]
    );
    if (!result.rows[0]) return null;

    const user = this._mapRow(result.rows[0]);
    await cache.set(`user:name:${username}`,     JSON.stringify(user));
    await cache.set(`user:id:${user.userId}`,    JSON.stringify(user));
    return user;
  }

  _mapRow(row) {
    return {
      userId:          row.user_id,
      username:        row.username,
      email:           row.email,
      passwordHash:    row.password_hash,
      createdAt:       row.created_at.toISOString(),
      defaultProvider: row.default_provider,
    };
  }
}

module.exports = UserService;
