/**
 * Handsbreadth Task Server
 * Copyright (c) 2026 Handsbreadth Software LLC.
 * All rights reserved.
 */

const bridgeServer = require('../bridge-server');

/**
 * Apple Reminders provider that routes all calls through the WebSocket bridge
 * to the user's local hb-task-server instance. No OAuth or credentials needed —
 * authentication is handled by the bridge API key at connection time.
 */
class AppleBridgeProvider {
  constructor(userId) {
    this.userId = userId;
  }

  async getLists() {
    return bridgeServer.request(this.userId, 'getLists');
  }

  async getTasks(listId, options = {}) {
    return bridgeServer.request(this.userId, 'getTasks', { listId, options });
  }

  async getTask(listId, taskId) {
    return bridgeServer.request(this.userId, 'getTask', { listId, taskId });
  }

  async createTask(listId, taskData) {
    return bridgeServer.request(this.userId, 'createTask', { listId, taskData });
  }

  async updateTask(listId, taskId, taskData) {
    return bridgeServer.request(this.userId, 'updateTask', { listId, taskId, taskData });
  }

  async completeTask(listId, taskId) {
    return bridgeServer.request(this.userId, 'completeTask', { listId, taskId });
  }

  async deleteTask(listId, taskId) {
    return bridgeServer.request(this.userId, 'deleteTask', { listId, taskId });
  }

  async getListCounts(onlyIncomplete) {
    return bridgeServer.request(this.userId, 'getListCounts', { onlyIncomplete });
  }
}

module.exports = AppleBridgeProvider;
