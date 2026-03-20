#!/usr/bin/env node

/**
 * Integration Tests — hb-task-server-enterprise
 *
 * Tests run sequentially against the live server. Each test builds on
 * state from the previous one (token → lists → tasks → task detail).
 *
 * Usage:
 *   node test/test-integration.js
 *   BASE_URL=http://localhost:3500 node test/test-integration.js
 *
 * All output is written to both stdout and test-integration.log.
 */

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── File logger ────────────────────────────────────────────────────────────────
const LOG_PATH  = path.join(__dirname, 'test-integration.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

const RUN_HEADER = `\n${'═'.repeat(62)}\nTest run: ${new Date().toISOString()}\n${'═'.repeat(62)}`;
logStream.write(RUN_HEADER + '\n');

function writeLine(level, args) {
  const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${text}`;
  logStream.write(line + '\n');
  return text;
}

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

console.log   = (...a) => { writeLine('LOG',   a); _log(...a);   };
console.warn  = (...a) => { writeLine('WARN',  a); _warn(...a);  };
console.error = (...a) => { writeLine('ERROR', a); _error(...a); };

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

const BASE_URL  = process.env.BASE_URL  || 'https://tasks.handsbreadth.com';
const TEST_USER = process.env.TEST_USER || 'admin';
const TEST_PASS = process.env.TEST_PASS || '';

// ── HTTP client ────────────────────────────────────────────────────────────────
// Uses Node's https module directly so we can control TLS options (e.g. force
// IPv4) regardless of the platform's default SSL library behaviour.
const https = require('https');
const http  = require('http');
const { URL } = require('url');

function request(method, urlStr, body, authToken) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (payload)   headers['Content-Length'] = Buffer.byteLength(payload);

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers,
      family: 4,                      // force IPv4 — avoids IPv6/TLS edge issues
      rejectUnauthorized: true,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, res => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(buf) });
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

// ── Shared state passed between tests ─────────────────────────────────────────
let token     = null;   // JWT from login
let allLists  = [];     // flat list of { id, name, provider } from all providers
let allTasks  = [];     // flat list of tasks from first list of each provider
let sampleTask = null;  // one task used for the detail test

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(method, path, body, authToken) {
  return request(method, `${BASE_URL}${path}`, body, authToken);
}

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  ✓  ${msg}`);
  passed++;
}

function fail(msg, detail) {
  console.error(`  ✗  ${msg}`);
  if (detail) console.error(`     ${JSON.stringify(detail)}`);
  failed++;
}

function assert(condition, passMsg, failMsg, detail) {
  condition ? pass(passMsg) : fail(failMsg, detail);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ── Test 1: Authentication & List All Providers ────────────────────────────────

async function testAuthAndLists() {
  section('Test 1: Login + Retrieve All Lists');

  // 1a. Health check
  const health = await api('GET', '/health');
  assert(
    health.status === 200 && health.data.status === 'ok',
    `Server healthy (${BASE_URL})`,
    'Server health check failed',
    health.data
  );
  if (health.status !== 200) return; // no point continuing

  // 1b. Login
  const login = await api('POST', '/auth/login', { username: TEST_USER, password: TEST_PASS });
  assert(
    login.status === 200 && login.data.token,
    `Logged in as "${TEST_USER}"`,
    `Login failed for "${TEST_USER}"`,
    login.data
  );
  if (!login.data.token) return;
  token = login.data.token;

  // 1c. Confirm /auth/me returns the expected user
  const me = await api('GET', '/auth/me', null, token);
  assert(
    me.status === 200 && me.data.user?.username === TEST_USER,
    `/auth/me confirms identity (username: ${me.data.user?.username})`,
    '/auth/me returned unexpected user',
    me.data
  );

  // 1d. Check which providers are live
  const status = await api('GET', '/auth/providers/status', null, token);
  assert(
    status.status === 200,
    '/auth/providers/status returned 200',
    '/auth/providers/status failed',
    status.data
  );
  const connectedProviders = Object.entries(status.data)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (connectedProviders.length === 0) {
    fail('No providers are authorized — re-authorize at least one in Settings and re-run');
    return;
  }
  pass(`Connected providers: ${connectedProviders.join(', ')}`);

  // 1e. Fetch lists from each connected provider
  for (const provider of connectedProviders) {
    const result = await api('GET', `/api/lists?provider=${provider}`, null, token);
    if (result.status !== 200 || result.data.error) {
      fail(`GET /api/lists?provider=${provider} failed`, result.data);
      continue;
    }
    const lists = result.data.lists || [];
    assert(
      Array.isArray(lists),
      `${provider}: ${lists.length} list(s) returned`,
      `${provider}: lists response is not an array`,
      result.data
    );
    lists.forEach(l => allLists.push({ ...l, provider }));
    if (lists.length > 0) {
      lists.slice(0, 3).forEach(l => console.log(`       • [${provider}] ${l.name} (id: ${l.id})`));
      if (lists.length > 3) console.log(`       … and ${lists.length - 3} more`);
    }
  }

  assert(
    allLists.length > 0,
    `Total lists across all providers: ${allLists.length}`,
    'No lists found across any provider'
  );
}

// ── Test 2: Tasks from First List of Each Provider ─────────────────────────────

async function testTasksPerProvider() {
  section('Test 2: Retrieve Tasks from One List per Provider');

  if (!token) { fail('Skipped — no auth token (Test 1 must pass first)'); return; }
  if (allLists.length === 0) { fail('Skipped — no lists available (Test 1 must pass first)'); return; }

  // Pick the first list for each provider
  const byProvider = {};
  for (const list of allLists) {
    if (!byProvider[list.provider]) byProvider[list.provider] = list;
  }

  for (const [provider, list] of Object.entries(byProvider)) {
    console.log(`\n  Provider: ${provider} — list: "${list.name}" (${list.id})`);

    const result = await api(
      'GET',
      `/api/lists/${encodeURIComponent(list.id)}/tasks?provider=${provider}`,
      null,
      token
    );

    if (result.status !== 200 || result.data.error) {
      fail(`GET tasks for list "${list.name}" failed`, result.data);
      continue;
    }

    const tasks = result.data.tasks || [];
    assert(
      Array.isArray(tasks),
      `${provider} / "${list.name}": ${tasks.length} task(s) returned`,
      `${provider} / "${list.name}": tasks response is not an array`,
      result.data
    );

    tasks.forEach(t => allTasks.push({ ...t, provider, listId: list.id }));

    if (tasks.length > 0) {
      tasks.slice(0, 3).forEach(t => {
        const due   = t.dueDate     ? ` — due ${t.dueDate}` : '';
        const cls   = t.classification ? ` [${t.classification}]` : '';
        console.log(`       • ${t.name}${due}${cls}`);
      });
      if (tasks.length > 3) console.log(`       … and ${tasks.length - 3} more`);
    } else {
      console.log('       (list is empty)');
    }
  }

  // Pick a sample task for Test 3 — prefer one with an id
  sampleTask = allTasks.find(t => t.id) || null;
  assert(
    allTasks.length > 0,
    `Total tasks retrieved across all sampled lists: ${allTasks.length}`,
    'No tasks found in any sampled list'
  );
}

// ── Test 3: Task Detail ────────────────────────────────────────────────────────

async function testTaskDetail() {
  section('Test 3: Retrieve Full Task Detail');

  if (!token) { fail('Skipped — no auth token (Test 1 must pass first)'); return; }
  if (!sampleTask) { fail('Skipped — no sample task available (Test 2 must return at least one task)'); return; }

  console.log(`  Task:     "${sampleTask.name}"`);
  console.log(`  Provider: ${sampleTask.provider}`);
  console.log(`  List ID:  ${sampleTask.listId}`);
  console.log(`  Task ID:  ${sampleTask.id}`);

  const result = await api(
    'GET',
    `/api/lists/${encodeURIComponent(sampleTask.listId)}/tasks/${encodeURIComponent(sampleTask.id)}?provider=${sampleTask.provider}`,
    null,
    token
  );

  assert(
    result.status === 200 && !result.data.error,
    'Task detail request returned 200',
    'Task detail request failed',
    result.data
  );

  if (result.status === 200 && result.data.task) {
    const t = result.data.task;
    assert(t.id   === sampleTask.id,   `id matches: ${t.id}`,   'Task id mismatch');
    assert(typeof t.name === 'string', `name: "${t.name}"`,      'Task name missing');
    assert('completed' in t,           `completed: ${t.completed}`, 'completed field missing');

    // Print all non-null fields from the detail response
    console.log('\n  Full task detail:');
    const detail = result.data.task;
    for (const [k, v] of Object.entries(detail)) {
      if (v !== null && v !== undefined && v !== '') {
        console.log(`    ${k.padEnd(18)} ${JSON.stringify(v)}`);
      }
    }
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('Integration Tests — hb-task-server-enterprise');
  console.log(`Server: ${BASE_URL}`);
  console.log(`User:   ${TEST_USER}`);
  console.log('═'.repeat(62));

  await testAuthAndLists();
  await testTasksPerProvider();
  await testTaskDetail();

  console.log('\n' + '═'.repeat(62));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(62));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Unexpected error:', err.message);
  if (err.cause) console.error('Caused by:', err.cause.message || err.cause);
  process.exit(1);
});
