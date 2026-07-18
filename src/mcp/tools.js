const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const upqClient = require('./upqClient');

// Maps a thrown upqClient error (which carries the unified {code,message}
// error shape from src/errors.js when the wrapped route uses it) onto an
// MCP tool error result, so an agent can tell rate_limited/unauthorized/
// provider_error apart and decide retry vs re-auth vs give up — the gap
// called out in the lean beta plan's own MCP readiness review.
function toolError(err) {
  const code = err.code || (err.status ? String(err.status) : 'internal_error');
  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${err.message}` }]
  };
}

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Builds a fresh McpServer bound to one caller's UpQ API key. Called once
// per stdio process (long-lived) and once per hosted-transport request
// (stateless, per the MCP SDK's recommended stateless-HTTP pattern) — see
// src/mcp-server.js and the /mcp route in task-server.js respectively.
function createUpqMcpServer({ baseUrl, apiKey }) {
  const server = new McpServer({ name: 'upq', version: '1.0.0' });

  server.registerTool(
    'get_triage',
    {
      title: 'Get UpQ triage (Now/Next/Later)',
      description: 'Returns the caller\'s tasks across all connected providers, triaged into Now/Next/Later. Optionally scope to specific lists.',
      inputSchema: {
        list_id: z.string().optional().describe('Comma-separated list IDs to include'),
        exclude_list: z.string().optional().describe('Comma-separated list IDs to exclude')
      }
    },
    async ({ list_id, exclude_list }) => {
      try {
        const data = await upqClient.getTriage(baseUrl, apiKey, { listId: list_id, excludeList: exclude_list });
        return jsonResult(data);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    'get_rules',
    {
      title: 'Get triage rules',
      description: 'Returns the caller\'s current Now/Next/Later classification rules (or server defaults if none set).',
      inputSchema: {}
    },
    async () => {
      try {
        const data = await upqClient.getRules(baseUrl, apiKey);
        return jsonResult(data);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    'set_rules',
    {
      title: 'Set triage rules',
      description: 'Replaces the caller\'s Now/Next/Later classification rules. Two shapes: the legacy {overdue,priorities} form, or a schemaVersion:2 predicate tree ({any:[...]}/{all:[...]}/{not:...}) for expressing combinations like "high priority AND due within 3 days" that the legacy form cannot.',
      inputSchema: {
        schemaVersion: z.literal(2).optional().describe('Set to 2 to use predicate-tree rules for now/next/later instead of the legacy {overdue,priorities} shape; omit entirely for legacy rules'),
        now: z.object({}).passthrough().describe('Now bucket rule — legacy: {"overdue":true,"priorities":["high"]}; schemaVersion:2: a predicate tree, e.g. {"any":[{"field":"dueDate","op":"overdue"},{"field":"priority","op":"eq","value":"high"}]}'),
        next: z.object({}).passthrough().describe('Next bucket rule, e.g. {"future_due":true,"priorities":["normal"]} or a schemaVersion:2 predicate tree'),
        later: z.object({}).passthrough().describe('Later bucket rule, e.g. {}')
      }
    },
    async ({ schemaVersion, now, next, later }) => {
      try {
        const data = await upqClient.setRules(baseUrl, apiKey, { schemaVersion, now, next, later });
        return jsonResult(data);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}

module.exports = { createUpqMcpServer };
