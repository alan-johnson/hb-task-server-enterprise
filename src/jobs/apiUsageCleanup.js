'use strict';

const { pool } = require('../db/db');

// api_usage_events exists to answer one question — does triage usage predict
// retention (see docs/upq-rest-api-lean-beta-plan.md, Step 7) — which only
// needs a rolling analysis window, not permanent storage. Unlike
// idempotency_keys, this table shipped with no cleanup job at all; 90 days
// is generous for retention analysis and keeps it from growing unbounded
// under sustained API traffic.
async function cleanupApiUsageEvents() {
  const result = await pool.query(
    'DELETE FROM api_usage_events WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)'
  );
  if (result.rowCount > 0) {
    console.log(`[api-usage-cleanup] Deleted ${result.rowCount} expired usage event(s)`);
  }
}

module.exports = { cleanupApiUsageEvents };
