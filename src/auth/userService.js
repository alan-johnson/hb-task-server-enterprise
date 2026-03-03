const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const path = require('path');
const { pool, encrypt, decrypt } = require('../db/db');

class UserService {
  // server.js passes (process.env.DATA_DIR || './data') — accepted but ignored.
  constructor(_ignoredDataDir) {
    // In-memory caches populated by initialize() and kept in sync on every write.
    // This allows getUser() and getCredentials() to remain synchronous.
    this.users = new Map();           // username -> user object
    this.userCredentials = new Map(); // userId   -> { provider -> credentials }
  }

  async initialize() {
    try {
      await this._createTablesIfNeeded();
      await this._loadCache();
      console.log('UserService: connected to PostgreSQL, cache loaded');
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

  async _loadCache() {
    const usersResult = await pool.query(
      'SELECT user_id, username, email, password_hash, created_at, default_provider FROM users'
    );
    this.users = new Map();
    for (const row of usersResult.rows) {
      this.users.set(row.username, {
        userId:          row.user_id,
        username:        row.username,
        email:           row.email,
        passwordHash:    row.password_hash,
        createdAt:       row.created_at.toISOString(),
        defaultProvider: row.default_provider,
      });
    }

    const credsResult = await pool.query(
      'SELECT user_id, provider, access_token, refresh_token, updated_at FROM user_credentials'
    );
    this.userCredentials = new Map();
    for (const row of credsResult.rows) {
      if (!this.userCredentials.has(row.user_id)) {
        this.userCredentials.set(row.user_id, {});
      }
      this.userCredentials.get(row.user_id)[row.provider] = {
        accessToken:  decrypt(row.access_token),
        refreshToken: decrypt(row.refresh_token),
        updatedAt:    row.updated_at.toISOString(),
      };
    }
  }

  async register(username, password, email) {
    if (this.users.has(username)) {
      throw new Error('Username already exists');
    }

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
    this.users.set(username, user);
    this.userCredentials.set(userId, {});

    return { userId, username, email: user.email, createdAt };
  }

  async authenticate(username, password) {
    const user = this.users.get(username);
    if (!user) throw new Error('Invalid username or password');

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) throw new Error('Invalid username or password');

    return { userId: user.userId, username: user.username, email: user.email };
  }

  getUser(userId) {
    for (const user of this.users.values()) {
      if (user.userId === userId) {
        return {
          userId:          user.userId,
          username:        user.username,
          email:           user.email,
          defaultProvider: user.defaultProvider,
        };
      }
    }
    return null;
  }

  async storeCredentials(userId, provider, credentials) {
    const updatedAt = new Date().toISOString();
    const encAccessToken  = encrypt(credentials.accessToken  || null);
    const encRefreshToken = encrypt(credentials.refreshToken || null);

    await pool.query(
      `INSERT INTO user_credentials (user_id, provider, access_token, refresh_token, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token  = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         updated_at    = EXCLUDED.updated_at`,
      [userId, provider, encAccessToken, encRefreshToken, updatedAt]
    );

    if (!this.userCredentials.has(userId)) {
      this.userCredentials.set(userId, {});
    }
    this.userCredentials.get(userId)[provider] = {
      accessToken:  credentials.accessToken  || null,
      refreshToken: credentials.refreshToken || null,
      updatedAt,
    };
  }

  getCredentials(userId, provider) {
    const userCreds = this.userCredentials.get(userId);
    if (!userCreds) return null;
    return userCreds[provider] || null;
  }

  async removeCredentials(userId, provider) {
    const result = await pool.query(
      'DELETE FROM user_credentials WHERE user_id = $1 AND provider = $2',
      [userId, provider]
    );

    if (result.rowCount > 0) {
      const userCreds = this.userCredentials.get(userId);
      if (userCreds) delete userCreds[provider];
      return true;
    }
    return false;
  }

  async updateDefaultProvider(userId, provider) {
    const result = await pool.query(
      'UPDATE users SET default_provider = $2 WHERE user_id = $1',
      [userId, provider]
    );

    if (result.rowCount > 0) {
      for (const user of this.users.values()) {
        if (user.userId === userId) {
          user.defaultProvider = provider;
          break;
        }
      }
      return true;
    }
    return false;
  }
}

module.exports = UserService;
