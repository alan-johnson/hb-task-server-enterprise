const { buildFixtures } = require('./sandboxFixtures');

// In-memory task store, one deep-cloned fixture set per sandbox API key.
// Process-local: state does not survive a restart and isn't shared across
// instances if the app ever scales horizontally — acceptable for a beta,
// documented in the quickstart.
const stores = new Map();

function cloneFixtures() {
  return JSON.parse(JSON.stringify(buildFixtures()));
}

function getStore(keyId) {
  if (!stores.has(keyId)) stores.set(keyId, cloneFixtures());
  return stores.get(keyId);
}

function resetStore(keyId) {
  stores.set(keyId, cloneFixtures());
}

// Mirrors the getLists()/getTasks()/createTask()/... interface implemented
// by src/providers/{microsoft,google}.js so it can be selected through the
// same getProviderForUser() seam in task-server.js.
class SandboxProvider {
  constructor(keyId) {
    this.keyId = keyId;
  }

  async getLists() {
    return getStore(this.keyId).lists.map(l => ({ ...l }));
  }

  async getTasks(listId) {
    const tasks = getStore(this.keyId).tasks[listId];
    if (!tasks) throw new Error(`Sandbox list not found: ${listId}`);
    return tasks.map(t => ({ ...t }));
  }

  async getTask(listId, taskId) {
    const tasks = getStore(this.keyId).tasks[listId];
    const task = tasks?.find(t => t.id === taskId);
    if (!task) throw new Error(`Sandbox task not found: ${taskId}`);
    return { ...task };
  }

  async createTask(listId, taskData) {
    const store = getStore(this.keyId);
    const tasks = store.tasks[listId];
    if (!tasks) throw new Error(`Sandbox list not found: ${listId}`);
    const task = {
      id: `sandbox-task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: taskData.name || taskData.title || 'Untitled Task',
      completed: false,
      priority: taskData.priority || 'low',
      notes: taskData.notes || taskData.description || '',
      dueDate: taskData.dueDate || null,
      updated: new Date().toISOString(),
      position: String(tasks.length + 1)
    };
    tasks.push(task);
    return { ...task };
  }

  async updateTask(listId, taskId, taskData) {
    const tasks = getStore(this.keyId).tasks[listId];
    const task = tasks?.find(t => t.id === taskId);
    if (!task) throw new Error(`Sandbox task not found: ${taskId}`);
    if (taskData.name !== undefined) task.name = taskData.name;
    if (taskData.notes !== undefined) task.notes = taskData.notes;
    if (taskData.priority !== undefined) task.priority = taskData.priority;
    if (taskData.dueDate !== undefined) task.dueDate = taskData.dueDate;
    task.updated = new Date().toISOString();
    return { success: true, message: 'Task updated' };
  }

  async completeTask(listId, taskId) {
    const tasks = getStore(this.keyId).tasks[listId];
    const task = tasks?.find(t => t.id === taskId);
    if (!task) throw new Error(`Sandbox task not found: ${taskId}`);
    task.completed = true;
    task.updated = new Date().toISOString();
    return { success: true, message: 'Task marked as complete' };
  }

  async deleteTask(listId, taskId) {
    const tasks = getStore(this.keyId).tasks[listId];
    const idx = tasks?.findIndex(t => t.id === taskId);
    if (idx === undefined || idx === -1) throw new Error(`Sandbox task not found: ${taskId}`);
    tasks.splice(idx, 1);
    return { success: true, message: 'Task deleted' };
  }

  async getListCounts(onlyIncomplete = false) {
    const store = getStore(this.keyId);
    const counts = {};
    for (const list of store.lists) {
      const tasks = store.tasks[list.id] || [];
      counts[list.id] = onlyIncomplete ? tasks.filter(t => !t.completed).length : tasks.length;
    }
    return counts;
  }
}

module.exports = SandboxProvider;
module.exports.resetStore = resetStore;
