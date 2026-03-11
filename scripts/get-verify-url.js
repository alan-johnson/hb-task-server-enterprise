#!/usr/bin/env node
/**
 * get-verify-url.js
 *
 * Reads the pending verification token from the database and prints the full
 * verify URL — useful when the server is running in the background and you
 * cannot see its console output, or when SMTP is not configured.
 *
 * Usage:
 *   node scripts/get-verify-url.js [username|email]
 *   npm run get-verify-url
 *   npm run get-verify-url -- alan
 *   npm run get-verify-url -- johnsonalan006@gmail.com
 *
 * If no argument is given it looks up the test account (johnsonalan006@gmail.com).
 */

'use strict';

require('dotenv').config();

const mysql = require('mysql2/promise');

const TEST_EMAIL = 'johnsonalan006@gmail.com';
const arg        = process.argv[2] || TEST_EMAIL;
const baseUrl    = (process.env.WEB_URL || 'http://localhost').replace(/\/$/, '');

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL);

  // Match by username OR email
  const [rows] = await pool.execute(
    `SELECT username, email, email_verified, verification_token, verification_token_expires
     FROM users
     WHERE username = ? OR email = ?`,
    [arg, arg]
  );
  await pool.end();

  if (rows.length === 0) {
    console.error(`No account found matching "${arg}".`);
    process.exit(1);
  }

  const row = rows[0];

  if (row.email_verified) {
    console.log(`Account "${row.username}" (${row.email}) is already verified. Nothing to do.`);
    return;
  }

  if (!row.verification_token) {
    console.error(`Account "${row.username}" has no pending verification token. Try registering or resending.`);
    process.exit(1);
  }

  const expires = new Date(row.verification_token_expires);
  const expired = expires < new Date();

  if (expired) {
    console.warn(`Warning: token expired at ${expires.toLocaleString()}. Use the resend link to get a fresh one.`);
  }

  const url = `${baseUrl}/auth/verify-email?token=${row.verification_token}`;

  console.log('');
  console.log(`  Account : ${row.username} <${row.email}>`);
  console.log(`  Expires : ${expires.toLocaleString()}${expired ? '  ⚠ EXPIRED' : ''}`);
  console.log('');
  console.log(`  Verify URL:`);
  console.log(`  ${url}`);
  console.log('');
  console.log('  Paste the URL above into your browser to complete verification.');
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
