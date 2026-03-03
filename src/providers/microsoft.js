const { Client } = require('@microsoft/microsoft-graph-client');
const { ClientSecretCredential } = require('@azure/identity');

class MicrosoftTasksProvider {
  constructor(config) {
    this.name = 'Microsoft Tasks';
    this.config = config;
    this.client = null;
    this.accessToken = null;
  }

  // Initialize Graph client
  async initialize(accessToken) {
    if (accessToken) {
      this.accessToken = accessToken;
      this.client = Client.init({
        authProvider: (done) => {
          done(null, accessToken);
        }
      });
    } else if (this.config.clientId && this.config.clientSecret && this.config.tenantId) {
      // Use client credentials flow (for service-to-service)
      const credential = new ClientSecretCredential(
        this.config.tenantId,
        this.config.clientId,
        this.config.clientSecret
      );
      
      const tokenResponse = await credential.getToken('https://graph.microsoft.com/.default');
      this.accessToken = tokenResponse.token;
      
      this.client = Client.init({
        authProvider: (done) => {
          done(null, this.accessToken);
        }
      });
    } else {
      throw new Error('Microsoft Tasks requires authentication. Please provide access token or credentials.');
    }
  }

  // Get all task lists
  async getLists() {
    if (!this.client) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const response = await this.client
      .api('/me/todo/lists')
      .get();

    return response.value.map(list => ({
      id: list.id,
      name: list.displayName,
      isOwner: list.isOwner,
      isShared: list.isShared
    }));
  }

  // Get tasks from a specific list
  async getTasks(listId) {
    if (!this.client) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const response = await this.client
      .api(`/me/todo/lists/${listId}/tasks`)
      .get();

    return response.value.map(task => ({
      id: task.id,
      name: task.title,
      completed: task.status === 'completed',
      importance: task.importance,
      dueDate: task.dueDateTime?.dateTime,
      createdDate: task.createdDateTime,
      body: task.body?.content
    }));
  }

  // Get task details
  async getTask(listId, taskId) {
    if (!this.client) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const task = await this.client
      .api(`/me/todo/lists/${listId}/tasks/${taskId}`)
      .get();

    return {
      id: task.id,
      name: task.title,
      completed: task.status === 'completed',
      importance: task.importance,
      dueDate: task.dueDateTime?.dateTime,
      createdDate: task.createdDateTime,
      lastModified: task.lastModifiedDateTime,
      body: task.body?.content,
      categories: task.categories
    };
  }

  // Mark task as complete
  async completeTask(listId, taskId) {
    if (!this.client) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    await this.client
      .api(`/me/todo/lists/${listId}/tasks/${taskId}`)
      .patch({
        status: 'completed'
      });

    return { success: true, message: 'Task marked as complete' };
  }

  // Create a new task
  async createTask(listId, taskData) {
    if (!this.client) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    const taskPayload = {
      title: taskData.name || taskData.title || 'Untitled Task'
    };

    if (taskData.notes || taskData.description) {
      taskPayload.body = {
        content: taskData.notes || taskData.description,
        contentType: 'text'
      };
    }

    if (taskData.dueDate) {
      taskPayload.dueDateTime = {
        dateTime: taskData.dueDate,
        timeZone: 'UTC'
      };
    }

    if (taskData.importance) {
      taskPayload.importance = taskData.importance;
    }

    const task = await this.client
      .api(`/me/todo/lists/${listId}/tasks`)
      .post(taskPayload);

    return {
      id: task.id,
      name: task.title
    };
  }
}

module.exports = MicrosoftTasksProvider;
