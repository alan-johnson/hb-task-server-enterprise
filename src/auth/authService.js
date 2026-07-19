const jwt = require('jsonwebtoken');
const { apiError } = require('../errors');

const API_KEY_PREFIXES = ['upq_live_', 'upq_sandbox_'];

class AuthService {
  constructor(jwtSecret) {
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error('JWT_SECRET env var is required and must be at least 32 characters');
    }
    this.jwtSecret = jwtSecret;
  }

  // Generate JWT token for a user
  generateToken(userId, username) {
    return jwt.sign(
      { 
        userId, 
        username,
        createdAt: new Date().toISOString()
      },
      this.jwtSecret,
      { expiresIn: '30d', algorithm: 'HS256' }
    );
  }

  // Verify JWT token
  verifyToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] });
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }

  // Middleware to protect routes
  requireAuth() {
    return (req, res, next) => {
      try {
        const authHeader = req.headers['authorization'];

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({
            error: 'Authentication required',
            message: 'Please provide a valid authorization token'
          });
        }

        const token = authHeader.substring(7);
        const decoded = this.verifyToken(token);

        // Attach user info to request
        req.user = decoded;
        next();
      } catch (error) {
        return res.status(401).json({
          error: 'Invalid authentication',
          message: error.message
        });
      }
    };
  }

  // Middleware to enforce an active subscription on protected routes.
  // Must run after requireAuth() so req.user is populated.
  // Pass the userService instance: authService.requireSubscription(userService)
  requireSubscription(userService) {
    return async (req, res, next) => {
      try {
        const user = await userService.getUser(req.user.userId);
        const status = user?.subscriptionStatus || 'none';

        // Safety net: if a trialing user's trial has expired (missed webhook), cancel now
        if (status === 'trialing' && user.trialEnd && new Date(user.trialEnd) < new Date()) {
          await userService.updateSubscription(req.user.userId, user.stripeCustomerId, 'canceled', null, null);
          return res.status(402).json({ error: 'subscription_required', status: 'canceled' });
        }

        if (['active', 'trialing', 'past_due'].includes(status)) return next();

        return res.status(402).json({ error: 'subscription_required', status });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    };
  }

  // Same subscription gate, but skipped for API-key-authenticated requests —
  // the developer beta is free (see Step 6 of the lean beta plan), while
  // existing JWT-authenticated browser users still need an active
  // subscription, same as before this beta work. Must run after
  // requireApiKeyOrJWT() so req.authMethod is populated.
  //
  // Reaffirmed deliberately, not stale beta-era leftover code: a standalone
  // paid "Developer" tier (gating live-key creation/usage, independent of
  // this UpQ subscription) was scoped in full — schema, webhook, checkout,
  // enforcement — see docs/developer-tier-billing-plan.md. But
  // docs/developer-api-pricing-tiers.md, which that plan implements against,
  // says not to wire up billing until design-partner interest validates the
  // proposed tiers. So live API-key creation/usage stays free for everyone
  // until that happens — don't add a gate here without reading both docs.
  requireSubscriptionUnlessApiKey(userService) {
    const gate = this.requireSubscription(userService);
    return (req, res, next) => {
      if (req.authMethod === 'apiKey') return next();
      return gate(req, res, next);
    };
  }

  // Accepts either a JWT (full account privileges, browser/human path) or a
  // developer API key (upq_live_/upq_sandbox_ prefixed, scoped machine-client
  // credential). Populates req.user the same way either path, plus req.apiKey
  // for key-authenticated requests so downstream handlers (sandbox routing,
  // usage logging) can branch on it. Never applied to billing/account routes —
  // that's what actually keeps API keys out of those paths, not convention.
  requireApiKeyOrJWT(userService) {
    return async (req, res, next) => {
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return apiError(res, 'unauthorized', 'Provide a JWT or API key as a Bearer token');
      }
      const token = authHeader.substring(7);

      if (API_KEY_PREFIXES.some(p => token.startsWith(p))) {
        try {
          const keyRecord = await userService.findApiKeyByRawKey(token);
          if (!keyRecord) {
            return apiError(res, 'unauthorized', 'Invalid or revoked API key');
          }
          req.user = { userId: keyRecord.userId, username: keyRecord.username };
          req.authMethod = 'apiKey';
          req.apiKey = { id: keyRecord.id, sandbox: keyRecord.sandbox, scopes: keyRecord.scopes };
          userService.touchApiKeyLastUsed(keyRecord.id);
          return next();
        } catch (err) {
          return apiError(res, 'internal_error', err.message);
        }
      }

      try {
        const decoded = this.verifyToken(token);
        req.user = decoded;
        req.authMethod = 'jwt';
        next();
      } catch (error) {
        return apiError(res, 'unauthorized', error.message);
      }
    };
  }

  // Enforces the tasks:read/tasks:write split a developer picked when
  // minting an API key. JWT requests carry full account privileges and skip
  // this entirely, same as before scopes existed. GET/HEAD requires
  // tasks:read; every other method requires tasks:write. Must run after
  // requireApiKeyOrJWT() so req.authMethod/req.apiKey are populated.
  //
  // POST /mcp is deliberately exempt: it multiplexes several JSON-RPC
  // operations (some read, some write) behind one HTTP method, so a blanket
  // POST=write check here would block a read-only key from calling
  // get_triage over MCP. Per-operation enforcement instead happens when the
  // MCP tool handler calls back into these same REST routes with the same
  // key — see src/mcp/tools.js.
  requireScope() {
    return (req, res, next) => {
      if (req.authMethod !== 'apiKey') return next();
      if (req.path === '/mcp') return next();

      const required = ['GET', 'HEAD'].includes(req.method) ? 'tasks:read' : 'tasks:write';
      const granted = new Set((req.apiKey.scopes || '').split(',').map(s => s.trim()).filter(Boolean));
      if (!granted.has(required)) {
        return apiError(res, 'forbidden', `This API key is missing the '${required}' scope`);
      }
      next();
    };
  }

  // Minimal admin gate for the system-classification-defaults route (see
  // docs/triage-engine-implementation-plan.md, Phase 0). No roles/permissions
  // table exists in this schema, and building one is out of scope for a
  // single admin route — configurable instead via ADMIN_USERNAMES
  // (comma-separated), defaulting to 'admin', the account
  // scripts/create-admin.js already establishes as this project's designated
  // ops/test account. Must run after requireAuth() — JWT-only, same as every
  // other account-management route; never reachable via an API key.
  requireAdmin() {
    const admins = new Set(
      (process.env.ADMIN_USERNAMES || 'admin').split(',').map(s => s.trim()).filter(Boolean)
    );
    return (req, res, next) => {
      if (!admins.has(req.user?.username)) {
        return apiError(res, 'forbidden', 'Admin access required');
      }
      next();
    };
  }
}

module.exports = AuthService;
