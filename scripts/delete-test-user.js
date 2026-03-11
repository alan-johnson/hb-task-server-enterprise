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

const mysql = require('mysql2/promise');
const Redis = require('ioredis');

const TEST_EMAIL = 'johnsonalan006@gmail.com';

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL);

  // --- Find matching accounts ---
  const [found] = await pool.execute(
    'SELECT user_id, username, email, email_verified, created_at FROM users WHERE email = ?',
    [TEST_EMAIL]
  );

  if (found.length === 0) {
    console.log(`No accounts found with email ${TEST_EMAIL}.`);
    await pool.end();
    return;
  }

  console.log(`Found ${found.length} account(s) to delete:`);
  for (const row of found) {
    console.log(`  • user_id=${row.user_id}  username=${row.username}  verified=${!!row.email_verified}  created=${row.created_at}`);
  }

  const userIds   = found.map(r => r.user_id);
  const usernames = found.map(r => r.username);

  // --- Delete from MySQL (credentials cascade automatically) ---
  const placeholders = userIds.map(() => '?').join(', ');
  const [delResult] = await pool.execute(
    `DELETE FROM users WHERE user_id IN (${placeholders})`,
    userIds
  );
  console.log(`\nDeleted ${delResult.affectedRows} user record(s) from MySQL (credentials cascade).`);

  await pool.end();

  // --- Clear Redis cache entries ---
  if (process.env.REDIS_URL) {
    const cacheKeys = [];
    for (const id of userIds) {
      cacheKeys.push(`user:id:${id}`);
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

    try {
      const redis = new Redis(process.env.REDIS_URL);
      await new Promise((resolve, reject) => {
        redis.once('ready', resolve);
        redis.once('error', reject);
      });
      await redis.del(...cacheKeys);
      console.log(`Cleared ${cacheKeys.length} Redis cache key(s).`);
      redis.disconnect();
    } catch (redisErr) {
      console.warn(`Redis flush skipped (${redisErr.message}) — cache will expire naturally.`);
    }
  } else {
    console.log('REDIS_URL not set — skipping cache flush.');
  }

  console.log(`\nDone. ${TEST_EMAIL} can now be used to register again.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
