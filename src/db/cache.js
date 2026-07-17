const Redis = require('ioredis');

let client = null;

function getClient() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false });
    client.on('error', (err) => console.error('Redis error:', err.message));
    // Disable RDB snapshots so credentials are never written to disk by Redis.
    client.once('ready', () => {
      client.config('SET', 'save', '').catch((err) => console.warn('Redis: could not disable RDB persistence:', err.message));
    });
  }
  return client;
}

async function get(key) {
  const c = getClient();
  if (!c) return null;
  return c.get(key).catch((err) => { console.warn('Redis get error (non-fatal):', err.message); return null; });
}

async function set(key, value) {
  const c = getClient();
  if (c) await c.set(key, value).catch((err) => console.warn('Redis set error (non-fatal):', err.message));
}

async function del(...keys) {
  const c = getClient();
  if (c && keys.length) await c.del(...keys).catch((err) => console.warn('Redis del error (non-fatal):', err.message));
}

module.exports = { get, set, del, getClient };
