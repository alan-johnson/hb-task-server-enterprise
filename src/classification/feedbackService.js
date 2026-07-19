'use strict';

const { pool } = require('../db/db');

// Fire-and-forget insert into the triage feedback signal log (see
// docs/triage-engine-implementation-plan.md, Phase 4 §6, subsection 4a —
// signal collection only, no calibration built on top of it yet). Same
// pattern as src/analytics/usageService.js's logUsageEvent: a logging
// failure must never delay or break the task mutation it's attached to.
async function logTriageFeedback({ userId, taskId, signalType, predicted, observed }) {
  try {
    await pool.query(
      `INSERT INTO triage_feedback_events (user_id, task_id, signal_type, predicted, observed, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, taskId, signalType, predicted || null, observed || null]
    );
  } catch (err) {
    console.error('logTriageFeedback failed:', err.message);
  }
}

module.exports = { logTriageFeedback };
