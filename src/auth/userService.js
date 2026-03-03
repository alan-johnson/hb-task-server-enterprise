const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const path = require('path');

class UserService {
  constructor(dataDir = './data') {
    this.dataDir = dataDir;
    this.usersFile = path.join(dataDir, 'users.json');
    this.credentialsFile = path.join(dataDir, 'user-credentials.json');
    this.users = new Map();
    this.userCredentials = new Map(); // userId -> { provider -> credentials }
  }

  // Initialize the service
  async initialize() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await this.loadUsers();
      await this.loadCredentials();
    } catch (error) {
      console.error('Failed to initialize UserService:', error.message);
    }
  }

  // Load users from file
  async loadUsers() {
    try {
      const data = await fs.readFile(this.usersFile, 'utf-8');
      const users = JSON.parse(data);
      this.users = new Map(Object.entries(users));
    } catch (error) {
      // File doesn't exist yet, that's ok
      this.users = new Map();
    }
  }

  // Save users to file
  async saveUsers() {
    const usersObj = Object.fromEntries(this.users);
    await fs.writeFile(this.usersFile, JSON.stringify(usersObj, null, 2));
  }

  // Load user credentials from file
  async loadCredentials() {
    try {
      const data = await fs.readFile(this.credentialsFile, 'utf-8');
      const credentials = JSON.parse(data);
      this.userCredentials = new Map(Object.entries(credentials));
    } catch (error) {
      // File doesn't exist yet, that's ok
      this.userCredentials = new Map();
    }
  }

  // Save user credentials to file
  async saveCredentials() {
    const credsObj = Object.fromEntries(this.userCredentials);
    await fs.writeFile(this.credentialsFile, JSON.stringify(credsObj, null, 2));
  }

  // Register a new user
  async register(username, password, email) {
    if (this.users.has(username)) {
      throw new Error('Username already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = Date.now().toString() + Math.random().toString(36).substring(2);

    const user = {
      userId,
      username,
      email,
      passwordHash: hashedPassword,
      createdAt: new Date().toISOString(),
      defaultProvider: 'apple'
    };

    this.users.set(username, user);
    this.userCredentials.set(userId, {});
    
    await this.saveUsers();
    await this.saveCredentials();

    return {
      userId: user.userId,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt
    };
  }

  // Authenticate a user
  async authenticate(username, password) {
    const user = this.users.get(username);
    
    if (!user) {
      throw new Error('Invalid username or password');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    
    if (!isValid) {
      throw new Error('Invalid username or password');
    }

    return {
      userId: user.userId,
      username: user.username,
      email: user.email
    };
  }

  // Get user by ID
  getUser(userId) {
    for (const user of this.users.values()) {
      if (user.userId === userId) {
        return {
          userId: user.userId,
          username: user.username,
          email: user.email,
          defaultProvider: user.defaultProvider
        };
      }
    }
    return null;
  }

  // Store provider credentials for a user
  async storeCredentials(userId, provider, credentials) {
    let userCreds = this.userCredentials.get(userId) || {};
    userCreds[provider] = {
      ...credentials,
      updatedAt: new Date().toISOString()
    };
    this.userCredentials.set(userId, userCreds);
    await this.saveCredentials();
  }

  // Get provider credentials for a user
  getCredentials(userId, provider) {
    const userCreds = this.userCredentials.get(userId);
    if (!userCreds) return null;
    return userCreds[provider] || null;
  }

  // Remove provider credentials for a user
  async removeCredentials(userId, provider) {
    const userCreds = this.userCredentials.get(userId);
    if (userCreds && userCreds[provider]) {
      delete userCreds[provider];
      this.userCredentials.set(userId, userCreds);
      await this.saveCredentials();
      return true;
    }
    return false;
  }

  // Update user's default provider
  async updateDefaultProvider(userId, provider) {
    for (const [username, user] of this.users.entries()) {
      if (user.userId === userId) {
        user.defaultProvider = provider;
        this.users.set(username, user);
        await this.saveUsers();
        return true;
      }
    }
    return false;
  }
}

module.exports = UserService;
