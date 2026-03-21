require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const TOML = require('@iarna/toml');

// File logger — writes to app.log in the project root so logs are visible
// via cPanel File Manager when the hosting environment swallows stdout/stderr.
const LOG_FILE = path.join(__dirname, '..', 'app.log');
const _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function fileLog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  _logStream.write(line);
}
['log', 'warn', 'error'].forEach(level => {
  const orig = console[level].bind(console);
  console[level] = (...args) => { orig(...args); fileLog(`[${level.toUpperCase()}]`, ...args); };
});

const MicrosoftTasksProvider = require('./providers/microsoft');
const GoogleTasksProvider = require('./providers/google');
const AppleBridgeProvider = require('./providers/apple-bridge');
const bridgeServer = require('./bridge-server');
const AuthService = require('./auth/authService');
const UserService = require('./auth/userService');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const { sendVerificationEmail, resendVerificationEmail, sendPasswordResetEmail } = require('./emailService');

// Load classification config from TOML (once at startup)
const DEFAULT_CLASSIFICATION = {
  now:     { label: 'Now',     overdue: true, priorities: ['high'] },
  not_now: { label: 'Not Now', future_due: true, priorities: ['normal'] },
  later:   { label: 'Later' }
};

function loadClassificationConfig() {
  const configPath = process.env.CLASSIFICATION_CONFIG
    || path.join(__dirname, '..', 'config', 'classification.toml');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = TOML.parse(raw);
    console.log(`Classification config loaded from ${configPath}`);
    return parsed;
  } catch (err) {
    console.warn(`Could not load classification config (${err.message}); using defaults.`);
    return DEFAULT_CLASSIFICATION;
  }
}

const classificationConfig = loadClassificationConfig();

function classifyTask(task, rules) {
  if (task.completed) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let dueDate = null;
  if (task.dueDate) {
    const m = task.dueDate.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      dueDate = new Date(+m[1], +m[2] - 1, +m[3]);
    } else {
      const d = new Date(task.dueDate);
      if (!isNaN(d)) { dueDate = new Date(d); dueDate.setHours(0, 0, 0, 0); }
    }
  }

  const priority  = task.priority || 'low';
  const isOverdue = dueDate && dueDate <= today;
  const isFuture  = dueDate && dueDate > today;

  const nowMatch = (rules.now.overdue && isOverdue) ||
                   (rules.now.priorities && rules.now.priorities.includes(priority));
  if (nowMatch) return 'now';

  const notNowMatch = (rules.not_now.future_due && isFuture) ||
                      (rules.not_now.priorities && rules.not_now.priorities.includes(priority));
  if (notNowMatch) return 'not_now';

  return 'later';
}

const app = express();
const API_PORT = process.env.API_PORT || process.env.PORT || 3500;
// Base URL of the web server — used to redirect browsers after OAuth callbacks.
// If empty, relative redirects are used (works when this server is behind a proxy).
const WEB_URL = (process.env.WEB_URL || '').replace(/\/$/, '');

// Simple in-memory TTL cache
class SimpleCache {
  constructor() { this.store = new Map(); }
  get(key) {
    const e = this.store.get(key);
    if (!e || e.expires < Date.now()) { this.store.delete(key); return null; }
    return e.value;
  }
  set(key, value, ttlMs) {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }
  delete(key) { this.store.delete(key); }
  deletePrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}
const cache = new SimpleCache();
const TTL = {
  status: 5 * 60 * 1000,   // 5 min
  lists:  2 * 60 * 1000,   // 2 min
  counts: 2 * 60 * 1000,   // 2 min
  tasks:  2 * 60 * 1000     // 2 min
};

// Middleware
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// Stripe webhook needs raw body — must be registered before bodyParser.json()
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).json({ error: 'Webhook secret not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId) {
        await userService.updateSubscription(userId, session.customer, 'active');
        console.log(`Subscription activated for user ${userId}`);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const { pool } = require('./db/db');
      const result = await pool.query(
        'SELECT user_id FROM users WHERE stripe_customer_id = ?',
        [subscription.customer]
      );
      if (result.rows[0]) {
        await userService.updateSubscription(result.rows[0].user_id, subscription.customer, 'canceled');
        console.log(`Subscription canceled for customer ${subscription.customer}`);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

app.use(bodyParser.json());

// Initialize services
const authService = new AuthService(process.env.JWT_SECRET);
const userService = new UserService(process.env.DATA_DIR || './data');

userService.initialize().then(() => {
  console.log('User service initialized');
}).catch(err => {
  console.error('Failed to initialize user service:', err);
});

// Helper to get provider for the authenticated user
function getProviderForUser(req) {
  const providerName = (req.query.provider || req.body.provider || req.user.defaultProvider || 'microsoft').toLowerCase();

  let provider;
  switch (providerName) {
    case 'microsoft':
      provider = new MicrosoftTasksProvider({
        clientId:     process.env.MICROSOFT_CLIENT_ID,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
        tenantId:     process.env.MICROSOFT_TENANT_ID,
        redirectUri:  process.env.MICROSOFT_REDIRECT_URI
      });
      break;
    case 'google':
      provider = new GoogleTasksProvider({
        clientId:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        redirectUri:  process.env.GOOGLE_REDIRECT_URI
      });
      break;
    case 'apple':
      provider = new AppleBridgeProvider(req.user.userId);
      break;
    default:
      throw new Error(`Invalid provider: ${providerName}`);
  }

  return { provider, providerName };
}

// Initialize provider with user's credentials
async function initializeProvider(provider, providerName, userId) {
  if (providerName === 'apple') return; // no credentials needed; uses bridge

  const credentials = await userService.getCredentials(userId, providerName);

  if (!credentials) {
    throw new Error(`${providerName} credentials not found. Please authenticate first.`);
  }

  // Called by either provider when a token is silently refreshed, so the new
  // token is persisted and survives the next server restart.
  async function saveRefreshedTokens(tokens) {
    await userService.storeCredentials(userId, providerName, {
      accessToken:  tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    cache.delete(`status:${userId}:${providerName}`);
    console.log(`[token-refresh] Saved refreshed ${providerName} token for user ${userId}`);
  }

  if (providerName === 'microsoft') {
    await provider.initialize(credentials.accessToken, credentials.refreshToken, saveRefreshedTokens);

    // Proactively refresh if the stored token is older than 50 minutes —
    // Microsoft access tokens expire after 60 minutes.
    if (credentials.refreshToken) {
      const updatedAt   = credentials.updatedAt ? new Date(credentials.updatedAt) : null;
      const ageMinutes  = updatedAt ? (Date.now() - updatedAt.getTime()) / 60000 : Infinity;
      if (ageMinutes > 50) {
        try {
          await provider.refreshAccessToken();
          console.log(`[token-refresh] Proactively refreshed Microsoft token for user ${userId} (age: ${Math.round(ageMinutes)}m)`);
        } catch (err) {
          console.warn(`[token-refresh] Microsoft proactive refresh failed for user ${userId}: ${err.message}`);
        }
      }
    }
  } else if (providerName === 'google') {
    await provider.initialize(credentials.accessToken, credentials.refreshToken, saveRefreshedTokens);
  }
}

// ============================================
// Public Routes
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/providers', (req, res) => {
  const providers = ['microsoft', 'google'];
  res.json({ providers, default: process.env.DEFAULT_PROVIDER || 'microsoft' });
});

// ============================================
// Authentication Routes
// ============================================

app.post('/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'Username, password, and email are required' });
    }

    const user = await userService.register(username, password, email);

    // Generate a verification token and send the confirmation email
    const verificationToken = await userService.createVerificationToken(user.userId);
    const baseUrl = process.env.WEB_URL || 'http://localhost';
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${verificationToken}`;

    try {
      await sendVerificationEmail({
        to:        user.email,
        username:  user.username,
        verifyUrl,
        createdAt: user.createdAt,
      });
    } catch (emailErr) {
      console.error('Failed to send verification email:', emailErr.message);
      // Account is created; user can request a resend
    }

    res.status(201).json({ message: 'Account created. Please check your email to verify your address.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await userService.authenticate(username, password);
    const token = authService.generateToken(user.userId, user.username);

    res.json({ message: 'Login successful', user, token });
  } catch (error) {
    if (error.code === 'EMAIL_NOT_VERIFIED') {
      return res.status(403).json({ error: error.message, code: 'EMAIL_NOT_VERIFIED' });
    }
    res.status(401).json({ error: error.message });
  }
});

// GET /auth/verify-email?token=... — verify email, issue JWT, redirect to pricing
app.get('/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing verification token.');

  try {
    const user = await userService.verifyEmailToken(token);
    const jwt  = authService.generateToken(user.userId, user.username);
    const baseUrl = (process.env.WEB_URL || '').replace(/\/$/, '');
    // Pass JWT via URL fragment so it is never sent to any server
    res.redirect(`${baseUrl}/pricing.html#token=${jwt}`);
  } catch (err) {
    // Show a plain error page so the user knows what happened
    res.status(400).send(`
      <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <title>Verification Failed</title>
      <link rel="stylesheet" href="/style.css">
      </head><body class="auth-page">
      <header class="site-header hero">
        <img src="/images/handsbreadth-logo-web.png" alt="handsbreadth">
      </header>
      <div class="auth-wrap"><div class="auth-container">
        <h1 style="color:#c0392b">Verification Failed</h1>
        <p>${err.message}</p>
        <p><a href="/">Return to Sign In</a> and use the resend link if needed.</p>
      </div></div>
      <footer class="site-footer">Copyright 2026, handsbreadth LLC</footer>
      </body></html>
    `);
  }
});

// POST /auth/resend-verification — resend the verification email (no auth required)
app.post('/auth/resend-verification', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    const user = await userService.getUserByUsername(username);
    if (!user) return res.json({ message: 'If that account exists and is unverified, a new email has been sent.' });
    if (user.emailVerified) return res.json({ message: 'That account is already verified. Please sign in.' });

    const verificationToken = await userService.createVerificationToken(user.userId);
    const baseUrl = process.env.WEB_URL || 'http://localhost';
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${verificationToken}`;

    await resendVerificationEmail({
      to:        user.email,
      username:  user.username,
      verifyUrl,
      createdAt: user.createdAt || new Date().toISOString(),
    });

    res.json({ message: 'Verification email sent. Please check your inbox.' });
  } catch (err) {
    console.error('Resend verification error:', err.message);
    res.status(500).json({ error: 'Could not send verification email. Please try again later.' });
  }
});

// POST /auth/forgot-password — request a password-reset email (no auth required)
app.post('/auth/forgot-password', async (req, res) => {
  // Always respond with the same message to avoid leaking whether an email is registered
  const generic = { message: 'If that email is registered, a reset link has been sent.' };
  try {
    const { email } = req.body;
    if (!email) return res.json(generic);

    const result = await userService.createPasswordResetToken(email);
    if (result) {
      const resetUrl = `${WEB_URL}/reset-password.html?token=${result.token}`;
      await sendPasswordResetEmail({ to: result.email, username: result.username, resetUrl });
    }
    res.json(generic);
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.json(generic); // still generic — never reveal the error to the client
  }
});

// POST /auth/reset-password — set a new password using a valid reset token (no auth required)
app.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    await userService.resetPassword(token, newPassword);
    res.json({ message: 'Password updated. You can now sign in.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/auth/me', authService.requireAuth(), async (req, res) => {
  const user = await userService.getUser(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

app.post('/auth/refresh', authService.requireAuth(), (req, res) => {
  const token = authService.generateToken(req.user.userId, req.user.username);
  res.json({ token });
});

app.get('/auth/providers/status', authService.requireAuth(), async (req, res) => {
  const status = {};
  await Promise.all(['microsoft', 'google'].map(async (p) => {
    const cacheKey = `status:${req.user.userId}:${p}`;
    const cached = cache.get(cacheKey);
    if (cached !== null) { status[p] = cached; return; }
    try {
      const creds = await userService.getCredentials(req.user.userId, p);
      if (!creds) { cache.set(cacheKey, false, TTL.status); status[p] = false; return; }
      const { provider } = getProviderForUser({ ...req, query: { provider: p }, body: {} });
      await initializeProvider(provider, p, req.user.userId);
      await provider.getLists();
      cache.set(cacheKey, true, TTL.status);
      status[p] = true;
    } catch {
      cache.set(cacheKey, false, TTL.status);
      status[p] = false;
    }
  }));
  status.apple = bridgeServer.isConnected(req.user.userId);
  res.json(status);
});

// Returns whether credentials are stored for each provider — no live API call.
app.get('/auth/providers/authorized', authService.requireAuth(), async (req, res) => {
  const userId = req.user.userId;
  const [msCreds, gCreds] = await Promise.all([
    userService.getCredentials(userId, 'microsoft'),
    userService.getCredentials(userId, 'google'),
  ]);
  res.json({ microsoft: !!msCreds, google: !!gCreds });
});

// ============================================
// Provider OAuth Routes
// ============================================

app.get('/auth/google/url', authService.requireAuth(), (req, res) => {
  try {
    const provider = new GoogleTasksProvider({
      clientId:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri:  process.env.GOOGLE_REDIRECT_URI
    });

    const authUrl = provider.getAuthUrl();
    const state = Buffer.from(JSON.stringify({
      userId: req.user.userId,
      timestamp: Date.now()
    })).toString('base64');

    res.json({ authUrl: `${authUrl}&state=${state}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!state) return res.status(400).json({ error: 'Missing state parameter' });

    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const userId = stateData.userId;

    const provider = new GoogleTasksProvider({
      clientId:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri:  process.env.GOOGLE_REDIRECT_URI
    });

    const tokens = await provider.getTokensFromCode(code);

    await userService.storeCredentials(userId, 'google', {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token
    });
    cache.delete(`status:${userId}:google`);

    res.redirect(`${WEB_URL}/settings.html?connected=google`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
    cache.delete(`status:${userId}:microsoft`);

    res.redirect(`${WEB_URL}/settings.html?connected=microsoft`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/auth/microsoft/token', authService.requireAuth(), async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) return res.status(400).json({ error: 'Access token is required' });

    await userService.storeCredentials(req.user.userId, 'microsoft', { accessToken });
    cache.delete(`status:${req.user.userId}:microsoft`);

    res.json({ success: true, message: 'Microsoft Tasks connected successfully', provider: 'microsoft' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/auth/provider/:provider', authService.requireAuth(), async (req, res) => {
  try {
    const { provider } = req.params;
    const removed = await userService.removeCredentials(req.user.userId, provider);

    if (removed) {
      cache.deletePrefix(`status:${req.user.userId}:${provider}`);
      cache.deletePrefix(`lists:${req.user.userId}:${provider}`);
      cache.delete(`lists:all:${req.user.userId}`);
      cache.deletePrefix(`counts:${req.user.userId}:${provider}`);
      res.json({ success: true, message: `${provider} disconnected successfully` });
    } else {
      res.status(404).json({ error: 'Provider not connected' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/auth/preferences', authService.requireAuth(), async (req, res) => {
  try {
    const { showCompleted } = req.body;
    if (typeof showCompleted !== 'boolean') {
      return res.status(400).json({ error: 'showCompleted must be a boolean' });
    }
    await userService.updatePreferences(req.user.userId, { showCompleted });
    cache.deletePrefix(`counts:${req.user.userId}:`);
    res.json({ success: true, showCompleted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/auth/default-provider', authService.requireAuth(), async (req, res) => {
  try {
    const { provider } = req.body;

    const validProviders = ['microsoft', 'google', 'apple'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }

    await userService.updateDefaultProvider(req.user.userId, provider);
    res.json({ success: true, defaultProvider: provider });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Unified Settings
// ============================================

// GET /api/settings — returns all user settings in a single response.
// Response: { user, providers, bridge, classification }
app.get('/api/settings', authService.requireAuth(), async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, msCreds, gCreds, bridgeHasKey, classificationRules] = await Promise.all([
      userService.getUser(userId),
      userService.getCredentials(userId, 'microsoft'),
      userService.getCredentials(userId, 'google'),
      userService.hasBridgeApiKey(userId),
      userService.getClassificationRules(userId),
    ]);

    res.json({
      user: {
        username:        user.username,
        email:           user.email,
        defaultProvider: user.defaultProvider,
        showCompleted:   user.showCompleted,
      },
      providers: {
        microsoft: !!msCreds,
        google:    !!gCreds,
        apple:     bridgeServer.isConnected(userId),
      },
      bridge: {
        hasKey:    bridgeHasKey,
        connected: bridgeServer.isConnected(userId),
      },
      classification: {
        rules:    classificationRules || classificationConfig,
        isCustom: !!classificationRules,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/settings — update user preferences.
// Accepted fields: defaultProvider, showCompleted
app.patch('/api/settings', authService.requireAuth(), async (req, res) => {
  try {
    const { defaultProvider, showCompleted } = req.body;
    const userId = req.user.userId;
    const updates = {};

    if (defaultProvider !== undefined) {
      const valid = ['microsoft', 'google', 'apple'];
      if (!valid.includes(defaultProvider)) {
        return res.status(400).json({ error: 'Invalid defaultProvider' });
      }
      await userService.updateDefaultProvider(userId, defaultProvider);
      updates.defaultProvider = defaultProvider;
    }

    if (showCompleted !== undefined) {
      if (typeof showCompleted !== 'boolean') {
        return res.status(400).json({ error: 'showCompleted must be a boolean' });
      }
      await userService.updatePreferences(userId, { showCompleted });
      cache.deletePrefix(`counts:${userId}:`);
      updates.showCompleted = showCompleted;
    }

    res.json({ success: true, ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Per-user Classification Rules
// ============================================

// Get effective rules: user's custom rules, or server defaults if none set
app.get('/auth/me/classification', authService.requireAuth(), async (req, res) => {
  try {
    const rules = await userService.getClassificationRules(req.user.userId);
    res.json({ rules: rules || classificationConfig, isCustom: !!rules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save custom rules for this user
app.put('/auth/me/classification', authService.requireAuth(), async (req, res) => {
  try {
    const { now, not_now, later } = req.body;
    if (!now || !not_now || !later) {
      return res.status(400).json({ error: 'now, not_now, and later are required' });
    }
    const rules = { now, not_now, later };
    await userService.updateClassificationRules(req.user.userId, rules);
    cache.deletePrefix(`tasks:${req.user.userId}:`);
    cache.delete(`unified:${req.user.userId}`);
    res.json({ success: true, rules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset this user's rules back to server defaults
app.delete('/auth/me/classification', authService.requireAuth(), async (req, res) => {
  try {
    await userService.resetClassificationRules(req.user.userId);
    cache.deletePrefix(`tasks:${req.user.userId}:`);
    cache.delete(`unified:${req.user.userId}`);
    res.json({ success: true, rules: classificationConfig });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Parse a TOML classification file and return validated rules (no save)
app.post('/auth/me/classification/parse', authService.requireAuth(), async (req, res) => {
  try {
    const { toml } = req.body;
    if (!toml || typeof toml !== 'string') {
      return res.status(400).json({ error: 'toml field is required' });
    }
    let parsed;
    try {
      parsed = TOML.parse(toml);
    } catch (e) {
      return res.status(400).json({ error: `TOML parse error: ${e.message}` });
    }
    const { now, not_now, later } = parsed;
    if (!now || !not_now || !later) {
      return res.status(400).json({ error: 'TOML must contain [now], [not_now], and [later] sections' });
    }
    const rules = {
      now:     { label: String(now.label     || 'Now'),     overdue:     !!now.overdue,     priorities: Array.isArray(now.priorities)     ? now.priorities     : [] },
      not_now: { label: String(not_now.label || 'Not Now'), future_due:  !!not_now.future_due, priorities: Array.isArray(not_now.priorities) ? not_now.priorities : [] },
      later:   { label: String(later.label   || 'Later') }
    };
    res.json({ rules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Unified Task List (all providers, all lists)
// ============================================

app.get('/api/tasks/unified', authService.requireAuth(), async (req, res) => {
  const userId = req.user.userId;
  const cacheKey = `unified:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  // Determine which providers are connected for this user
  const providerNames = [];
  for (const p of ['microsoft', 'google']) {
    const creds = await userService.getCredentials(userId, p);
    if (creds) providerNames.push(p);
  }
  if (bridgeServer.isConnected(userId)) providerNames.push('apple');

  const allTasks = [];

  await Promise.all(providerNames.map(async (providerName) => {
    try {
      const { provider } = getProviderForUser({
        ...req, query: { provider: providerName }, body: {}
      });
      await initializeProvider(provider, providerName, userId);
      const lists = await provider.getLists();

      await Promise.all(lists.map(async (list) => {
        try {
          const tasks = await provider.getTasks(list.id);
          for (const task of tasks) {
            allTasks.push({ ...task, provider: providerName, listId: list.id, listName: list.name });
          }
        } catch (err) {
          console.error(`unified: failed to load tasks for list ${list.id} (${providerName}):`, err.message);
        }
      }));
    } catch (err) {
      console.error(`unified: failed to initialize provider ${providerName} for user ${userId}:`, err.message);
    }
  }));

  const rules = await userService.getClassificationRules(userId) || classificationConfig;
  const annotated = allTasks.map(t => ({ ...t, classification: classifyTask(t, rules) }));
  const result = { user: req.user.username, tasks: annotated };
  cache.set(cacheKey, result, TTL.tasks);
  res.json(result);
});

// ============================================
// Task Lists Routes
// ============================================

// Returns lists from all connected providers in one call.
// Response: { user, providers: [...], byProvider: { microsoft: [...], ... }, lists: [...] }
// Each list in `lists` includes a `provider` field.
app.get('/api/lists/all', authService.requireAuth(), async (req, res) => {
  const userId = req.user.userId;
  const cacheKey = `lists:all:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const providerNames = [];
  for (const p of ['microsoft', 'google']) {
    const creds = await userService.getCredentials(userId, p);
    if (creds) providerNames.push(p);
  }
  if (bridgeServer.isConnected(userId)) providerNames.push('apple');

  const byProvider = {};
  await Promise.all(providerNames.map(async (providerName) => {
    try {
      const { provider } = getProviderForUser({ ...req, query: { provider: providerName }, body: {} });
      await initializeProvider(provider, providerName, userId);
      byProvider[providerName] = await provider.getLists();
    } catch {
      byProvider[providerName] = [];
    }
  }));

  const result = {
    user: req.user.username,
    providers: providerNames,
    byProvider,
    lists: providerNames.flatMap(p => (byProvider[p] || []).map(l => ({ ...l, provider: p })))
  };
  cache.set(cacheKey, result, TTL.lists);
  res.json(result);
});

app.get('/api/lists', authService.requireAuth(), async (req, res) => {
  try {
    const { provider, providerName } = getProviderForUser(req);
    const cacheKey = `lists:${req.user.userId}:${providerName}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    await initializeProvider(provider, providerName, req.user.userId);
    const lists = await provider.getLists();
    const result = { provider: providerName, user: req.user.username, lists };
    cache.set(cacheKey, result, TTL.lists);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/lists/counts', authService.requireAuth(), async (req, res) => {
  try {
    const { provider, providerName } = getProviderForUser(req);
    const user = await userService.getUser(req.user.userId);
    const onlyIncomplete = !user?.showCompleted;
    const cacheKey = `counts:${req.user.userId}:${providerName}:${onlyIncomplete}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    await initializeProvider(provider, providerName, req.user.userId);
    const counts = await provider.getListCounts(onlyIncomplete);
    const result = { provider: providerName, counts };
    cache.set(cacheKey, result, TTL.counts);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Tasks Routes
// ============================================

app.get('/api/lists/:listId/tasks', authService.requireAuth(), async (req, res) => {
  try {
    const { listId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    const cacheKey = `tasks:${req.user.userId}:${providerName}:${listId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    await initializeProvider(provider, providerName, req.user.userId);
    const tasks = await provider.getTasks(listId);
    const rules = await userService.getClassificationRules(req.user.userId) || classificationConfig;
    const annotated = tasks.map(t => ({ ...t, classification: classifyTask(t, rules) }));
    const result = { provider: providerName, user: req.user.username, listId, tasks: annotated };
    cache.set(cacheKey, result, TTL.tasks);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/lists/:listId/tasks/:taskId', authService.requireAuth(), async (req, res) => {
  try {
    const { listId, taskId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);

    const task = await provider.getTask(listId, taskId);
    const rules = await userService.getClassificationRules(req.user.userId) || classificationConfig;
    res.json({ provider: providerName, user: req.user.username, listId, task: { ...task, classification: classifyTask(task, rules) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/lists/:listId/tasks', authService.requireAuth(), async (req, res) => {
  try {
    const { listId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);

    const task = await provider.createTask(listId, req.body);
    cache.delete(`tasks:${req.user.userId}:${providerName}:${listId}`);
    cache.delete(`unified:${req.user.userId}`);
    cache.deletePrefix(`counts:${req.user.userId}:${providerName}:`);
    res.status(201).json({ provider: providerName, user: req.user.username, listId, task });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/lists/:listId/tasks/:taskId', authService.requireAuth(), async (req, res) => {
  try {
    const { listId, taskId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);

    const result = await provider.updateTask(listId, taskId, req.body);
    cache.delete(`tasks:${req.user.userId}:${providerName}:${listId}`);
    cache.delete(`unified:${req.user.userId}`);
    res.json({ provider: providerName, user: req.user.username, listId, taskId, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/lists/:listId/tasks/:taskId/complete', authService.requireAuth(), async (req, res) => {
  try {
    const { listId, taskId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);

    const result = await provider.completeTask(listId, taskId);
    cache.delete(`tasks:${req.user.userId}:${providerName}:${listId}`);
    cache.delete(`unified:${req.user.userId}`);
    cache.deletePrefix(`counts:${req.user.userId}:${providerName}:`);
    res.json({ provider: providerName, user: req.user.username, listId, taskId, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/lists/:listId/tasks/:taskId', authService.requireAuth(), async (req, res) => {
  try {
    const { listId, taskId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);

    const result = await provider.deleteTask(listId, taskId);
    cache.delete(`tasks:${req.user.userId}:${providerName}:${listId}`);
    cache.delete(`unified:${req.user.userId}`);
    cache.deletePrefix(`counts:${req.user.userId}:${providerName}:`);
    res.json({ provider: providerName, user: req.user.username, listId, taskId, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Billing Routes (Stripe)
// ============================================

// GET /billing/status — subscription status for the current user
app.get('/billing/status', authService.requireAuth(), async (req, res) => {
  try {
    const user = await userService.getUser(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const response = { subscriptionStatus: user.subscriptionStatus || 'none' };

    if (stripe && user.stripeCustomerId && user.subscriptionStatus === 'active') {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'active',
          limit: 1,
          expand: ['data.items.data.price']
        });
        if (subscriptions.data.length > 0) {
          const sub  = subscriptions.data[0];
          const price = sub.items.data[0]?.price;
          response.plan             = price?.recurring?.interval === 'year' ? 'annual' : 'monthly';
          response.currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
          response.cancelAtPeriodEnd = sub.cancel_at_period_end;
        }
      } catch (stripeErr) {
        console.error('Stripe status lookup error:', stripeErr.message);
      }
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/create-checkout-session — create a Stripe Checkout session
app.post('/billing/create-checkout-session', authService.requireAuth(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });

  const { plan = 'monthly' } = req.body;

  // Resolve price ID based on plan
  let priceId;
  if (plan === 'annual') {
    priceId = process.env.STRIPE_PRICE_ID_ANNUAL;
    if (!priceId) return res.status(503).json({ error: 'Annual price not configured (STRIPE_PRICE_ID_ANNUAL)' });
  } else {
    // monthly and trial both use the monthly price
    priceId = process.env.STRIPE_PRICE_ID_MONTHLY || process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(503).json({ error: 'STRIPE_PRICE_ID not configured' });
  }

  try {
    const user = await userService.getUser(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const baseUrl = process.env.WEB_URL || 'http://localhost';
    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing.html`,
      metadata: { userId: req.user.userId, plan },
    };

    if (plan === 'trial') {
      const trialDays = parseInt(process.env.STRIPE_TRIAL_DAYS || '14', 10);
      sessionParams.subscription_data = { trial_period_days: trialDays };
    }

    if (user.stripeCustomerId) {
      sessionParams.customer = user.stripeCustomerId;
    } else if (user.email) {
      sessionParams.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /billing/session-info — fetch plan details for a completed checkout session
app.get('/billing/session-info', authService.requireAuth(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription']
    });

    if (session.metadata?.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const sub = session.subscription;
    res.json({
      plan:              session.metadata?.plan || 'monthly',
      status:            sub?.status || 'active',
      trialEnd:          sub?.trial_end          ? new Date(sub.trial_end          * 1000).toISOString() : null,
      currentPeriodEnd:  sub?.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/cancel-subscription — schedule cancellation at end of current period
app.post('/billing/cancel-subscription', authService.requireAuth(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });

  try {
    const user = await userService.getUser(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'No active subscription found' });

    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1
    });
    if (subscriptions.data.length === 0) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const sub     = subscriptions.data[0];
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });

    res.json({
      cancelAtPeriodEnd: updated.cancel_at_period_end,
      currentPeriodEnd:  new Date(updated.current_period_end * 1000).toISOString()
    });
  } catch (err) {
    console.error('Stripe cancel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/switch-to-monthly — downgrade annual plan to monthly at next renewal
app.post('/billing/switch-to-monthly', authService.requireAuth(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });

  const monthlyPriceId = process.env.STRIPE_PRICE_ID_MONTHLY || process.env.STRIPE_PRICE_ID;
  if (!monthlyPriceId) return res.status(503).json({ error: 'Monthly price not configured' });

  try {
    const user = await userService.getUser(req.user.userId);
    if (!user?.stripeCustomerId) return res.status(400).json({ error: 'No active subscription' });

    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1,
      expand: ['data.items.data.price']
    });
    if (subscriptions.data.length === 0) return res.status(400).json({ error: 'No active subscription' });

    const sub  = subscriptions.data[0];
    const item = sub.items.data[0];

    if (item.price?.recurring?.interval !== 'year') {
      return res.status(400).json({ error: 'Already on a monthly plan' });
    }

    await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: false,
      proration_behavior:   'none',
      items: [{ id: item.id, price: monthlyPriceId }]
    });

    res.json({
      currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString()
    });
  } catch (err) {
    console.error('Stripe switch-to-monthly error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Bridge Routes (Protected)
// ============================================

// Generate a new bridge API key (replaces any existing key)
app.post('/auth/bridge/key', authService.requireAuth(), async (req, res) => {
  try {
    const key = await userService.generateBridgeApiKey(req.user.userId);
    res.json({
      apiKey: key,
      message: 'Store this key in your hb-task-server .env as BRIDGE_API_KEY. It will not be shown again.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Revoke the bridge API key and disconnect any active bridge session
app.delete('/auth/bridge/key', authService.requireAuth(), async (req, res) => {
  try {
    const conn = bridgeServer.connections.get(req.user.userId);
    if (conn) conn.ws.close(4004, 'API key revoked');
    await userService.revokeBridgeApiKey(req.user.userId);
    res.json({ success: true, message: 'Bridge API key revoked' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get bridge connection status and whether an API key exists
app.get('/auth/bridge/status', authService.requireAuth(), async (req, res) => {
  try {
    const hasKey = await userService.hasBridgeApiKey(req.user.userId);
    const connected = bridgeServer.isConnected(req.user.userId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ hasKey, connected });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Static file serving (used when this server is the sole entry point,
// e.g. on Namecheap shared hosting where only one Node.js app is allowed)
// ============================================

app.use(express.static(path.join(__dirname, 'public')));

// Legal pages (clean URLs for OAuth app registration)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// ============================================
// Error handling
// ============================================

app.use((req, res) => {
  // Return JSON for /api and /auth routes; plain 404 for everything else
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/billing')) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ============================================
// Start server
// ============================================

const httpServer = http.createServer(app);

bridgeServer.attach(httpServer, (apiKey) => userService.getUserIdByBridgeApiKey(apiKey));

httpServer.listen(API_PORT, () => {
  console.log(`Task API service running on http://localhost:${API_PORT}`);
  console.log(`Default provider: ${process.env.DEFAULT_PROVIDER || 'microsoft'}`);
  console.log(`CORS origin:      ${allowedOrigin}`);
  console.log(`Bridge WebSocket: ws://localhost:${API_PORT}/bridge`);
});
