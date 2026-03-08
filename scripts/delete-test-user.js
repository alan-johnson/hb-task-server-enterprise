#!/usr/bin/env node
/**
 * delete-test-user.js
 *
 * Deletes all accounts whose email matches the test address so the testing
 * user can be reused to verify the registration and sign-in flow end-to-end.
 *
 * Usage:
 *   node scripts/delete-test-user.js
 *   npm run delete-test-user
 */

'use strict';

require('dotenv').config();

const { Pool }  = require('pg');
const Redis     = require('ioredis');

const TEST_EMAIL = 'johnsonalan006@gmail.com';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // --- Find matching accounts ---
  const found = await pool.query(
    'SELECT user_id, username, email, email_verified, created_at FROM users WHERE email = $1',
    [TEST_EMAIL]
  );

  if (found.rows.length === 0) {
    console.log(`No accounts found with email ${TEST_EMAIL}.`);
    await pool.end();
    return;
  }

  console.log(`Found ${found.rows.length} account(s) to delete:`);
  for (const row of found.rows) {
    console.log(`  • user_id=${row.user_id}  username=${row.username}  verified=${row.email_verified}  created=${row.created_at}`);
  }

  const userIds  = found.rows.map(r => r.user_id);
  const usernames = found.rows.map(r => r.username);

  // --- Delete from Postgres (credentials cascade automatically) ---
  const del = await pool.query(
    'DELETE FROM users WHERE user_id = ANY($1::text[])',
    [userIds]
  );
  console.log(`\nDeleted ${del.rowCount} user record(s) from PostgreSQL (credentials cascade).`);

  await pool.end();

  // --- Clear Redis cache entries ---
  if (process.env.REDIS_URL) {
    const redis = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false });
    const cacheKeys = [];

    for (const id of userIds) {
      cacheKeys.push(`user:id:${id}`);
      // provider credential cache
      for (const p of ['microsoft', 'google', 'apple']) {
        cacheKeys.push(`creds:${id}:${p}`);
        cacheKeys.push(`status:${id}:${p}`);
        cacheKeys.push(`lists:${id}:${p}`);
        cacheKeys.push(`counts:${id}:${p}:true`);
        cacheKeys.push(`counts:${id}:${p}:false`);
      }
      cacheKeys.push(`classrules:${id}`);
      cacheKeys.push(`unified:${id}`);
    }
    for (const name of usernames) {
      cacheKeys.push(`user:name:${name}`);
    }

    await redis.del(...cacheKeys);
    console.log(`Cleared ${cacheKeys.length} Redis cache key(s).`);
    redis.disconnect();
  } else {
    console.log('REDIS_URL not set — skipping cache flush.');
  }

  console.log(`\nDone. ${TEST_EMAIL} can now be used to register again.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
