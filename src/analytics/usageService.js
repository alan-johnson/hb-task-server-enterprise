const { pool } = require('../db/db');

// Fire-and-forget insert — a logging hiccup must never delay or break an
// API response, so failures are caught and logged, not surfaced to the caller.
async function logUsageEvent({ userId, apiKeyId, endpoint, category, statusCode }) {
  try {
    await pool.query(
      `INSERT INTO api_usage_events (user_id, api_key_id, endpoint, category, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, apiKeyId || null, endpoint, category, statusCode]
    );
  } catch (err) {
    console.error('logUsageEvent failed:', err.message);
  }
}

module.exports = { logUsageEvent };
