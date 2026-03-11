#!/usr/bin/env node
/**
 * reset-user-password.js
 *
 * Resets the password for a given username.
 *
 * Usage:
 *   node scripts/reset-user-password.js <username> <new-password>
 */

'use strict';

require('dotenv').config();

const mysql  = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function main() {
  const [username, newPassword] = process.argv.slice(2);

  if (!username || !newPassword) {
    console.error('Usage: node scripts/reset-user-password.js <username> <new-password>');
    process.exit(1);
  }

  const pool = mysql.createPool(process.env.DATABASE_URL);

  const [rows] = await pool.execute(
    'SELECT 1 FROM users WHERE username = ?',
    [username]
  );

  if (rows.length === 0) {
    console.error(`User '${username}' not found.`);
    await pool.end();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  await pool.execute(
    'UPDATE users SET password_hash = ? WHERE username = ?',
    [passwordHash, username]
  );

  console.log(`Password reset for user '${username}'.`);
  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
