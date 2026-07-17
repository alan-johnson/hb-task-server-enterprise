'use strict';

const { pool } = require('../db/db');

// Idempotency records only need to survive long enough to catch a client's
// retry of a dropped response — 48h is generous for that and keeps the
// table from growing unbounded under sustained API traffic.
async function cleanupIdempotencyKeys() {
  const result = await pool.query(
    'DELETE FROM idempotency_keys WHERE created_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)'
  );
  if (result.rowCount > 0) {
    console.log(`[idempotency-cleanup] Deleted ${result.rowCount} expired idempotency key(s)`);
  }
}

module.exports = { cleanupIdempotencyKeys };
