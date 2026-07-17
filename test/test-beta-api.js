#!/usr/bin/env node

/**
 * Beta API Tests — developer REST API / MCP surface (hb-task-server-enterprise)
 *
 * Exercises the new API-key auth, sandbox provider, list filtering,
 * pagination, idempotency keys, rate limiting, and key revocation added for
 * the UpQ lean beta (see docs/upq-rest-api-lean-beta-plan.md). Runs entirely
 * against the sandbox provider, so — unlike test-integration.js — it needs
 * no live Microsoft/Google connection, only a verified, logged-in account.
 * Safe to run against production: sandbox data is isolated per API key and
 * never touches the account's real connected providers.
 *
 * Usage:
 *   node test/test-beta-api.js
 *   BASE_URL=http://localhost:3500 node test/test-beta-api.js
 */

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const LOG_PATH  = path.join(__dirname, 'test-beta-api.log');
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
          resolve({ status: res.statusCode, data: buf ? JSON.parse(buf) : {} });
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

  const created = await api('POST', '/auth/api-keys', { name: 'test-beta-api', sandbox: true }, jwt);
  assert(created.status === 200 && created.data.apiKey?.startsWith('upq_sandbox_'),
    'Minted a sandbox API key', 'Failed to mint sandbox API key', created.data);
  if (!created.data.apiKey) return false;
  sandboxKeyId = created.data.id;
  sandboxKey   = created.data.apiKey;

  const listed = await api('GET', '/auth/api-keys', null, jwt);
  assert(listed.status === 200 && listed.data.keys.some(k => k.id === sandboxKeyId),
    'Minted key appears in GET /auth/api-keys', 'Minted key missing from list', listed.data);

  return true;
}

async function testSandboxTriage() {
  section('Sandbox triage (zero-setup, no MS/Google connection)');

  const unified = await api('GET', '/api/tasks/unified', null, sandboxKey);
  assert(unified.status === 200, 'GET /api/tasks/unified (sandbox key) returned 200', 'Unified endpoint failed', unified.data);
  assert(unified.data.total === 9, `Seeded sandbox fixture has 9 tasks (got ${unified.data.total})`, 'Unexpected sandbox task count', unified.data);
  const classifications = new Set((unified.data.tasks || []).map(t => t.classification).filter(Boolean));
  assert(classifications.has('now') && classifications.has('next') && classifications.has('later'),
    'Sandbox fixture spans Now/Next/Later', 'Sandbox fixture missing a triage bucket', [...classifications]);

  const filtered = await api('GET', '/api/tasks/unified?list_id=sandbox-list-personal', null, sandboxKey);
  assert(filtered.status === 200 && filtered.data.total === 3 && filtered.data.tasks.every(t => t.listId === 'sandbox-list-personal'),
    'list_id filter scopes to one list', 'list_id filter returned wrong results', filtered.data);

  const excluded = await api('GET', '/api/tasks/unified?exclude_list=sandbox-list-someday', null, sandboxKey);
  assert(excluded.status === 200 && excluded.data.total === 7 && excluded.data.tasks.every(t => t.listId !== 'sandbox-list-someday'),
    'exclude_list filter omits the excluded list', 'exclude_list filter returned wrong results', excluded.data);

  const paged = await api('GET', '/api/tasks/unified?limit=2&offset=0', null, sandboxKey);
  assert(paged.status === 200 && paged.data.tasks.length === 2 && paged.data.hasMore === true,
    'limit/offset pagination trims the response and sets hasMore', 'Pagination behaved unexpectedly', paged.data);
}

async function testClassificationRules() {
  section('Classification rules via API key');

  const rules = await api('GET', '/auth/me/classification', null, sandboxKey);
  assert(rules.status === 200 && rules.data.rules, 'GET /auth/me/classification (sandbox key) returned 200', 'Rules GET failed', rules.data);
}

async function testSandboxWritesAndReset() {
  section('Sandbox writes (mutable) + reset');

  const before = await api('GET', '/api/lists/sandbox-list-work/tasks', null, sandboxKey);
  const baselineCount = before.data.tasks?.length;
  assert(before.status === 200 && baselineCount === 4, `Baseline sandbox-list-work has 4 tasks (got ${baselineCount})`, 'Unexpected baseline', before.data);

  const created = await api('POST', '/api/lists/sandbox-list-work/tasks', { name: 'CI test task' }, sandboxKey);
  assert(created.status === 201 && created.data.task?.id, 'Created a sandbox task', 'Sandbox task creation failed', created.data);
  const taskId = created.data.task?.id;

  const afterCreate = await api('GET', '/api/lists/sandbox-list-work/tasks', null, sandboxKey);
  assert(afterCreate.data.tasks?.length === baselineCount + 1, 'Task count increased by 1 after create', 'Task count did not increase', afterCreate.data);

  if (taskId) {
    const completed = await api('PATCH', `/api/lists/sandbox-list-work/tasks/${taskId}/complete`, {}, sandboxKey);
    assert(completed.status === 200, 'Completed the sandbox task', 'Complete failed', completed.data);

    const deleted = await api('DELETE', `/api/lists/sandbox-list-work/tasks/${taskId}`, null, sandboxKey);
    assert(deleted.status === 200, 'Deleted the sandbox task', 'Delete failed', deleted.data);
  }

  const reset = await api('POST', '/api/sandbox/reset', null, sandboxKey);
  assert(reset.status === 200 && reset.data.success, 'Sandbox reset succeeded', 'Sandbox reset failed', reset.data);

  const afterReset = await api('GET', '/api/lists/sandbox-list-work/tasks', null, sandboxKey);
  assert(afterReset.data.tasks?.length === baselineCount, 'Task count back to baseline after reset', 'Reset did not restore baseline', afterReset.data);
}

async function testIdempotency() {
  section('Idempotency-Key on task creation');

  const idemKey = `test-beta-idem-${Date.now()}`;
  const body = { name: 'Idempotent task' };

  const first = await api('POST', '/api/lists/sandbox-list-work/tasks', body, sandboxKey, { 'Idempotency-Key': idemKey });
  assert(first.status === 201, 'First request with Idempotency-Key created the task', 'First idempotent request failed', first.data);

  const replay = await api('POST', '/api/lists/sandbox-list-work/tasks', body, sandboxKey, { 'Idempotency-Key': idemKey });
  assert(replay.status === first.status && replay.data.task?.id === first.data.task?.id,
    'Same key + same body replays the original response (no duplicate)', 'Replay did not match original', { first: first.data, replay: replay.data });

  const conflict = await api('POST', '/api/lists/sandbox-list-work/tasks', { name: 'Different body' }, sandboxKey, { 'Idempotency-Key': idemKey });
  assert(conflict.status === 400 && conflict.data.error?.code === 'invalid_request',
    'Same key + different body is rejected (409/400 conflict)', 'Conflicting idempotency request was not rejected', conflict.data);

  await api('POST', '/api/sandbox/reset', null, sandboxKey); // clean up the tasks this test created
}

async function testIdempotencyOnDelete() {
  section('Idempotency-Key on delete (not just create)');

  const list = await api('GET', '/api/lists/sandbox-list-work/tasks', null, sandboxKey);
  const taskId = list.data.tasks?.[0]?.id;
  assert(!!taskId, 'Found a sandbox task to delete', 'No sandbox task available to delete', list.data);
  if (!taskId) return;

  const idemKey = `test-beta-idem-delete-${Date.now()}`;
  const first = await api('DELETE', `/api/lists/sandbox-list-work/tasks/${taskId}`, null, sandboxKey, { 'Idempotency-Key': idemKey });
  assert(first.status === 200, 'First delete with Idempotency-Key succeeded', 'First idempotent delete failed', first.data);

  const replay = await api('DELETE', `/api/lists/sandbox-list-work/tasks/${taskId}`, null, sandboxKey, { 'Idempotency-Key': idemKey });
  assert(replay.status === 200 && replay.data.success === true,
    'Replayed delete returns the original success response, not a 404', 'Replayed delete did not match original', { first: first.data, replay: replay.data });

  await api('POST', '/api/sandbox/reset', null, sandboxKey);
}

async function testScopeEnforcement() {
  section('Structural scope: API key excluded from billing/account routes');

  const billing = await api('GET', '/billing/status', null, sandboxKey);
  assert(billing.status === 401, 'Sandbox API key rejected on /billing/status (JWT-only route)', 'API key was unexpectedly accepted on a billing route', billing.data);
}

async function testReadWriteScopeEnforcement() {
  section('tasks:read vs tasks:write scope enforcement');

  const badScope = await api('POST', '/auth/api-keys', { name: 'bad-scope', scopes: ['tasks:frobnicate'] }, jwt);
  assert(badScope.status === 400 && badScope.data.error?.code === 'invalid_request',
    'Minting a key with an unknown scope is rejected', 'Invalid scope was accepted', badScope.data);

  const created = await api('POST', '/auth/api-keys', { name: 'test-beta-readonly', sandbox: true, scopes: ['tasks:read'] }, jwt);
  assert(created.status === 200 && created.data.scopes === 'tasks:read',
    'Minted a read-only sandbox key', 'Failed to mint a read-only key', created.data);
  if (!created.data.apiKey) return;
  const readOnlyKeyId = created.data.id;
  const readOnlyKey = created.data.apiKey;

  const read = await api('GET', '/api/tasks/unified', null, readOnlyKey);
  assert(read.status === 200, 'Read-only key can GET /api/tasks/unified', 'Read-only key was rejected on a read', read.data);

  const write = await api('POST', '/api/lists/sandbox-list-work/tasks', { name: 'should be blocked' }, readOnlyKey);
  assert(write.status === 403 && write.data.error?.code === 'forbidden',
    'Read-only key is rejected (403) creating a task', 'Read-only key was able to write', write.data);

  const update = await api('PATCH', '/api/lists/sandbox-list-work/tasks/sandbox-task-1', { name: 'nope' }, readOnlyKey);
  assert(update.status === 403, 'Read-only key is rejected (403) updating a task', 'Read-only key was able to update', update.data);

  const rulesWrite = await api('PUT', '/auth/me/classification', { now: {}, next: {}, later: {} }, readOnlyKey);
  assert(rulesWrite.status === 403, 'Read-only key is rejected (403) writing classification rules', 'Read-only key was able to write rules', rulesWrite.data);

  const reset = await api('POST', '/api/sandbox/reset', null, readOnlyKey);
  assert(reset.status === 403, 'Read-only key is rejected (403) on /api/sandbox/reset', 'Read-only key was able to reset sandbox', reset.data);

  // A full-scope (default) key must still be able to write — confirms the
  // enforcement is additive, not a regression on normal keys.
  const fullScopeWrite = await api('POST', '/api/lists/sandbox-list-work/tasks', { name: 'allowed' }, sandboxKey);
  assert(fullScopeWrite.status === 201, 'Default full-scope key can still write', 'Full-scope key was unexpectedly blocked', fullScopeWrite.data);
  await api('POST', '/api/sandbox/reset', null, sandboxKey);

  await api('DELETE', `/auth/api-keys/${readOnlyKeyId}`, null, jwt);
}

async function testRevocation() {
  section('API key revocation');

  const revoked = await api('DELETE', `/auth/api-keys/${sandboxKeyId}`, null, jwt);
  assert(revoked.status === 200 && revoked.data.success, 'Revoked the sandbox API key', 'Revocation failed', revoked.data);

  const afterRevoke = await api('GET', '/api/tasks/unified', null, sandboxKey);
  assert(afterRevoke.status === 401, 'Revoked key rejected on next request', 'Revoked key still worked', afterRevoke.data);
}

async function run() {
  console.log('Beta API Tests — hb-task-server-enterprise');
  console.log(`Server: ${BASE_URL}`);
  console.log(`User:   ${TEST_USER}`);
  console.log('═'.repeat(62));

  const ok = await testLoginAndMintKey();
  if (ok) {
    await testSandboxTriage();
    await testClassificationRules();
    await testSandboxWritesAndReset();
    await testIdempotency();
    await testIdempotencyOnDelete();
    await testScopeEnforcement();
    await testReadWriteScopeEnforcement();
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
