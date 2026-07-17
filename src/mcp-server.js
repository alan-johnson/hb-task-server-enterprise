#!/usr/bin/env node
// Standalone stdio MCP server for UpQ. Run locally by a developer, config'd
// via env vars — never a JWT/password, only a upq_live_/upq_sandbox_ API
// key minted via POST /auth/api-keys. See docs/quickstart.md.
//
//   UPQ_API_BASE_URL=https://tasks.handsbreadth.com UPQ_API_KEY=upq_live_... node src/mcp-server.js
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createUpqMcpServer } = require('./mcp/tools');

async function main() {
  const baseUrl = process.env.UPQ_API_BASE_URL || 'https://tasks.handsbreadth.com';
  const apiKey = process.env.UPQ_API_KEY;
  if (!apiKey) {
    console.error('UPQ_API_KEY env var is required (mint one with POST /auth/api-keys)');
    process.exit(1);
  }

  const server = createUpqMcpServer({ baseUrl: baseUrl.replace(/\/$/, ''), apiKey });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`UpQ MCP server (stdio) connected — wrapping ${baseUrl}`);
}

main().catch(err => {
  console.error('UpQ MCP server failed to start:', err);
  process.exit(1);
});
