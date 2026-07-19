'use strict';

const { pool } = require('../db/db');
const cache = require('../db/cache');

// Live manual bucket-override state for drag-and-drop task moves (see
// upq_terraform_files/upq-infra/migrations/V6__task_bucket_overrides.sql).
// Distinct from triage_feedback_events (an append-only log) — this is the
// queryable "what bucket is this task pinned to right now" table that
// annotateClassification() in src/task-server.js reads from on every request.
//
// Cached through the shared Redis client the same way userService.js caches
// per-user classification rules (classrules:${userId}) — not the in-memory
// SimpleCache pattern in task-server.js, which would silently desync across
// processes (see docs/triage-engine-implementation-plan.md §1.5).

function cacheKey(userId) {
  return `bucketoverrides:${userId}`;
}

function rowKey(provider, listId, taskId) {
  return `${provider}:${listId}:${taskId}`;
}

async function getOverridesForUser(userId) {
  const key = cacheKey(userId);
  const cached = await cache.get(key);
  if (cached) return new Map(JSON.parse(cached));

  // This is unconditionally awaited on every classification-read request
  // (GET /api/tasks/unified and friends) — unlike setOverride/clearOverride,
  // which only run from the new bucket-move route or a fire-and-forget
  // .catch(), so an error here isn't already isolated from the response.
  // The deploy pipeline (.github/workflows/deploy.yml) deploys code, runs
  // the production smoke test, and only then runs the Flyway migration —
  // so there's a real window where this code is live and this table doesn't
  // exist yet (ER_NO_SUCH_TABLE). Treat "can't read overrides" as "no
  // overrides" rather than failing the whole read: this is a manual-override
  // enhancement layer on top of rule-based classification, not something
  // that should be able to take down /api/tasks/unified.
  try {
    const result = await pool.query(
      'SELECT provider, list_id, task_id, bucket, due_date_snapshot, priority_snapshot FROM task_bucket_overrides WHERE user_id = ?',
      [userId]
    );
    const entries = result.rows.map(row => [
      rowKey(row.provider, row.list_id, row.task_id),
      { bucket: row.bucket, dueDateSnapshot: row.due_date_snapshot, prioritySnapshot: row.priority_snapshot }
    ]);
    await cache.set(key, JSON.stringify(entries));
    return new Map(entries);
  } catch (err) {
    console.error('getOverridesForUser failed (treating as no overrides):', err.message);
    return new Map();
  }
}

async function setOverride(userId, provider, listId, taskId, bucket, dueDateSnapshot, prioritySnapshot) {
  await pool.query(
    `INSERT INTO task_bucket_overrides (user_id, provider, list_id, task_id, bucket, due_date_snapshot, priority_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE bucket = VALUES(bucket), due_date_snapshot = VALUES(due_date_snapshot), priority_snapshot = VALUES(priority_snapshot)`,
    [userId, provider, listId, taskId, bucket, dueDateSnapshot || null, prioritySnapshot || null]
  );
  await cache.del(cacheKey(userId));
}

async function clearOverride(userId, provider, listId, taskId) {
  await pool.query(
    'DELETE FROM task_bucket_overrides WHERE user_id = ? AND provider = ? AND list_id = ? AND task_id = ?',
    [userId, provider, listId, taskId]
  );
  await cache.del(cacheKey(userId));
}

module.exports = { getOverridesForUser, setOverride, clearOverride };
