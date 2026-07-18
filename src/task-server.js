require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const TOML = require('@iarna/toml');

// this is the main task-server.js file that runs the API server and 
//  handles authentication, provider integration, and user settings. 
// It uses Express for routing, CORS for cross-origin requests, 
// and body-parser for parsing JSON request bodies. 
// The server supports Microsoft, Google, and Apple task providers, 
// and includes routes for user registration, login, email verification,
// password reset, and provider OAuth flows. 
// It also includes a simple in-memory cache for performance 
// optimization and logs to both stdout and a log file for visibility 
// in hosting environments.

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
const SandboxProvider = require('./providers/sandbox');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createUpqMcpServer } = require('./mcp/tools');
const bridgeServer = require('./bridge-server');
const AuthService = require('./auth/authService');
const UserService = require('./auth/userService');
const { apiError } = require('./errors');
const { createRedisStore } = require('./rateLimitStore');
const { idempotencyMiddleware } = require('./idempotency');
const { classifyTask } = require('./classification/classify');
const { validateRules } = require('./classification/rulesSchema');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// Stripe API 2026-02-25.clover moved current_period_end from Subscription to SubscriptionItem
function stripePeriodEnd(sub) {
  return sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end ?? null;
}

const { sendVerificationEmail, resendVerificationEmail, sendPasswordResetEmail, verifySmtp, sendTrialEndingWarningEmail, sendPaymentFailedEmail, sendSubscriptionExpiredEmail, sendAdminAlertEmail } = require('./emailService');
const { runSubscriptionMaintenance } = require('./jobs/subscriptionMaintenance');
const { cleanupIdempotencyKeys } = require('./jobs/idempotencyCleanup');
const { cleanupApiUsageEvents } = require('./jobs/apiUsageCleanup');
const { usageLogger } = require('./analytics/usageLogger');

// In-code last resort only — used if the DB is unreachable or the
// system_classification_defaults table is somehow empty (should never
// happen after the V3 migration seeds it). Not the primary path; see
// getSystemDefault() below and docs/triage-engine-implementation-plan.md
// Phase 0. The boot-time TOML file this used to be loaded from
// (config/classification.toml) is no longer read here — changing the
// system-wide default no longer requires a file edit + restart.
const DEFAULT_CLASSIFICATION = {
  now:   { label: 'Now',   overdue: true, priorities: ['high'] },
  next:  { label: 'Next',  future_due: true, priorities: ['normal'] },
  later: { label: 'Later' }
};

// Cached inside userService.getSystemDefaultRules() (Redis-backed, shared
// across any future additional instance — not the in-memory SimpleCache
// below), so this DB round-trip is cheap on the common path.
async function getSystemDefault() {
  try {
    return await userService.getSystemDefaultRules() || DEFAULT_CLASSIFICATION;
  } catch (err) {
    console.error('getSystemDefaultRules failed, using in-code fallback:', err.message);
    return DEFAULT_CLASSIFICATION;
  }
}

const app = express();
// Production runs behind Caddy on the same host (see Caddyfile), which sets
// X-Forwarded-For. Without this, req.ip always resolves to Caddy's local
// address, so IP-based rate limiting would bucket every real client together
// instead of individually. Trusting exactly one hop (not a wildcard) keeps
// spoofed X-Forwarded-For headers from the public internet from being honored.
app.set('trust proxy', 1);
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
const allowedOrigin = process.env.ALLOWED_ORIGIN;
if (!allowedOrigin) throw new Error('ALLOWED_ORIGIN env var is required');
app.use(cors({ origin: allowedOrigin }));

// Tracks consecutive Stripe webhook signature failures across requests so a
// stale/mismatched STRIPE_WEBHOOK_SECRET (e.g. .env edited but process not yet
// restarted — see 2026-07-11 incident) triggers an admin alert instead of
// failing silently until someone happens to read the logs.
const WEBHOOK_FAILURE_ALERT_THRESHOLD = 3;
let webhookSignatureFailureCount = 0;
let webhookAlertSent = false;

// Stripe webhook needs raw body — must be registered before bodyParser.json()
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).json({ error: 'Webhook secret not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    webhookSignatureFailureCount = 0;
    webhookAlertSent = false;
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    webhookSignatureFailureCount++;
    if (webhookSignatureFailureCount >= WEBHOOK_FAILURE_ALERT_THRESHOLD && !webhookAlertSent) {
      webhookAlertSent = true;
      sendAdminAlertEmail({
        subject: 'Stripe webhook signature failures',
        message: `${webhookSignatureFailureCount} consecutive Stripe webhook deliveries have failed signature ` +
          `verification. STRIPE_WEBHOOK_SECRET in .env likely doesn't match the live webhook endpoint — check ` +
          `whether .env was edited without restarting the process (dotenv only loads at boot), or whether the ` +
          `secret was rolled in the Stripe Dashboard. Last error: ${err.message}`,
      }).catch(e => console.error('Failed to send webhook-failure admin alert:', e.message));
    }
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    const baseUrl = process.env.WEB_URL || 'http://localhost';

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const stripeToStatus = { trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };
        const status = stripeToStatus[sub.status] || 'active';
        const rawEnd   = stripePeriodEnd(sub);
        const periodEnd = rawEnd  ? new Date(rawEnd  * 1000) : null;
        const trialEnd  = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
        await userService.updateSubscription(userId, session.customer, status, periodEnd, trialEnd);
        console.log(`Subscription ${status} for user ${userId}`);
      }

    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const stripeToStatus = { trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };
      const newStatus = stripeToStatus[sub.status] || sub.status;
      const rawEnd   = stripePeriodEnd(sub);
      const periodEnd = rawEnd        ? new Date(rawEnd        * 1000) : null;
      const trialEnd  = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
      const user = await userService.getUserByStripeCustomerId(sub.customer);
      if (user) {
        await userService.updateSubscription(user.userId, sub.customer, newStatus, periodEnd, trialEnd);
        console.log(`Subscription updated to ${newStatus} for customer ${sub.customer}`);
        // Warn user when subscription is set to cancel at period end
        if (sub.cancel_at_period_end && user.email) {
          const endDate = periodEnd ? periodEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the end of your billing period';
          const daysRemaining = periodEnd ? Math.max(1, Math.ceil((periodEnd - Date.now()) / (24 * 60 * 60 * 1000))) : null;
          if (daysRemaining !== null) {
            await sendTrialEndingWarningEmail({
              to: user.email, username: user.username,
              trialEndDate: periodEnd.toISOString(), daysRemaining,
              upgradeUrl: `${baseUrl}/settings.html`,
            }).catch(e => console.error('Webhook cancel-warning email error:', e.message));
          }
        }
        // Alert user when payment fails and status transitions to past_due
        if (newStatus === 'past_due' && user.email) {
          await sendPaymentFailedEmail({
            to: user.email, username: user.username,
            updatePaymentUrl: `${baseUrl}/settings.html`,
          }).catch(e => console.error('Webhook past_due email error:', e.message));
        }
      }

    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const user = await userService.getUserByStripeCustomerId(invoice.customer);
      if (user) {
        await userService.updateSubscription(user.userId, invoice.customer, 'past_due', user.subscriptionPeriodEnd ? new Date(user.subscriptionPeriodEnd) : null, user.trialEnd ? new Date(user.trialEnd) : null);
        console.log(`Payment failed for customer ${invoice.customer}`);
        if (user.email) {
          await sendPaymentFailedEmail({
            to: user.email, username: user.username,
            updatePaymentUrl: `${baseUrl}/settings.html`,
          }).catch(e => console.error('Webhook payment-failed email error:', e.message));
        }
      }

    } else if (event.type === 'customer.subscription.trial_will_end') {
      const sub = event.data.object;
      const user = await userService.getUserByStripeCustomerId(sub.customer);
      if (user && user.email) {
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
        const daysRemaining = trialEnd ? Math.max(1, Math.ceil((trialEnd - Date.now()) / (24 * 60 * 60 * 1000))) : 3;
        await sendTrialEndingWarningEmail({
          to: user.email, username: user.username,
          trialEndDate: trialEnd ? trialEnd.toISOString() : new Date().toISOString(),
          daysRemaining,
          upgradeUrl: `${baseUrl}/pricing.html`,
        }).catch(e => console.error('Webhook trial_will_end email error:', e.message));
        console.log(`Trial ending soon email sent to ${user.email}`);
      }

    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const user = await userService.getUserByStripeCustomerId(sub.customer);
      if (user) {
        await userService.updateSubscription(user.userId, sub.customer, 'canceled', null, null);
        console.log(`Subscription canceled for customer ${sub.customer}`);
        if (user.email) {
          await sendSubscriptionExpiredEmail({
            to: user.email, username: user.username,
            resubscribeUrl: `${baseUrl}/pricing.html`,
          }).catch(e => console.error('Webhook subscription-deleted email error:', e.message));
        }
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

// Initialize DB schema/migrations before accepting any connections
userService.initialize().then(() => {
  console.log('User service initialized');
  httpServer.listen(API_PORT, () => {
    console.log(`Task API service running on http://localhost:${API_PORT}`);
    console.log(`Default provider: ${process.env.DEFAULT_PROVIDER || 'microsoft'}`);
    console.log(`CORS origin:      ${allowedOrigin}`);
    console.log(`Bridge WebSocket: ws://localhost:${API_PORT}/bridge`);
    // .env is only read once at boot (dotenv.config() above) — editing the file on disk
    // has no effect until the process restarts. Logging a fingerprint here makes it
    // possible to confirm a running process actually picked up a just-edited secret,
    // instead of silently rejecting webhooks with a stale one (see 2026-07-11 incident).
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      console.log(`Stripe webhook secret loaded: ...${process.env.STRIPE_WEBHOOK_SECRET.slice(-4)}`);
    } else {
      console.warn('STRIPE_WEBHOOK_SECRET not set — Stripe webhooks will be rejected');
    }
    verifySmtp();
  });
}).catch(err => {
  console.error('Failed to initialize user service — server will not start:', err);
  process.exit(1);
});

// Helper to get provider for the authenticated user
function getProviderForUser(req) {
  // A sandbox API key can only ever see sandbox data — this is enforced here,
  // not by convention, so a sandbox key can never reach real provider data
  // regardless of ?provider= or the account's connected credentials.
  const providerName = req.apiKey?.sandbox
    ? 'sandbox'
    : (req.query.provider || req.body.provider || req.user.defaultProvider || 'microsoft').toLowerCase();

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
    case 'sandbox':
      provider = new SandboxProvider(req.apiKey?.id || req.user.userId);
      break;
    default:
      throw new Error(`Invalid provider: ${providerName}`);
  }

  return { provider, providerName };
}

// Initialize provider with user's credentials
async function initializeProvider(provider, providerName, userId) {
  if (providerName === 'apple' || providerName === 'sandbox') return; // no credentials needed

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

    // Proactively refresh if the stored token is older than 50 minutes —
    // Google access tokens expire after 60 minutes.
    if (credentials.refreshToken) {
      const updatedAt  = credentials.updatedAt ? new Date(credentials.updatedAt) : null;
      const ageMinutes = updatedAt ? (Date.now() - updatedAt.getTime()) / 60000 : Infinity;
      if (ageMinutes > 50) {
        try {
          await provider.refreshAccessToken();
          console.log(`[token-refresh] Proactively refreshed Google token for user ${userId} (age: ${Math.round(ageMinutes)}m)`);
        } catch (err) {
          console.warn(`[token-refresh] Google proactive refresh failed for user ${userId}: ${err.message}`);
        }
      }
    }
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

// Credential stuffing / brute force: keyed by IP, keeps a wrong password from
// being guessable at scale without punishing normal mistyped-password retries.
const LOGIN_LIMITER_WINDOW_MS = 15 * 60 * 1000;
const loginLimiter = rateLimit({
  windowMs: LOGIN_LIMITER_WINDOW_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
  store: createRedisStore({ windowMs: LOGIN_LIMITER_WINDOW_MS, prefix: 'login' }),
});

// Covers registration, resend-verification, and forgot-password — all three
// trigger an outbound email and/or reveal account existence, so both abuse
// and enumeration-by-volume are worth throttling the same way.
const AUTH_ACTION_LIMITER_WINDOW_MS = 60 * 60 * 1000;
const authActionLimiter = rateLimit({
  windowMs: AUTH_ACTION_LIMITER_WINDOW_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  store: createRedisStore({ windowMs: AUTH_ACTION_LIMITER_WINDOW_MS, prefix: 'auth-action' }),
});

// Developer REST API / MCP beta: user-keyed (not IP-keyed) since agent/MCP
// clients don't map cleanly to individual IPs. 120/min is a conservative
// starting placeholder — revisit with real usage data (see Step 7).
// Mounted after requireApiKeyOrJWT so req.user is populated.
const API_LIMITER_WINDOW_MS = 60 * 1000;
const apiLimiter = rateLimit({
  windowMs: API_LIMITER_WINDOW_MS,
  limit: 120,
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore({ windowMs: API_LIMITER_WINDOW_MS, prefix: 'api' }),
  handler: (req, res) => apiError(res, 'rate_limited', 'Too many requests. Please try again shortly.'),
});

app.post('/auth/register', authActionLimiter, async (req, res) => {
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

app.post('/auth/login', loginLimiter, async (req, res) => {
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
app.post('/auth/resend-verification', authActionLimiter, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    const user = await userService.getUserByUsername(username);
    if (!user) return res.json({ message: 'If that account exists and is unverified, a new email has been sent.' });
    if (user.emailVerified) return res.json({ message: 'If that account exists and is unverified, a new email has been sent.' });

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
app.post('/auth/forgot-password', authActionLimiter, async (req, res) => {
  // Always respond with the same message to avoid leaking whether an email is registered
  const generic = { message: 'If that email is registered, a reset link has been sent.' };
  try {
    const { email } = req.body;
    if (!email) return res.json(generic);

    const result = await userService.createPasswordResetToken(email);
    if (result) {
      const resetUrl = `${WEB_URL}/reset-password.html?token=${result.token}`;
      await sendPasswordResetEmail({ to: result.email, username: result.username, resetUrl });
      console.log(`[forgot-password] Reset email sent to ${result.email}`);
    } else {
      console.log(`[forgot-password] No reset sent for ${email} — not found or email not verified`);
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
  try {
    const user = await userService.getUser(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (error) {
    console.error(`/auth/me error for user ${req.user.userId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /auth/me — permanently delete the account and all associated data.
// Requires the current password as re-confirmation. Cancels any active Stripe
// subscription immediately (not at period end), disconnects an active Apple
// Reminders bridge session, then deletes the user row — user_credentials and
// bridge_api_keys cascade via ON DELETE CASCADE.
app.delete('/auth/me', authService.requireAuth(), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account.' });

    const userId = req.user.userId;
    const validPassword = await userService.verifyPassword(userId, password);
    if (!validPassword) return res.status(401).json({ error: 'Incorrect password.' });

    if (stripe) {
      const user = await userService.getUser(userId);
      if (user?.stripeCustomerId) {
        const subscriptions = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'all', limit: 10 });
        for (const sub of subscriptions.data) {
          if (['active', 'trialing', 'past_due'].includes(sub.status)) {
            await stripe.subscriptions.cancel(sub.id)
              .catch(err => console.error(`Failed to cancel Stripe subscription ${sub.id} during account deletion for user ${userId}:`, err.message));
          }
        }
      }
    }

    const conn = bridgeServer.connections.get(userId);
    if (conn) conn.ws.close(4006, 'Account deleted');

    cache.deletePrefix(`lists:${userId}:`);
    cache.deletePrefix(`tasks:${userId}:`);
    cache.deletePrefix(`counts:${userId}:`);
    cache.deletePrefix(`status:${userId}:`);
    cache.delete(`unified:${userId}`);
    cache.delete(`lists:all:${userId}`);

    const deleted = await userService.deleteUser(userId);
    if (!deleted) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, message: 'Account deleted.' });
  } catch (error) {
    console.error(`/auth/me DELETE error for user ${req.user.userId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
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
      const lists = await provider.getLists();
      cache.set(cacheKey, true, TTL.status);
      status[p] = true;
      // Prime the per-provider lists cache so the next /api/lists/all call
      // doesn't need a redundant round-trip to the provider API.
      cache.set(`lists:${req.user.userId}:${p}`, { provider: p, user: req.user.username, lists }, TTL.lists);
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
  try {
    const userId = req.user.userId;
    const [msCreds, gCreds] = await Promise.all([
      userService.getCredentials(userId, 'microsoft'),
      userService.getCredentials(userId, 'google'),
    ]);
    res.json({ microsoft: !!msCreds, google: !!gCreds });
  } catch (error) {
    console.error(`/auth/providers/authorized error for user ${req.user.userId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
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
    cache.delete(`lists:all:${userId}`);

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
    cache.delete(`lists:all:${userId}`);

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
    const [user, msCreds, gCreds, bridgeHasKey, classificationRules, systemDefault] = await Promise.all([
      userService.getUser(userId),
      userService.getCredentials(userId, 'microsoft'),
      userService.getCredentials(userId, 'google'),
      userService.hasBridgeApiKey(userId),
      userService.getClassificationRules(userId),
      getSystemDefault(),
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
        rules:    classificationRules || systemDefault,
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

// Developer REST API / MCP beta: shared middleware chain for every
// task/list/classification route. Accepts a JWT (browser/human) or a
// upq_live_/upq_sandbox_ API key (developer/agent), and deliberately skips
// requireSubscription() — the beta is free (see Step 6 of the lean beta
// plan). Never applied to billing/account-management routes; that's what
// structurally keeps an API key out of those paths, not just convention.
const apiKeyAuth = [authService.requireApiKeyOrJWT(userService), authService.requireScope(), apiLimiter, usageLogger];
// Same chain, plus the subscription gate — for routes that already enforced
// requireSubscription() before this beta work. API-key requests skip the
// gate (beta is free); JWT/browser requests are still gated exactly as
// before, so existing paying-customer behavior is unchanged.
const apiKeyAuthSub = [...apiKeyAuth, authService.requireSubscriptionUnlessApiKey(userService)];

// ============================================
// Per-user Classification Rules
// ============================================

// Get effective rules: user's custom rules, or server defaults if none set
app.get('/auth/me/classification', ...apiKeyAuth, async (req, res) => {
  try {
    const rules = await userService.getClassificationRules(req.user.userId);
    res.json({ rules: rules || await getSystemDefault(), isCustom: !!rules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save custom rules for this user. Accepts either legacy shape (no
// schemaVersion, or 1) or a schemaVersion:2 predicate tree (see
// src/classification/rulesSchema.js) — validated before saving so a
// malformed tree is rejected here, not discovered later at classify time.
app.put('/auth/me/classification', ...apiKeyAuth, async (req, res) => {
  try {
    const parsed = validateRules(req.body);
    if (!parsed.success) {
      return apiError(res, 'invalid_request', 'Invalid classification rules', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    const rules = parsed.data;
    await userService.updateClassificationRules(req.user.userId, rules);
    cache.deletePrefix(`tasks:${req.user.userId}:`);
    cache.delete(`unified:${req.user.userId}`);
    res.json({ success: true, rules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset this user's rules back to server defaults
app.delete('/auth/me/classification', ...apiKeyAuth, async (req, res) => {
  try {
    await userService.resetClassificationRules(req.user.userId);
    cache.deletePrefix(`tasks:${req.user.userId}:`);
    cache.delete(`unified:${req.user.userId}`);
    res.json({ success: true, rules: await getSystemDefault() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin-only: change the system-wide default ruleset used whenever a user
// has no custom rules of their own (see docs/triage-engine-implementation-plan.md,
// Phase 0). JWT-only, gated by authService.requireAdmin() — never reachable
// via an API key, same structural exclusion as billing/account routes.
app.put('/admin/classification/defaults', authService.requireAuth(), authService.requireAdmin(), async (req, res) => {
  try {
    const parsed = validateRules(req.body);
    if (!parsed.success) {
      return apiError(res, 'invalid_request', 'Invalid classification rules', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    await userService.updateSystemDefaultRules(parsed.data, req.user.userId);
    res.json({ success: true, rules: parsed.data });
  } catch (error) {
    apiError(res, 'internal_error', error.message);
  }
});

// Parse a TOML classification file and return validated rules (no save)
app.post('/auth/me/classification/parse', ...apiKeyAuth, async (req, res) => {
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
    const { now, next, later } = parsed;
    if (!now || !next || !later) {
      return res.status(400).json({ error: 'TOML must contain [now], [next], and [later] sections' });
    }
    const rules = {
      now:   { label: String(now.label   || 'Now'),   overdue:    !!now.overdue,    priorities: Array.isArray(now.priorities)   ? now.priorities   : [] },
      next:  { label: String(next.label  || 'Next'),  future_due: !!next.future_due, priorities: Array.isArray(next.priorities)  ? next.priorities  : [] },
      later: { label: String(later.label || 'Later') }
    };
    res.json({ rules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Unified Task List (all providers, all lists)
// ============================================

const CLASSIFICATION_ORDER = { now: 0, next: 1, later: 2 };

// Applies ?list_id= / ?exclude_list= (comma-separated list IDs) and
// ?limit=/?offset= to an already-fetched, already-classified task array.
// Providers return everything anyway; this only trims the response payload
// and lets a developer scope out irrelevant lists on the one endpoint,
// instead of pushing MS-vs-Google list-structure differences onto them via
// separate list-scoped endpoints (see Step 1 of the lean beta plan).
function applyListFilterAndPagination(tasks, query) {
  let filtered = tasks;
  if (query.list_id) {
    const ids = new Set(String(query.list_id).split(',').map(s => s.trim()).filter(Boolean));
    filtered = filtered.filter(t => ids.has(t.listId));
  }
  if (query.exclude_list) {
    const ids = new Set(String(query.exclude_list).split(',').map(s => s.trim()).filter(Boolean));
    filtered = filtered.filter(t => !ids.has(t.listId));
  }

  const total = filtered.length;
  let paged = filtered;
  let hasMore = false;
  if (query.limit !== undefined) {
    const limit = Math.max(0, parseInt(query.limit, 10) || 0);
    const offset = Math.max(0, parseInt(query.offset, 10) || 0);
    paged = filtered.slice(offset, offset + limit);
    hasMore = offset + limit < total;
  }

  return { tasks: paged, total, hasMore };
}

// Determines this user's connected providers, fetches every list and task
// across them, and annotates each raw task with provider/listId/listName —
// everything /api/tasks/unified needs before classification runs. Extracted
// so POST /auth/me/classification/preview (dry-run against a candidate
// ruleset — see docs/triage-engine-implementation-plan.md, Phase 2) can
// reuse exactly the same aggregation instead of drifting from it. Does not
// classify or cache — callers do that with whichever ruleset applies to them.
async function fetchAllTasksForUser(req, userId) {
  const providerNames  = [];
  const providerErrors = [];

  if (req.apiKey?.sandbox) {
    providerNames.push('sandbox');
  } else {
    for (const p of ['microsoft', 'google']) {
      const creds = await userService.getCredentials(userId, p);
      if (creds) providerNames.push(p);
    }
    if (bridgeServer.isConnected(userId)) {
      providerNames.push('apple');
    } else if (await userService.hasBridgeApiKey(userId)) {
      providerErrors.push({ provider: 'apple', error: 'Bridge not connected' });
    }
  }

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
          if (!providerErrors.find(e => e.provider === providerName)) {
            providerErrors.push({ provider: providerName, error: err.message });
          }
        }
      }));
    } catch (err) {
      console.error(`unified: failed to initialize provider ${providerName} for user ${userId}:`, err.message);
      providerErrors.push({ provider: providerName, error: err.message });
    }
  }));

  return { allTasks, providerErrors };
}

app.get('/api/tasks/unified', ...apiKeyAuthSub, async (req, res) => {
  try {
    const userId = req.user.userId;
    const sortByClassification = req.query.sort === 'classification';
    const cacheKey = `unified:${userId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      let tasks = cached.tasks;
      if (sortByClassification) {
        tasks = [...tasks].sort((a, b) =>
          (CLASSIFICATION_ORDER[a.classification] ?? 3) - (CLASSIFICATION_ORDER[b.classification] ?? 3)
        );
      }
      const { tasks: paged, total, hasMore } = applyListFilterAndPagination(tasks, req.query);
      return res.json({ ...cached, tasks: paged, total, hasMore });
    }

    const { allTasks, providerErrors } = await fetchAllTasksForUser(req, userId);

    const rules    = await userService.getClassificationRules(userId) || await getSystemDefault();
    const annotated = allTasks.map(t => ({ ...t, classification: classifyTask(t, rules) }));
    const result   = { user: req.user.username, tasks: annotated };

    // Only cache complete results — partial results should retry on next request
    if (providerErrors.length === 0) cache.set(cacheKey, result, TTL.tasks);

    const response = providerErrors.length ? { ...result, providerErrors } : result;

    let responseTasks = annotated;
    if (sortByClassification) {
      responseTasks = [...annotated].sort((a, b) =>
        (CLASSIFICATION_ORDER[a.classification] ?? 3) - (CLASSIFICATION_ORDER[b.classification] ?? 3)
      );
    }
    const { tasks: paged, total, hasMore } = applyListFilterAndPagination(responseTasks, req.query);
    res.json({ ...response, tasks: paged, total, hasMore });
  } catch (error) {
    console.error(`/api/tasks/unified error for user ${req.user.userId}:`, error.message);
    // Kept on the legacy {error: '...'} string shape (not apiError) — the
    // existing browser frontend (all-tasks.html) does `new Error(e.error)`
    // on this route and shares it with API-key callers, so the response
    // shape can't be changed here without breaking that client.
    res.status(500).json({ error: error.message });
  }
});

// Dry-run: classify the caller's *current* real tasks against a candidate
// ruleset without saving it (see docs/triage-engine-implementation-plan.md,
// Phase 2). Body: { rules }. Reuses fetchAllTasksForUser so this never
// drifts from what /api/tasks/unified actually fetches, and returns the
// same shape (tasks/total/hasMore) so the same client rendering code works
// for "live" and "preview" results. Never persists — GET /auth/me/classification
// afterward is unaffected regardless of what's previewed here.
app.post('/auth/me/classification/preview', ...apiKeyAuth, async (req, res) => {
  try {
    const parsed = validateRules(req.body?.rules);
    if (!parsed.success) {
      return apiError(res, 'invalid_request', 'Invalid classification rules', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    const rules  = parsed.data;
    const userId = req.user.userId;

    const { allTasks, providerErrors } = await fetchAllTasksForUser(req, userId);
    const annotated = allTasks.map(t => ({ ...t, classification: classifyTask(t, rules) }));

    let responseTasks = annotated;
    if (req.query.sort === 'classification') {
      responseTasks = [...annotated].sort((a, b) =>
        (CLASSIFICATION_ORDER[a.classification] ?? 3) - (CLASSIFICATION_ORDER[b.classification] ?? 3)
      );
    }
    const { tasks: paged, total, hasMore } = applyListFilterAndPagination(responseTasks, req.query);

    const response = { user: req.user.username, tasks: paged, total, hasMore };
    if (providerErrors.length) response.providerErrors = providerErrors;
    res.json(response);
  } catch (error) {
    apiError(res, 'internal_error', error.message);
  }
});

// ============================================
// Task Lists Routes
// ============================================

// Returns lists from all connected providers in one call.
// Response: { user, providers: [...], byProvider: { microsoft: [...], ... }, lists: [...] }
// Each list in `lists` includes a `provider` field.
app.get('/api/lists/all', ...apiKeyAuthSub, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cacheKey = `lists:all:${userId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      // If the Apple bridge connection state changed since caching, bust the cache
      // so the reconnected (or newly disconnected) state is reflected immediately.
      const appleNowConnected = bridgeServer.isConnected(userId);
      const appleWasCached    = cached.providers.includes('apple');
      if (appleNowConnected === appleWasCached) return res.json(cached);
      cache.delete(cacheKey);
    }

    const providerNames = [];
    if (req.apiKey?.sandbox) {
      providerNames.push('sandbox');
    } else {
      for (const p of ['microsoft', 'google']) {
        const creds = await userService.getCredentials(userId, p);
        if (creds) providerNames.push(p);
      }
      if (bridgeServer.isConnected(userId)) providerNames.push('apple');
    }

    const byProvider = {};
    await Promise.all(providerNames.map(async (providerName) => {
      // Use the per-provider cache if it was primed by the status check
      const perProviderCached = (providerName !== 'apple' && providerName !== 'sandbox')
        ? cache.get(`lists:${userId}:${providerName}`)
        : null;
      if (perProviderCached) {
        byProvider[providerName] = perProviderCached.lists;
        return;
      }
      try {
        const { provider } = getProviderForUser({ ...req, query: { provider: providerName }, body: {} });
        await initializeProvider(provider, providerName, userId);
        byProvider[providerName] = await provider.getLists();
      } catch (err) {
        console.error(`[lists/all] ${providerName} failed for user ${userId}:`, err.message);
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
  } catch (error) {
    console.error(`/api/lists/all error for user ${req.user.userId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/lists', ...apiKeyAuthSub, async (req, res) => {
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

app.get('/api/lists/counts', ...apiKeyAuthSub, async (req, res) => {
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

app.get('/api/lists/:listId/tasks', ...apiKeyAuthSub, async (req, res) => {
  try {
    const { listId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    const cacheKey = `tasks:${req.user.userId}:${providerName}:${listId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    await initializeProvider(provider, providerName, req.user.userId);
    const tasks = await provider.getTasks(listId);
    const rules = await userService.getClassificationRules(req.user.userId) || await getSystemDefault();
    const annotated = tasks.map(t => ({ ...t, classification: classifyTask(t, rules) }));
    const result = { provider: providerName, user: req.user.username, listId, tasks: annotated };
    cache.set(cacheKey, result, TTL.tasks);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/lists/:listId/tasks/:taskId', ...apiKeyAuthSub, async (req, res) => {
  try {
    const { listId, taskId } = req.params;
    const { provider, providerName } = getProviderForUser(req);
    await initializeProvider(provider, providerName, req.user.userId);

    const task = await provider.getTask(listId, taskId);
    const rules = await userService.getClassificationRules(req.user.userId) || await getSystemDefault();
    res.json({ provider: providerName, user: req.user.username, listId, task: { ...task, classification: classifyTask(task, rules) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/lists/:listId/tasks', ...apiKeyAuthSub, idempotencyMiddleware, async (req, res) => {
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

app.patch('/api/lists/:listId/tasks/:taskId', ...apiKeyAuthSub, idempotencyMiddleware, async (req, res) => {
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

app.patch('/api/lists/:listId/tasks/:taskId/complete', ...apiKeyAuthSub, idempotencyMiddleware, async (req, res) => {
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

app.delete('/api/lists/:listId/tasks/:taskId', ...apiKeyAuthSub, idempotencyMiddleware, async (req, res) => {
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

    const status = user.subscriptionStatus || 'none';
    const response = {
      subscriptionStatus:    status,
      subscriptionPeriodEnd: user.subscriptionPeriodEnd || null,
      trialEnd:              user.trialEnd              || null,
      isTestMode:            (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_'),
    };

    if (stripe && user.stripeCustomerId && status === 'active') {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'active',
          limit: 1,
          expand: ['data.items.data.price', 'data.customer']
        });
        if (subscriptions.data.length > 0) {
          const sub   = subscriptions.data[0];
          const price = sub.items.data[0]?.price;
          response.plan              = price?.recurring?.interval === 'year' ? 'annual' : 'monthly';
          const rawEnd = stripePeriodEnd(sub);
          response.currentPeriodEnd  = rawEnd ? new Date(rawEnd * 1000).toISOString() : null;
          response.cancelAtPeriodEnd = sub.cancel_at_period_end;
          response.customerName      = sub.customer?.name || null;
          // price.product is a string ID unless separately retrieved
          const productId = typeof price?.product === 'string' ? price.product : price?.product?.id;
          if (productId) {
            const product = await stripe.products.retrieve(productId);
            response.planName = product.name || null;
          }
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

  // Resolve price ID based on plan.
  // The monthly price has a 30-day trial configured directly on it in Stripe
  // (recurring.trial_period_days); the annual price has no trial by design.
  let priceId;
  if (plan === 'annual') {
    priceId = process.env.STRIPE_PRICE_ID_ANNUAL;
    if (!priceId) return res.status(503).json({ error: 'Annual price not configured (STRIPE_PRICE_ID_ANNUAL)' });
  } else {
    priceId = process.env.STRIPE_PRICE_ID_MONTHLY || process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(503).json({ error: 'STRIPE_PRICE_ID not configured' });
  }

  try {
    const user = await userService.getUser(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Ask Stripe directly (not our DB, which can lag behind on a dropped webhook —
    // see the 2026-07-11 webhook secret drift incident) whether this user already
    // has a live subscription before starting a new Checkout Session.
    // Known limitation: Stripe's Search API can take up to ~1 minute to index a
    // just-created subscription, so an extremely fast repeat checkout could still
    // slip past this guard. Acceptable risk — see PRODUCTION_READINESS.md.
    // Stripe's Search Query Language cannot mix AND and OR in one query, so
    // filter by userId only and check status in JS.
    const existing = await stripe.subscriptions.search({
      query: `metadata['userId']:'${req.user.userId}'`,
    });
    const activeStatuses = ['active', 'trialing', 'past_due'];
    if (existing.data.some((sub) => activeStatuses.includes(sub.status))) {
      return res.status(409).json({ error: 'You already have a subscription. Visit Settings to manage it.' });
    }

    const baseUrl = process.env.WEB_URL || 'http://localhost';
    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing.html`,
      metadata: { userId: req.user.userId, plan },
      subscription_data: { metadata: { userId: req.user.userId, plan } },
      allow_promotion_codes: true,
    };

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
      currentPeriodEnd:  sub ? (stripePeriodEnd(sub) ? new Date(stripePeriodEnd(sub) * 1000).toISOString() : null) : null,
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
      currentPeriodEnd:  stripePeriodEnd(updated) ? new Date(stripePeriodEnd(updated) * 1000).toISOString() : null
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
      currentPeriodEnd: stripePeriodEnd(sub) ? new Date(stripePeriodEnd(sub) * 1000).toISOString() : null
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
// Developer API Keys (REST/MCP beta) — JWT-only, same precondition as
// bridge keys: a human must already be logged in to mint a machine
// credential. Never reachable via an API key itself (no key can mint or
// manage other keys).
// ============================================

// Mint a new API key. { name?, sandbox? } — sandbox keys can only ever see
// sandbox data (enforced in getProviderForUser), live keys reach the
// account's real connected providers. The raw key is returned once.
const VALID_API_KEY_SCOPES = ['tasks:read', 'tasks:write'];

// Accepts scopes as an array (["tasks:read"]) or a comma-separated string
// ("tasks:read,tasks:write"). Omitted → full default scope, unchanged
// behavior for every key minted before scope enforcement existed. An
// explicit empty/invalid list is rejected rather than silently upgraded to
// full access.
function normalizeApiKeyScopes(input) {
  if (input === undefined) return VALID_API_KEY_SCOPES.join(',');
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const cleaned = [...new Set(raw.map(s => String(s).trim()).filter(Boolean))];
  if (cleaned.length === 0) {
    throw new Error(`scopes must include at least one of: ${VALID_API_KEY_SCOPES.join(', ')}`);
  }
  const invalid = cleaned.filter(s => !VALID_API_KEY_SCOPES.includes(s));
  if (invalid.length) {
    throw new Error(`Invalid scope(s): ${invalid.join(', ')}. Valid scopes: ${VALID_API_KEY_SCOPES.join(', ')}`);
  }
  return cleaned.join(',');
}

app.post('/auth/api-keys', authService.requireAuth(), async (req, res) => {
  try {
    const { name, sandbox, scopes } = req.body || {};
    let normalizedScopes;
    try {
      normalizedScopes = normalizeApiKeyScopes(scopes);
    } catch (err) {
      return apiError(res, 'invalid_request', err.message);
    }
    const created = await userService.createApiKey(req.user.userId, { name, sandbox: !!sandbox, scopes: normalizedScopes });
    res.json({
      ...created,
      createdAt: new Date().toISOString(),
      message: 'Store this key securely. It will not be shown again.'
    });
  } catch (error) {
    apiError(res, 'internal_error', error.message);
  }
});

// List this account's API keys (metadata only — never the raw key or hash)
app.get('/auth/api-keys', authService.requireAuth(), async (req, res) => {
  try {
    const keys = await userService.listApiKeys(req.user.userId);
    res.json({ keys });
  } catch (error) {
    apiError(res, 'internal_error', error.message);
  }
});

// Revoke a key by id
app.delete('/auth/api-keys/:id', authService.requireAuth(), async (req, res) => {
  try {
    const revoked = await userService.revokeApiKey(req.user.userId, req.params.id);
    if (!revoked) return apiError(res, 'not_found', 'API key not found');
    res.json({ success: true });
  } catch (error) {
    apiError(res, 'internal_error', error.message);
  }
});

// Reset a sandbox key's in-memory task store back to the fixture baseline —
// lets a developer retest a write flow without minting a new key.
app.post('/api/sandbox/reset', ...apiKeyAuth, async (req, res) => {
  if (!req.apiKey?.sandbox) {
    return apiError(res, 'forbidden', 'Only sandbox API keys can reset sandbox data');
  }
  SandboxProvider.resetStore(req.apiKey.id);
  // Same cache keys the task-mutation routes below invalidate on write —
  // without this, reads would keep serving pre-reset data from SimpleCache
  // until its TTL naturally expires.
  const userId = req.user.userId;
  cache.deletePrefix(`tasks:${userId}:sandbox:`);
  cache.delete(`unified:${userId}`);
  cache.delete(`lists:all:${userId}`);
  cache.delete(`lists:${userId}:sandbox`);
  cache.deletePrefix(`counts:${userId}:sandbox:`);
  res.json({ success: true, message: 'Sandbox data reset to fixture baseline' });
});

// ============================================
// Hosted MCP endpoint (Streamable HTTP) — same tools as the stdio server
// (src/mcp-server.js), for developers who'd rather not run a local process.
// Stateless: a fresh McpServer + transport is created per request, bound to
// the caller's own API key, which the tool handlers use to call this same
// server's REST routes over HTTP (self-loopback) — no session state to
// manage, no reimplemented business logic.
// ============================================
app.post('/mcp', ...apiKeyAuth, async (req, res) => {
  try {
    const rawKey = req.headers['authorization'].substring(7); // apiKeyAuth already validated this is a Bearer token
    const selfBaseUrl = process.env.SELF_BASE_URL || `http://localhost:${API_PORT}`;
    const server = createUpqMcpServer({ baseUrl: selfBaseUrl, apiKey: rawKey });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('/mcp error:', error.message);
    if (!res.headersSent) apiError(res, 'internal_error', error.message);
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
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));

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

// Daily subscription maintenance — runs 60s after startup then every 24h
setTimeout(() => {
  runSubscriptionMaintenance();
  setInterval(runSubscriptionMaintenance, 24 * 60 * 60 * 1000);
}, 60_000);

// Daily idempotency-key cleanup — same cadence as subscription maintenance
setTimeout(() => {
  cleanupIdempotencyKeys();
  setInterval(cleanupIdempotencyKeys, 24 * 60 * 60 * 1000);
}, 60_000);

// Daily api_usage_events cleanup — same cadence as the other daily jobs
setTimeout(() => {
  cleanupApiUsageEvents();
  setInterval(cleanupApiUsageEvents, 24 * 60 * 60 * 1000);
}, 60_000);
