const crypto = require('crypto');
const { pool } = require('./db/db');
const { apiError } = require('./errors');

// Applied only to POST /api/lists/:listId/tasks — the one write the lean
// beta doc calls out (agents retry tool calls more readily than humans
// retry form submissions, risking duplicate task creation on a dropped
// response). Same Idempotency-Key + same body → replay the stored response.
// Same key + different body → 409, since silently accepting either
// interpretation would hide a caller bug.
async function idempotencyMiddleware(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  const requestHash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');

  try {
    const existing = await pool.query(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = ? AND idempotency_key = ?',
      [req.user.userId, key]
    );
    const row = existing.rows[0];
    if (row) {
      if (row.request_hash !== requestHash) {
        return apiError(res, 'invalid_request', 'Idempotency-Key was already used with a different request body');
      }
      return res.status(row.response_status).json(
        typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body
      );
    }
  } catch (err) {
    return apiError(res, 'internal_error', err.message);
  }

  // Awaited (not fire-and-forget) — the record must exist before the
  // response is flushed to the client, otherwise a fast retry can win the
  // race against this INSERT and read no row on its own SELECT check above,
  // creating a second task instead of replaying. This closes the realistic
  // case the lean beta doc calls out (retry after a dropped/delayed
  // response); two requests arriving genuinely simultaneously with the same
  // key can still both pass the SELECT check before either INSERT lands —
  // an inherent TOCTOU gap this beta-level guard doesn't fully close.
  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    try {
      await pool.query(
        `INSERT INTO idempotency_keys (id, user_id, idempotency_key, request_hash, response_status, response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE request_hash = request_hash`,
        [crypto.randomUUID(), req.user.userId, key, requestHash, res.statusCode, JSON.stringify(body)]
      );
    } catch (err) {
      console.error('idempotency store failed:', err.message);
    }
    return originalJson(body);
  };
  next();
}

module.exports = { idempotencyMiddleware };
