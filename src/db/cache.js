const Redis = require('ioredis');

let client = null;

function getClient() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false });
    client.on('error', (err) => console.error('Redis error:', err.message));
  }
  return client;
}

async function get(key) {
  const c = getClient();
  return c ? c.get(key) : null;
}

async function set(key, value) {
  const c = getClient();
  if (c) await c.set(key, value);
}

async function del(...keys) {
  const c = getClient();
  if (c && keys.length) await c.del(...keys);
}

module.exports = { get, set, del };
