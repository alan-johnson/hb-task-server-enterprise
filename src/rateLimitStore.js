const { getClient } = require('./db/cache');

// Redis-backed store for express-rate-limit. Production currently runs as a
// single PM2 process (see upq_terraform_files/upq-infra/ecosystem.config.js —
// fork mode, instances: 1, required by the Apple bridge's WebSocket session
// affinity), so express-rate-limit's default in-memory MemoryStore is
// correct today. But it's a landmine: if instance count ever changes for any
// reason unrelated to the bridge (e.g. scaling the API under load), every
// limit here would silently multiply by instance count with no error. This
// makes the limits correct regardless of instance count, now, for free.
//
// Falls back to express-rate-limit's built-in MemoryStore when REDIS_URL
// isn't configured (local dev, CI) — same graceful-degradation shape as
// src/db/cache.js, which this reuses the client from rather than opening a
// second Redis connection.
function createRedisStore({ windowMs, prefix }) {
  const client = getClient();
  if (!client) return undefined; // rateLimit() defaults to MemoryStore when store is undefined

  return {
    async increment(key) {
      const redisKey = `ratelimit:${prefix}:${key}`;
      try {
        const totalHits = await client.incr(redisKey);
        let ttl = await client.pttl(redisKey);
        // First hit on this key (or a lost TTL) — arm the window. Racing
        // concurrent first hits may both set the same expiry; harmless.
        if (ttl < 0) {
          await client.pexpire(redisKey, windowMs);
          ttl = windowMs;
        }
        return { totalHits, resetTime: new Date(Date.now() + ttl) };
      } catch (err) {
        // Redis reachable-but-erroring (e.g. a request racing the connection
        // handshake right after a cold boot — enableOfflineQueue is off, so
        // that throws instead of queuing). Fail open rather than 500 the
        // request: same non-fatal-warn-and-continue shape as src/db/cache.js.
        console.warn(`rateLimitStore increment error for ${redisKey} (failing open):`, err.message);
        return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
      }
    },
    async decrement(key) {
      await client.decr(`ratelimit:${prefix}:${key}`).catch(() => {});
    },
    async resetKey(key) {
      await client.del(`ratelimit:${prefix}:${key}`).catch(() => {});
    },
  };
}

module.exports = { createRedisStore };
