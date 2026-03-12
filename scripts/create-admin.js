#!/usr/bin/env node
/**
 * create-admin.js
 *
 * Creates (or resets) the built-in admin account.
 * The admin account has:
 *   - email_verified = true   (bypasses email verification)
 *   - subscription_status = 'active'  (bypasses Stripe billing)
 *   - no stripe_customer_id  (immune to Stripe webhook downgrades)
 *
 * Usage:
 *   node scripts/create-admin.js
 *   npm run create-admin
 */

'use strict';

require('dotenv').config();

const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'hb-aDmin-67-forewer$';
const ADMIN_EMAIL    = 'alan@handsbreadth.com';

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const userId       = 'admin-' + Date.now();
  const createdAt    = new Date().toISOString().replace('T', ' ').replace('Z', '');

  // UPSERT: insert the admin or update the existing row if the username already exists.
  await pool.execute(
    `INSERT INTO users
       (user_id, username, email, password_hash, created_at, default_provider,
        email_verified, subscription_status)
     VALUES (?, ?, ?, ?, ?, 'microsoft', TRUE, 'active')
     ON DUPLICATE KEY UPDATE
       email               = VALUES(email),
       password_hash       = VALUES(password_hash),
       email_verified      = TRUE,
       subscription_status = 'active',
       stripe_customer_id  = NULL`,
    [userId, ADMIN_USERNAME, ADMIN_EMAIL, passwordHash, createdAt]
  );

  console.log(`Admin account '${ADMIN_USERNAME}' created/updated.`);
  console.log(`  email:  ${ADMIN_EMAIL}`);
  console.log(`  status: active (no Stripe billing)`);

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
