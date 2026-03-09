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

const { Pool } = require('pg');
const bcrypt   = require('bcrypt');

async function main() {
  const [username, newPassword] = process.argv.slice(2);

  if (!username || !newPassword) {
    console.error('Usage: node scripts/reset-user-password.js <username> <new-password>');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rowCount } = await pool.query(
    'SELECT 1 FROM users WHERE username = $1',
    [username]
  );

  if (rowCount === 0) {
    console.error(`User '${username}' not found.`);
    await pool.end();
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  await pool.query(
    'UPDATE users SET password_hash = $1 WHERE username = $2',
    [passwordHash, username]
  );

  console.log(`Password reset for user '${username}'.`);
  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
