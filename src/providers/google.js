const { google } = require('googleapis');

class GoogleTasksProvider {
  constructor(config) {
    this.name = 'Google Tasks';
    this.config = config;
    this.oauth2Client = null;
    this.tasksApi = null;
  }

  // Initialize OAuth2 client
  async initialize(accessToken, refreshToken) {
    this.oauth2Client = new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );

    if (accessToken) {
      this.oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken
      });
    } else {
      throw new Error('Google Tasks requires authentication. Please provide access token.');
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
