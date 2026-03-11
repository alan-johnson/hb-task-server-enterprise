/**
 * Handsbreadth Task Server
 * Copyright (c) 2026 Handsbreadth Software LLC.
 * All rights reserved.
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const AUTH_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

class BridgeServer {
  constructor() {
    this.wss = new WebSocket.Server({ noServer: true });
    // userId -> { ws, pending: Map<id, {resolve, reject, timer}> }
    this.connections = new Map();
    this._getUserIdByApiKey = null;

    this.wss.on('connection', (ws) => this._onConnection(ws));
  }

  // Attach to an existing HTTP server; getUserIdByApiKey is an async function.
  attach(httpServer, getUserIdByApiKey) {
    this._getUserIdByApiKey = getUserIdByApiKey;

    httpServer.on('upgrade', (req, socket, head) => {
      const pathname = req.url.split('?')[0];
      if (pathname !== '/bridge') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws);
      });
    });
  }

  isConnected(userId) {
    const conn = this.connections.get(userId);
    return !!(conn && conn.ws.readyState === WebSocket.OPEN);
  }

  async request(userId, method, params = {}) {
    const conn = this.connections.get(userId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Apple Reminders bridge is not connected. Ensure hb-task-server is running and configured with a valid BRIDGE_API_KEY.');
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();

      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error('Bridge request timed out after 60 seconds'));
      }, REQUEST_TIMEOUT_MS);

      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  _onConnection(ws) {
    let userId = null;
    const pending = new Map();

    const authTimeout = setTimeout(() => {
      ws.close(4001, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      } else {
        clearInterval(pingInterval);
      }
    }, PING_INTERVAL_MS);

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // --- Auth handshake ---
      if (!userId) {
        if (msg.type !== 'auth' || !msg.apiKey) {
          ws.close(4002, 'Expected auth message');
          return;
        }
        clearTimeout(authTimeout);

        const resolvedUserId = await this._getUserIdByApiKey(msg.apiKey).catch(() => null);
        if (!resolvedUserId) {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid API key' }));
          ws.close(4003, 'Invalid API key');
          return;
        }

        // Replace any existing connection for this user
        const existing = this.connections.get(resolvedUserId);
        if (existing) existing.ws.close(4000, 'Replaced by new connection');

        userId = resolvedUserId;
        this.connections.set(userId, { ws, pending });
        ws.send(JSON.stringify({ type: 'auth_ok', userId }));
        console.log(`Bridge: user ${userId} connected`);
        return;
      }

      // --- Response from local server ---
      if (msg.type === 'response') {
        const req = pending.get(msg.id);
        if (!req) return;
        clearTimeout(req.timer);
        pending.delete(msg.id);
        if (msg.error) req.reject(new Error(msg.error));
        else req.resolve(msg.result);
        return;
      }

      if (msg.type === 'pong') return;
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      if (userId && this.connections.get(userId)?.ws === ws) {
        this.connections.delete(userId);
        console.log(`Bridge: user ${userId} disconnected`);
      }
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Bridge connection closed'));
      }
      pending.clear();
    });

    ws.on('error', (err) => {
      console.error('Bridge: WebSocket error —', err.message);
    });
  }
}

module.exports = new BridgeServer();
