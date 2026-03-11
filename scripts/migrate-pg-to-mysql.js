#!/usr/bin/env node
/**
 * migrate-pg-to-mysql.js
 *
 * One-shot migration: reads all data from PostgreSQL and inserts it into MySQL.
 * Run once after switching the app from pg to mysql2. Safe to run on an empty
 * MySQL database — skips rows that already exist (INSERT IGNORE).
 *
 * Usage:
 *   node scripts/migrate-pg-to-mysql.js
 *
 * Requires both DATABASE_URL (MySQL) and PG_URL (PostgreSQL) to be set.
 */

'use strict';

require('dotenv').config();

const { Pool }  = require('pg');
const mysql     = require('mysql2/promise');

const PG_URL    = process.env.PG_URL    || 'postgres://alanjohnson@localhost:5432/hb_task_server';
const MYSQL_URL = process.env.DATABASE_URL;

if (!MYSQL_URL || !MYSQL_URL.startsWith('mysql://')) {
  console.error('DATABASE_URL must be a mysql:// connection string.');
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

// PostgreSQL returns timestamps as Date objects with timezone.
// Convert to a MySQL-compatible UTC string: "YYYY-MM-DD HH:MM:SS.mmm"
function toMySQLDatetime(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d)) return null;
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

// PostgreSQL JSONB comes back as a parsed JS object; stringify for MySQL JSON column.
function toMySQLJson(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Connecting to PostgreSQL…');
  const pg = new Pool({ connectionString: PG_URL });

  console.log('Connecting to MySQL…');
  const my = await mysql.createPool(MYSQL_URL);

  // ── users ─────────────────────────────────────────────────────────────────

  const { rows: users } = await pg.query('SELECT * FROM users ORDER BY created_at');
  console.log(`\nMigrating ${users.length} user(s)…`);

  for (const u of users) {
    await my.execute(
      `INSERT IGNORE INTO users
         (user_id, username, email, password_hash, created_at, default_provider,
          show_completed, classification_rules, stripe_customer_id, subscription_status,
          email_verified, verification_token, verification_token_expires,
          password_reset_token, password_reset_token_expires)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        u.user_id,
        u.username,
        u.email                         || null,
        u.password_hash,
        toMySQLDatetime(u.created_at),
        u.default_provider,
        u.show_completed                ? 1 : 0,
        toMySQLJson(u.classification_rules),
        u.stripe_customer_id            || null,
        u.subscription_status           || 'none',
        u.email_verified                ? 1 : 0,
        u.verification_token            || null,
        toMySQLDatetime(u.verification_token_expires),
        u.password_reset_token          || null,
        toMySQLDatetime(u.password_reset_token_expires),
      ]
    );
    console.log(`  ✓ user: ${u.username} (${u.user_id})`);
  }

  // ── user_credentials ──────────────────────────────────────────────────────

  const { rows: creds } = await pg.query('SELECT * FROM user_credentials ORDER BY updated_at');
  console.log(`\nMigrating ${creds.length} credential row(s)…`);

  for (const c of creds) {
    await my.execute(
      `INSERT IGNORE INTO user_credentials
         (user_id, provider, access_token, refresh_token, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        c.user_id,
        c.provider,
        c.access_token,
        c.refresh_token || null,
        toMySQLDatetime(c.updated_at),
      ]
    );
    console.log(`  ✓ credentials: ${c.user_id} / ${c.provider}`);
  }

  // ── bridge_api_keys ───────────────────────────────────────────────────────

  const { rows: keys } = await pg.query('SELECT * FROM bridge_api_keys ORDER BY created_at');
  console.log(`\nMigrating ${keys.length} bridge API key(s)…`);

  for (const k of keys) {
    await my.execute(
      `INSERT IGNORE INTO bridge_api_keys
         (user_id, key_hash, created_at)
       VALUES (?, ?, ?)`,
      [
        k.user_id,
        k.key_hash,
        toMySQLDatetime(k.created_at),
      ]
    );
    console.log(`  ✓ bridge key: ${k.user_id}`);
  }

  // ── verify ────────────────────────────────────────────────────────────────

  const [[{ userCount }]]  = await my.execute('SELECT COUNT(*) AS userCount FROM users');
  const [[{ credCount }]]  = await my.execute('SELECT COUNT(*) AS credCount FROM user_credentials');
  const [[{ keyCount }]]   = await my.execute('SELECT COUNT(*) AS keyCount FROM bridge_api_keys');

  console.log('\n── Migration complete ──');
  console.log(`  users:            ${users.length} → ${userCount}`);
  console.log(`  user_credentials: ${creds.length} → ${credCount}`);
  console.log(`  bridge_api_keys:  ${keys.length} → ${keyCount}`);

  const allOk = Number(userCount) === users.length &&
                Number(credCount) === creds.length &&
                Number(keyCount)  === keys.length;

  if (!allOk) {
    console.error('\n⚠  Row counts do not match — some rows may have been skipped (INSERT IGNORE).');
    console.error('   Check for duplicate primary keys between the two databases.');
    process.exit(1);
  }

  console.log('\n✓ All rows verified.\n');

  await pg.end();
  await my.end();
}

main().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
