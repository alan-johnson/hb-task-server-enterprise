require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const AppleRemindersProvider = require('./providers/apple');
const MicrosoftTasksProvider = require('./providers/microsoft');
const GoogleTasksProvider = require('./providers/google');
const AuthService = require('./auth/authService');
const UserService = require('./auth/userService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize services
const authService = new AuthService(process.env.JWT_SECRET);
const userService = new UserService(process.env.DATA_DIR || './data');

// Initialize user service
userService.initialize().then(() => {
  console.log('User service initialized');
}).catch(err => {
  console.error('Failed to initialize user service:', err);
});

// Provider factory - creates isolated instances per user
const providerFactories = {
  apple: () => new AppleRemindersProvider(),
  microsoft: (config) => new MicrosoftTasksProvider(config),
  google: (config) => new GoogleTasksProvider(config)
};

// Helper to get provider for the authenticated user
function getProviderForUser(req) {
  const providerName = req.query.provider || req.body.provider || req.user.defaultProvider || 'apple';
  const factory = providerFactories[providerName.toLowerCase()];
  
  if (!factory) {
    throw new Error(`Invalid provider: ${providerName}`);
  }

  // Create provider with user-specific config
  let provider;
  if (providerName === 'apple') {
    provider = factory();
  } else if (providerName === 'microsoft') {
    provider = factory({
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      tenantId: process.env.MICROSOFT_TENANT_ID,
      redirectUri: process.env.MICROSOFT_REDIRECT_URI
    });
  } else if (providerName === 'google') {
    provider = factory({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI
    });
  }
  
  return { provider, providerName };
}

// Initialize provider with user's credentials
async function initializeProvider(provider, providerName, userId) {
  if (providerName === 'apple') {
    // Apple Reminders doesn't need initialization
    // Each user accesses their own local Reminders
    return;
  }
  
  // Get user's stored credentials for this provider
  const credentials = await userService.getCredentials(userId, providerName);
  
  if (!credentials) {
    throw new Error(`${providerName} credentials not found. Please authenticate first.`);
  }
  
  if (providerName === 'microsoft') {
    await provider.initialize(credentials.accessToken);
  } else if (providerName === 'google') {
    await provider.initialize(credentials.accessToken, credentials.refreshToken);
  }
}

// ============================================
// Public Routes (No Authentication Required)
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Legal pages (clean URLs for Microsoft/Google app registration)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// Get available providers
app.get('/api/providers', (req, res) => {
  res.json({
    providers: ['apple', 'microsoft', 'google'],
    default: process.env.DEFAULT_PROVIDER || 'apple'
  });
});

// ============================================
// Authentication Routes
// ============================================

// Register new user
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await userService.register(username, password, email);
    const token = authService.generateToken(user.userId, user.username);
    
    res.status(201).json({
      message: 'User registered successfully',
      user,
      token
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await userService.authenticate(username, password);
    const token = authService.generateToken(user.userId, user.username);
    
    res.json({
      message: 'Login successful',
      user,
      token
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// Get current user info
app.get('/auth/me', authService.requireAuth(), async (req, res) => {
  const user = await userService.getUser(req.user.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user });
});

// Refresh JWT — issues a new 30-day token from a still-valid existing token
app.post('/auth/refresh', authService.requireAuth(), (req, res) => {
  const token = authService.generateToken(req.user.userId, req.user.username);
  res.json({ token });
});

// Get connected provider status for the current user
// Validates each token with a live API call rather than just checking storage.
app.get('/auth/providers/status', authService.requireAuth(), async (req, res) => {
  const status = { apple: true }; // always available on macOS
  await Promise.all(['microsoft', 'google'].map(async (p) => {
    try {
      const creds = await userService.getCredentials(req.user.userId, p);
      if (!creds) { status[p] = false; return; }
      const { provider } = getProviderForUser({ ...req, query: { provider: p }, body: {} });
      await initializeProvider(provider, p, req.user.userId);
      await provider.getLists();
      status[p] = true;
    } catch {
      status[p] = false;
    }
  }));
  res.json(status);
});

// ============================================
// Provider Authentication Routes (Protected)
// ============================================

// Google OAuth - Get auth URL
app.get('/auth/google/url', authService.requireAuth(), (req, res) => {
  try {
    const provider = new GoogleTasksProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI
    });
    
    const authUrl = provider.getAuthUrl();
    
    // Store user ID in session for callback
    // In production, use a proper session store
    const state = Buffer.from(JSON.stringify({
      userId: req.user.userId,
      timestamp: Date.now()
    })).toString('base64');
    
    res.json({ authUrl: `${authUrl}&state=${state}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Google OAuth - Callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!state) {
      return res.status(400).json({ error: 'Missing state parameter' });
    }
    
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const userId = stateData.userId;
    
    const provider = new GoogleTasksProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI
    });
    
    const tokens = await provider.getTokensFromCode(code);
    
    // Store credentials for this user
    await userService.storeCredentials(userId, 'google', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token
    });
    
    res.redirect('/dashboard.html?connected=google');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Microsoft OAuth - Get auth URL
app.get('/auth/microsoft/url', authService.requireAuth(), (req, res) => {
  try {
    const provider = new MicrosoftTasksProvider({
      clientId:     process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      tenantId:     process.env.MICROSOFT_TENANT_ID,
      redirectUri:  process.env.MICROSOFT_REDIRECT_URI,
    });
    const authUrl = provider.getAuthUrl();
    const state = Buffer.from(JSON.stringify({
      userId:    req.user.userId,
      timestamp: Date.now(),
    })).toString('base64');
    res.json({ authUrl: `${authUrl}&state=${state}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Microsoft OAuth - Callback
app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).json({ error, error_description });
    if (!state) return res.status(400).json({ error: 'Missing state parameter' });

    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const userId = stateData.userId;

    const provider = new MicrosoftTasksProvider({
      clientId:     process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      tenantId:     process.env.MICROSOFT_TENANT_ID,
      redirectUri:  process.env.MICROSOFT_REDIRECT_URI,
    });

    const tokens = await provider.getTokensFromCode(code);
    await userService.storeCredentials(userId, 'microsoft', {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token || null,
    });

    res.redirect('/dashboard.html?connected=microsoft');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Microsoft - Store access token (manual fallback)
app.post('/auth/microsoft/token', authService.requireAuth(), async (req, res) => {
  try {
    const { accessToken } = req.body;
    
    if (!accessToken) {
      return res.status(400).json({ error: 'Access token is required' });
    }
    
    await userService.storeCredentials(req.user.userId, 'microsoft', {
      accessToken
    });
    
    res.json({ 
      success: true,
      message: 'Microsoft Tasks connected successfully',
      provider: 'microsoft'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disconnect a provider
app.delete('/auth/provider/:provider', authService.requireAuth(), async (req, res) => {
  try {
    const { provider } = req.params;
    const removed = await userService.removeCredentials(req.user.userId, provider);
    
    if (removed) {
      res.json({ 
        success: true,
        message: `${provider} disconnected successfully` 
      });
    } else {
      res.status(404).json({ error: 'Provider not connected' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update default provider
app.patch('/auth/default-provider', authService.requireAuth(), async (req, res) => {
  try {
    const { provider } = req.body;
    
    if (!['apple', 'microsoft', 'google'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }
    
    await userService.updateDefaultProvider(req.user.userId, provider);
    
    res.json({ 
      success: true,
      defaultProvider: provider
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Task Lists Routes (Protected)
// ============================================

// Get all task lists for the authenticated user
app.get('/api/lists', authService.requireAuth(), async (req, res) => {
  try {
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);

    const lists = await provider.getLists();
    res.json({
      provider: providerName,
      user: req.user.username,
      lists
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Tasks Routes (Protected)
// ============================================

// Get all tasks in a list
app.get('/api/lists/:listId/tasks', authService.requireAuth(), async (req, res) => {
  try {
    const { listId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);
    
    const tasks = await provider.getTasks(listId);
    res.json({
      provider: providerName,
      user: req.user.username,
      listId,
      tasks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get task details
app.get('/api/lists/:listId/tasks/:taskId', authService.requireAuth(), async (req, res) => {
  try {
    const { listId, taskId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);
    
    const task = await provider.getTask(listId, taskId);
    res.json({
      provider: providerName,
      user: req.user.username,
      listId,
      task
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new task
app.post('/api/lists/:listId/tasks', authService.requireAuth(), async (req, res) => {
  try {
    const { listId } = req.params;
    const taskData = req.body;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);
    
    const task = await provider.createTask(listId, taskData);
    res.status(201).json({
      provider: providerName,
      user: req.user.username,
      listId,
      task
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark task as complete
app.patch('/api/lists/:listId/tasks/:taskId/complete', authService.requireAuth(), async (req, res) => {
  try {
    const { listId, taskId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);
    
    const result = await provider.completeTask(listId, taskId);
    res.json({
      provider: providerName,
      user: req.user.username,
      listId,
      taskId,
      ...result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Error handling
// ============================================

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ============================================
// Start server
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Multi-User Task Server running on http://localhost:${PORT}`);
  console.log(`Default provider: ${process.env.DEFAULT_PROVIDER || 'apple'}`);
  console.log('\n📝 Authentication endpoints:');
  console.log('  POST /auth/register');
  console.log('  POST /auth/login');
  console.log('  GET  /auth/me');
  console.log('\n🔗 Provider connection endpoints:');
  console.log('  GET    /auth/microsoft/url');
  console.log('  GET    /auth/microsoft/callback');
  console.log('  POST   /auth/microsoft/token  (manual fallback)');
  console.log('  GET    /auth/google/url');
  console.log('  GET    /auth/google/callback');
  console.log('  DELETE /auth/provider/:provider');
  console.log('  PATCH  /auth/default-provider');
  console.log('\n📋 Task endpoints (require authentication):');
  console.log('  GET    /api/lists?provider=apple|microsoft|google');
  console.log('  GET    /api/lists/:listId/tasks');
  console.log('  GET    /api/lists/:listId/tasks/:taskId');
  console.log('  POST   /api/lists/:listId/tasks');
  console.log('  PATCH  /api/lists/:listId/tasks/:taskId/complete');
  console.log('\n💡 All task endpoints require: Authorization: Bearer <token>');
});
