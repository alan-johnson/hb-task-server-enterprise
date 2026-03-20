const { google } = require('googleapis');

class GoogleTasksProvider {
  constructor(config) {
    this.name = 'Google Tasks';
    this.config = config;
    this.oauth2Client = null;
    this.tasksApi = null;
  }

  // Initialize OAuth2 client
  async initialize(accessToken, refreshToken, onTokenRefresh) {
    this.oauth2Client = new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );

    if (accessToken) {
      this.oauth2Client.setCredentials({
        access_token:  accessToken,
        refresh_token: refreshToken
      });
    } else {
      throw new Error('Google Tasks requires authentication. Please provide access token.');
    }

    // When the Google client silently refreshes an expired access token, save
    // the new token back to the database so the next server restart uses it.
    if (onTokenRefresh) {
      this.oauth2Client.on('tokens', (tokens) => {
        onTokenRefresh({
          accessToken:  tokens.access_token  || accessToken,
          refreshToken: tokens.refresh_token || refreshToken,
        }).catch(err => console.error('Failed to save refreshed Google token:', err.message));
      });
    }

    this.tasksApi = google.tasks({ version: 'v1', auth: this.oauth2Client });
  }

  // Get authorization URL for OAuth flow
  getAuthUrl() {
    const oauth2Client = new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/tasks']
    });
  }

  // Exchange authorization code for tokens
  async getTokensFromCode(code) {
    const oauth2Client = new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
  }

  // Get all task lists
  async getLists() {
    if (!this.tasksApi) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const response = await this.tasksApi.tasklists.list();

    return response.data.items.map(list => ({
      id: list.id,
      name: list.title,
      updated: list.updated
    }));
  }

  // Get tasks from a specific list
  async getTasks(listId) {
    if (!this.tasksApi) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const response = await this.tasksApi.tasks.list({
      tasklist: listId,
      showCompleted: true,
      showHidden: true
    });

    if (!response.data.items) {
      return [];
    }

    return response.data.items.map(task => ({
      id: task.id,
      name: task.title,
      completed: task.status === 'completed',
      priority: 'low',
      notes: task.notes,
      dueDate: task.due,
      updated: task.updated,
      position: task.position
    }));
  }

  // Get task details
  async getTask(listId, taskId) {
    if (!this.tasksApi) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const response = await this.tasksApi.tasks.get({
      tasklist: listId,
      task: taskId
    });

    const task = response.data;

    return {
      id: task.id,
      name: task.title,
      completed: task.status === 'completed',
      priority: 'low',
      notes: task.notes,
      dueDate: task.due,
      updated: task.updated,
      position: task.position,
      parent: task.parent,
      links: task.links
    };
  }

  // Mark task as complete
  async completeTask(listId, taskId) {
    if (!this.tasksApi) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    await this.tasksApi.tasks.update({
      tasklist: listId,
      task: taskId,
      requestBody: {
        status: 'completed'
      }
    });

    return { success: true, message: 'Task marked as complete' };
  }

  // Get task counts for all lists in parallel
  async getListCounts(onlyIncomplete = false) {
    const lists = await this.getLists();
    const counts = {};
    await Promise.all(lists.map(async (list) => {
      try {
        const tasks = await this.getTasks(list.id);
        counts[list.id] = onlyIncomplete ? tasks.filter(t => !t.completed).length : tasks.length;
      } catch {
        counts[list.id] = 0;
      }
    }));
    return counts;
  }

  // Update an existing task
  async updateTask(listId, taskId, taskData) {
    if (!this.tasksApi) throw new Error('Client not initialized. Call initialize() first.');

    const patch = {};
    if (taskData.name)                patch.title = taskData.name;
    if (taskData.notes !== undefined)  patch.notes = taskData.notes || '';
    if (taskData.dueDate)              patch.due = `${taskData.dueDate}T00:00:00.000Z`;
    else if (taskData.dueDate === null) patch.due = null;

    await this.tasksApi.tasks.patch({ tasklist: listId, task: taskId, requestBody: patch });
    return { success: true, message: 'Task updated' };
  }

  // Delete a task
  async deleteTask(listId, taskId) {
    if (!this.tasksApi) throw new Error('Client not initialized. Call initialize() first.');
    await this.tasksApi.tasks.delete({ tasklist: listId, task: taskId });
    return { success: true, message: 'Task deleted' };
  }

  // Create a new task
  async createTask(listId, taskData) {
    if (!this.tasksApi) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const taskPayload = {
      title: taskData.name || taskData.title || 'Untitled Task'
    };

    if (taskData.notes || taskData.description) {
      taskPayload.notes = taskData.notes || taskData.description;
    }

    if (taskData.dueDate) {
      taskPayload.due = taskData.dueDate;
    }

    const response = await this.tasksApi.tasks.insert({
      tasklist: listId,
      requestBody: taskPayload
    });

    return {
      id: response.data.id,
      name: response.data.title
    };
  }
}

module.exports = GoogleTasksProvider;
