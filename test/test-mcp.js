#!/usr/bin/env node

/**
 * MCP Tests — hb-task-server-enterprise
 *
 * Verifies both MCP transports added for the UpQ lean beta:
 *   - stdio: spawns src/mcp-server.js as a child process and drives it with
 *     the MCP SDK's Client, the same way Claude Desktop/Code would.
 *   - hosted: issues a raw JSON-RPC request against POST /mcp on a running
 *     server.
 * Both wrap the sandbox provider, so this needs no live Microsoft/Google
 * connection — only a verified, logged-in account to mint a sandbox key.
 *
 * Usage:
 *   node test/test-mcp.js
 *   BASE_URL=http://localhost:3500 node test/test-mcp.js
 */

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const LOG_PATH  = path.join(__dirname, 'test-mcp.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
logStream.write(`\n${'═'.repeat(62)}\nTest run: ${new Date().toISOString()}\n${'═'.repeat(62)}\n`);

function writeLine(level, args) {
  logStream.write(`[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`);
}
const _log = console.log.bind(console), _error = console.error.bind(console);
console.log   = (...a) => { writeLine('LOG', a);   _log(...a); };
console.error = (...a) => { writeLine('ERROR', a); _error(...a); };

const BASE_URL  = process.env.BASE_URL  || 'https://tasks.handsbreadth.com';
const TEST_USER = process.env.TEST_USER || 'admin';
const TEST_PASS = process.env.TEST_PASS || '';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function request(method, urlStr, body, authToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = (isHttps ? https : http).request({
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search, method, headers, family: 4, rejectUnauthorized: true
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: buf ? JSON.parse(buf) : {} }); }
        catch (e) { reject(new Error(`Non-JSON response (${res.statusCode}): ${buf.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function api(method, p, body, authToken) { return request(method, `${BASE_URL}${p}`, body, authToken); }

let passed = 0, failed = 0;
function pass(msg) { console.log(`  ✓  ${msg}`); passed++; }
function fail(msg, detail) { console.error(`  ✗  ${msg}`); if (detail) console.error(`     ${JSON.stringify(detail)}`); failed++; }
function assert(condition, passMsg, failMsg, detail) { condition ? pass(passMsg) : fail(failMsg, detail); }
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`); }

async function mintSandboxKey() {
  const login = await api('POST', '/auth/login', { username: TEST_USER, password: TEST_PASS });
  if (!login.data.token) throw new Error(`Login failed: ${JSON.stringify(login.data)}`);
  const created = await api('POST', '/auth/api-keys', { name: 'test-mcp', sandbox: true }, login.data.token);
  if (!created.data.apiKey) throw new Error(`Key mint failed: ${JSON.stringify(created.data)}`);
  return { jwt: login.data.token, keyId: created.data.id, apiKey: created.data.apiKey };
}

async function revokeKey(jwt, keyId) {
  await api('DELETE', `/auth/api-keys/${keyId}`, null, jwt);
}

async function testStdioTransport(apiKey) {
  section('Stdio transport (spawns src/mcp-server.js)');

  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, '..', 'src', 'mcp-server.js')],
    env: { ...process.env, UPQ_API_BASE_URL: BASE_URL, UPQ_API_KEY: apiKey }
  });
  const client = new Client({ name: 'test-mcp-client', version: '1.0' });

  try {
    await client.connect(transport);
    pass('Connected to stdio MCP server');

    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    assert(['get_triage', 'get_rules', 'set_rules'].every(n => names.includes(n)),
      `tools/list returned expected tools (${names.join(', ')})`, 'Missing expected tools', names);

    const rules = await client.callTool({ name: 'get_rules', arguments: {} });
    assert(!rules.isError, 'get_rules tool call succeeded', 'get_rules tool call failed', rules);

    const triage = await client.callTool({ name: 'get_triage', arguments: {} });
    assert(!triage.isError, 'get_triage tool call succeeded', 'get_triage tool call failed', triage);
    if (!triage.isError) {
      const parsed = JSON.parse(triage.content[0].text);
      assert(parsed.total === 9, `get_triage returned sandbox fixture data (total=${parsed.total})`, 'Unexpected triage total', parsed);
    }

    // set_rules with schemaVersion:2 — the tool's inputSchema previously only
    // declared now/next/later, so schemaVersion was silently dropped before
    // ever reaching the REST call. Confirms the fix actually round-trips
    // through the real stdio transport, not just that the code reads right.
    const setV2 = await client.callTool({
      name: 'set_rules',
      arguments: {
        schemaVersion: 2,
        now: { any: [{ field: 'dueDate', op: 'overdue' }, { field: 'priority', op: 'eq', value: 'high' }] },
        next: { field: 'dueDate', op: 'future_due' },
        later: {}
      }
    });
    assert(!setV2.isError, 'set_rules with schemaVersion:2 succeeded over MCP', 'set_rules(v2) tool call failed', setV2);
    if (!setV2.isError) {
      const saved = JSON.parse(setV2.content[0].text);
      assert(saved.rules?.schemaVersion === 2, 'schemaVersion:2 was actually persisted, not stripped', 'schemaVersion missing from the saved rules — the tool schema fix regressed', saved);
    }

    const triageAfterV2 = await client.callTool({ name: 'get_triage', arguments: {} });
    if (!triageAfterV2.isError) {
      const parsed = JSON.parse(triageAfterV2.content[0].text);
      const escalation = (parsed.tasks || []).find(t => t.name === 'Reply to client escalation');
      assert(escalation?.classification === 'now', 'Triage over MCP reflects the v2 rules just set (overdue high-priority task -> now)', 'v2 rules set via MCP did not affect triage', escalation);
    }

    // Reset — no MCP tool for this, use the REST route directly with the same key.
    await api('DELETE', '/auth/me/classification', null, apiKey);

    await client.close();
  } catch (err) {
    fail('Stdio transport test threw', err.message);
  }
}

// The MCP SDK's streamable HTTP transport frames its response as SSE
// ("data: {...}") even for a single JSON-RPC reply, so this uses its own
// minimal client rather than the plain-JSON request() helper above.
function rawMcpRequest(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}/mcp`);
    const isHttps = url.protocol === 'https:';
    const body = JSON.stringify(payload);
    const req = (isHttps ? https : http).request({
      hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
      path: url.pathname, method: 'POST', family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        const line = buf.split('\n').find(l => l.startsWith('data: '));
        try {
          resolve({ status: res.statusCode, data: line ? JSON.parse(line.slice(6)) : JSON.parse(buf) });
        } catch (e) {
          reject(new Error(`Unparseable MCP response (${res.statusCode}): ${buf.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function testHostedTransport(apiKey) {
  section('Hosted transport (POST /mcp)');

  const init = await rawMcpRequest(apiKey, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-mcp', version: '1.0' } }
  });
  assert(init.status === 200 && init.data.result?.serverInfo?.name === 'upq',
    'POST /mcp initialize handshake succeeded', 'Hosted MCP initialize failed', init.data);

  const call = await rawMcpRequest(apiKey, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_triage', arguments: {} }
  });
  assert(call.status === 200 && !call.data.result?.isError,
    'POST /mcp tools/call get_triage succeeded', 'Hosted MCP get_triage failed', call.data);
  if (call.data.result?.content?.[0]?.text) {
    const parsed = JSON.parse(call.data.result.content[0].text);
    assert(parsed.total === 9, `Hosted get_triage returned sandbox fixture data (total=${parsed.total})`, 'Unexpected hosted triage total', parsed);
  }
}

async function run() {
  console.log('MCP Tests — hb-task-server-enterprise');
  console.log(`Server: ${BASE_URL}`);
  console.log(`User:   ${TEST_USER}`);
  console.log('═'.repeat(62));

  let jwt, keyId, apiKey;
  try {
    ({ jwt, keyId, apiKey } = await mintSandboxKey());
  } catch (err) {
    fail('Setup: mint sandbox key', err.message);
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  await testStdioTransport(apiKey);
  await testHostedTransport(apiKey);

  await revokeKey(jwt, keyId);

  console.log('\n' + '═'.repeat(62));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(62));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
