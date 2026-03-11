const mysql = require('mysql2/promise');
const crypto = require('crypto');

// --- Connection Pool ---

const mysqlPool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 5000,
});

// Thin wrapper that mimics the pg Pool API used throughout the app:
//   pool.query(sql, params) → { rows, rowCount }
// SELECT queries:  rows = array of row objects, rowCount = rows.length
// DML queries:     rows = [],                   rowCount = affectedRows
const pool = {
  async query(sql, params = []) {
    const [result] = await mysqlPool.execute(sql, params);
    if (Array.isArray(result)) {
      return { rows: result, rowCount: result.length };
    }
    return { rows: [], rowCount: result.affectedRows };
  },
  async end() {
    return mysqlPool.end();
  },
};

// --- Token Encryption (AES-256-GCM) ---
// ENCRYPTION_KEY must be a 64-character hex string (32 bytes).
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv(hex):authTag(hex):ciphertext(hex)
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const key = getKey();
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { pool, encrypt, decrypt };
