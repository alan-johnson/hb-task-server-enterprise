#!/usr/bin/env node

/**
 * Triage feedback / bucket-move tests (hb-task-server-enterprise)
 *
 * Exercises PATCH /api/lists/:listId/tasks/:taskId/bucket — the drag-and-drop
 * bucket-move endpoint — and the manual-override mechanism it drives (see
 * docs/triage-engine-implementation-plan.md, Phase 4 §6, subsection 4a —
 * signal collection only; this file does not test 4b/4c calibration, which
 * is out of scope and gated on Phase 3 AI scoring). Runs entirely against the
 * sandbox provider, same as test-beta-api.js — needs no live Microsoft/Google
 * connection, only a verified, logged-in account.
 *
 * Note: this file asserts on the *observable HTTP effect* of a bucket move
 * (classification override + staleness auto-clear). It does not independently
 * verify the triage_feedback_events row content — there is no read route for
 * that table (out of scope per the plan doc), so that insert is verified by
 * code review / direct DB inspection, the same "not automated, verified
 * manually" carve-out the plan doc itself uses for the admin-defaults write
 * path (see docs/triage-engine-implementation-plan.md §4.5, point 4).
 *
 * Usage:
 *   node test/test-feedback.js
 *   BASE_URL=http://localhost:3500 node test/test-feedback.js
 */

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const LOG_PATH  = path.join(__dirname, 'test-feedback.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
const RUN_HEADER = `\n${'═'.repeat(62)}\nTest run: ${new Date().toISOString()}\n${'═'.repeat(62)}`;
logStream.write(RUN_HEADER + '\n');

function writeLine(level, args) {
  const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logStream.write(`[${new Date().toISOString()}] [${level}] ${text}\n`);
  return text;
}
const _log = console.log.bind(console), _error = console.error.bind(console);
console.log   = (...a) => { writeLine('LOG', a);   _log(...a); };
console.error = (...a) => { writeLine('ERROR', a); _error(...a); };

process.on('uncaughtException', err => { console.error('Uncaught exception:', err.message); process.exit(1); });
process.on('unhandledRejection', reason => { console.error('Unhandled rejection:', reason); process.exit(1); });

const BASE_URL  = process.env.BASE_URL  || 'https://tasks.handsbreadth.com';
const TEST_USER = process.env.TEST_USER || 'admin';
const TEST_PASS = process.env.TEST_PASS || '';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function request(method, urlStr, body, authToken, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (payload)   headers['Content-Length'] = Buffer.byteLength(payload);

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers,
      family: 4,
      rejectUnauthorized: true,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, res => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: buf ? JSON.parse(buf) : {}, headers: res.headers });
        } catch (e) {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${buf.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(method, path, body, authToken, extraHeaders) {
  return request(method, `${BASE_URL}${path}`, body, authToken, extraHeaders);
}

let passed = 0, failed = 0;
function pass(msg) { console.log(`  ✓  ${msg}`); passed++; }
function fail(msg, detail) { console.error(`  ✗  ${msg}`); if (detail) console.error(`     ${JSON.stringify(detail)}`); failed++; }
function assert(condition, passMsg, failMsg, detail) { condition ? pass(passMsg) : fail(failMsg, detail); }
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`); }

let jwt = null;
let sandboxKeyId = null;
let sandboxKey = null;

async function testLoginAndMintKey() {
  section('Setup: Login + mint sandbox API key');

  const login = await api('POST', '/auth/login', { username: TEST_USER, password: TEST_PASS });
  assert(login.status === 200 && login.data.token, `Logged in as "${TEST_USER}"`, 'Login failed', login.data);
  if (!login.data.token) return false;
  jwt = login.data.token;

  const created = await api('POST', '/auth/api-keys', { name: 'test-feedback', sandbox: true }, jwt);
  assert(created.status === 200 && created.data.apiKey?.startsWith('upq_sandbox_'),
    'Minted a sandbox API key', 'Failed to mint sandbox API key', created.data);
  if (!created.data.apiKey) return false;
  sandboxKeyId = created.data.id;
  sandboxKey   = created.data.apiKey;

  return true;
}

function findTask(tasks, taskId) {
  return tasks.find(t => t.id === taskId);
}

async function testBucketMove() {
  section('PATCH .../bucket — manual override takes precedence over rules');

  // sandbox-task-3 ("Archive old project files", sandbox-list-work): low
  // priority, no due date — rule-based classification lands it in "later".
  const taskId = 'sandbox-task-3';
  const listId = 'sandbox-list-work';

  const before = await api('GET', '/api/tasks/unified', null, sandboxKey);
  const beforeTask = findTask(before.data.tasks || [], taskId);
  assert(beforeTask?.classification === 'later', `${taskId} starts in "later" per rule-based classification`, 'Unexpected starting bucket', beforeTask);

  const moved = await api('PATCH', `/api/lists/${listId}/tasks/${taskId}/bucket`, { bucket: 'now' }, sandboxKey);
  assert(moved.status === 200 && moved.data.task?.classification === 'now' && moved.data.task?.classificationOverridden === true,
    'Move response reflects the new bucket with classificationOverridden: true', 'Move response did not reflect override', moved.data);

  const after = await api('GET', '/api/tasks/unified', null, sandboxKey);
  const afterTask = findTask(after.data.tasks || [], taskId);
  assert(afterTask?.classification === 'now' && afterTask?.classificationOverridden === true,
    'Subsequent GET /api/tasks/unified reflects the manual override', 'Override was not reflected on next read', afterTask);
}

async function testInvalidBucket() {
  section('PATCH .../bucket — invalid bucket value rejected');

  const invalid = await api('PATCH', '/api/lists/sandbox-list-work/tasks/sandbox-task-3/bucket', { bucket: 'someday' }, sandboxKey);
  assert(invalid.status === 400 && invalid.data.error?.code === 'invalid_request',
    'Invalid bucket value rejected with 400 invalid_request', 'Invalid bucket value was not rejected', invalid.data);
}

async function testSecondMoveOverwritesFirst() {
  section('A second move overwrites the first override');

  const taskId = 'sandbox-task-3';
  const listId = 'sandbox-list-work';

  const second = await api('PATCH', `/api/lists/${listId}/tasks/${taskId}/bucket`, { bucket: 'next' }, sandboxKey);
  assert(second.status === 200 && second.data.task?.classification === 'next',
    'Second move to a different bucket succeeds', 'Second move failed', second.data);

  const after = await api('GET', '/api/tasks/unified', null, sandboxKey);
  const afterTask = findTask(after.data.tasks || [], taskId);
  assert(afterTask?.classification === 'next', 'Latest move wins — task now reflects "next", not the earlier "now"', 'Earlier override was not overwritten', afterTask);
}

async function testIdempotency() {
  section('Idempotency-Key on bucket move');

  const taskId = 'sandbox-task-5'; // "Renew passport", sandbox-list-personal — starts in "now" (overdue, high priority)
  const listId = 'sandbox-list-personal';
  const idemKey = `test-feedback-idem-${Date.now()}`;
  const body = { bucket: 'later' };

  const first = await api('PATCH', `/api/lists/${listId}/tasks/${taskId}/bucket`, body, sandboxKey, { 'Idempotency-Key': idemKey });
  assert(first.status === 200 && first.data.task?.classification === 'later', 'First move with Idempotency-Key succeeded', 'First idempotent move failed', first.data);

  const replay = await api('PATCH', `/api/lists/${listId}/tasks/${taskId}/bucket`, body, sandboxKey, { 'Idempotency-Key': idemKey });
  // Field-by-field, not JSON.stringify(...) equality: idempotency replay goes
  // through a MySQL JSON column round-trip (see idempotency.js), and MySQL's
  // JSON type does not preserve object key insertion order, so a raw string
  // comparison is a false-negative trap — same pitfall test-beta-api.js's own
  // idempotency test avoids by comparing specific fields instead.
  assert(replay.status === first.status
      && replay.data.task?.id === first.data.task?.id
      && replay.data.task?.classification === first.data.task?.classification
      && replay.data.taskId === first.data.taskId
      && replay.data.listId === first.data.listId,
    'Same key + same body replays the original response', 'Replay did not match original', { first: first.data, replay: replay.data });

  const conflict = await api('PATCH', `/api/lists/${listId}/tasks/${taskId}/bucket`, { bucket: 'now' }, sandboxKey, { 'Idempotency-Key': idemKey });
  assert(conflict.status === 400 && conflict.data.error?.code === 'invalid_request',
    'Same key + different body is rejected', 'Conflicting idempotency request was not rejected', conflict.data);
}

async function testOverrideAutoClearsOnFieldChange() {
  section('Override auto-clears when dueDate/priority changes');

  // sandbox-task-5 was moved to "later" above (overriding its natural "now").
  // Changing its priority via the existing generic PATCH route should make
  // that override stale — the next read should fall back to rule-based
  // classification instead of the stale "later" pin. This also exercises
  // the fire-and-forget clearOverride cleanup path (see annotateClassification
  // in src/task-server.js), and incidentally leaves the DB override row
  // deleted so a re-run of this test file starts clean.
  const taskId = 'sandbox-task-5';
  const listId = 'sandbox-list-personal';

  const beforeChange = await api('GET', '/api/tasks/unified', null, sandboxKey);
  const beforeTask = findTask(beforeChange.data.tasks || [], taskId);
  assert(beforeTask?.classification === 'later' && beforeTask?.classificationOverridden === true,
    'Task still shows the manual override before the field change', 'Precondition failed — override not present', beforeTask);

  const updated = await api('PATCH', `/api/lists/${listId}/tasks/${taskId}`, { priority: 'low' }, sandboxKey);
  assert(updated.status === 200, 'Changed the task\'s priority via the generic update route', 'Failed to update task priority', updated.data);

  const afterChange = await api('GET', '/api/tasks/unified', null, sandboxKey);
  const afterTask = findTask(afterChange.data.tasks || [], taskId);
  assert(afterTask?.classification !== 'later' || !afterTask?.classificationOverridden,
    'Stale override no longer applied — task reverted to rule-based classification', 'Stale override was still applied after a field change', afterTask);
}

async function testSandboxReset() {
  section('Cleanup: sandbox reset');

  // /api/sandbox/reset only resets the in-memory sandbox task store for this
  // key — task_bucket_overrides is a separate, persistent table keyed by the
  // real account's user_id, not the (ephemeral, per-key) sandbox store, so it
  // survives a sandbox reset untouched. sandbox-task-3 was moved twice above
  // (testBucketMove, testSecondMoveOverwritesFirst) and never field-changed,
  // so its override would otherwise silently persist and break the next run
  // of this file (which assumes sandbox-task-3 starts in "later"). Force it
  // stale the same way testOverrideAutoClearsOnFieldChange does for
  // sandbox-task-5, so every account this test runs against ends clean.
  // Must differ from task-3's fixture priority ('low') or the override's
  // priority_snapshot — captured at low — would still match and stay "fresh".
  // A read (GET) has to happen *before* the sandbox reset below: staleness
  // is only detected (and the DB row cleared, fire-and-forget) when the task
  // is actually read through annotateClassification. If reset ran first, the
  // in-memory task would revert priority to its original 'low' — matching
  // the override's snapshot again — and the override would look "fresh" on
  // the very next run.
  await api('PATCH', '/api/lists/sandbox-list-work/tasks/sandbox-task-3', { priority: 'high' }, sandboxKey);
  await api('GET', '/api/tasks/unified', null, sandboxKey);

  const reset = await api('POST', '/api/sandbox/reset', null, sandboxKey);
  assert(reset.status === 200 && reset.data.success, 'Sandbox provider state reset', 'Sandbox reset failed', reset.data);
}

async function testRevocation() {
  section('API key revocation');

  const revoked = await api('DELETE', `/auth/api-keys/${sandboxKeyId}`, null, jwt);
  assert(revoked.status === 200 && revoked.data.success, 'Revoked the sandbox API key', 'Revocation failed', revoked.data);
}

async function run() {
  console.log('Triage Feedback / Bucket Move Tests — hb-task-server-enterprise');
  console.log(`Server: ${BASE_URL}`);
  console.log(`User:   ${TEST_USER}`);
  console.log('═'.repeat(62));

  const ok = await testLoginAndMintKey();
  if (ok) {
    await testBucketMove();
    await testInvalidBucket();
    await testSecondMoveOverwritesFirst();
    await testIdempotency();
    await testOverrideAutoClearsOnFieldChange();
    await testSandboxReset();
    await testRevocation();
  }

  console.log('\n' + '═'.repeat(62));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(62));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
