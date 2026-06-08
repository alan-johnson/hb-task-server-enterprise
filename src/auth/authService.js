const jwt = require('jsonwebtoken');

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
}

module.exports = AuthService;
