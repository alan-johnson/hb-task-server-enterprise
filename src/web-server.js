require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const WEB_PORT   = parseInt(process.env.WEB_PORT   || '80',  10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
const API_URL    = process.env.API_URL || 'http://localhost:3500';
const SSL_KEY    = process.env.SSL_KEY_PATH;
const SSL_CERT   = process.env.SSL_CERT_PATH;

const useHttps = !!(SSL_KEY && SSL_CERT);

// ── Task-server health tracking ──────────────────────────────────────────────
let taskServerUp = false; // pessimistic until first probe succeeds

function probeTaskServer() {
  let parsed;
  try { parsed = new URL('/health', API_URL); } catch { taskServerUp = false; return; }
  const mod = parsed.protocol === 'https:' ? https : http;
  const req = mod.get(
    { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: '/health', timeout: 2000 },
    (res) => { taskServerUp = res.statusCode >= 200 && res.statusCode < 300; res.resume(); }
  );
  req.on('error',   () => { taskServerUp = false; });
  req.on('timeout', () => { req.destroy(); taskServerUp = false; });
}

probeTaskServer();                        // check immediately on startup
setInterval(probeTaskServer, 10_000);     // re-probe every 10 seconds

const MAINTENANCE_PAGE = path.join(__dirname, 'public', 'maintenance.html');
const STATIC_ASSET_RE  = /\.(css|js|png|jpg|jpeg|gif|ico|svg|webp|webmanifest|woff2?)$/i;

// Maintenance gate — intercepts all requests when the task server is unreachable
app.use((req, res, next) => {
  if (!taskServerUp && !STATIC_ASSET_RE.test(req.path)) {
    return res.status(503).sendFile(MAINTENANCE_PAGE);
  }
  next();
});

// Proxy API and auth routes to the task service
app.use(
  ['/api', '/auth', '/billing', '/health'],
  createProxyMiddleware({
    target: API_URL,
    changeOrigin: true,
    onError: (err, req, res) => {
      console.error('Proxy error:', err.message);
      taskServerUp = false;
      res.status(503).sendFile(MAINTENANCE_PAGE);
    }
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Legal pages (clean URLs for OAuth app registration)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));

// Catch-all 404
app.use((req, res) => res.status(404).send('Not found'));

// ============================================
// Start servers
// ============================================

if (useHttps) {
  // HTTPS server
  const sslOptions = {
    key:  fs.readFileSync(SSL_KEY),
    cert: fs.readFileSync(SSL_CERT),
  };
  https.createServer(sslOptions, app).listen(HTTPS_PORT, () => {
    console.log(`Web service (HTTPS) running on https://0.0.0.0:${HTTPS_PORT}`);
    console.log(`Proxying /api and /auth to ${API_URL}`);
  });

  // HTTP redirect server
  const redirectApp = express();
  redirectApp.use((req, res) => {
    res.redirect(301, `https://${req.hostname}${req.url}`);
  });
  http.createServer(redirectApp).listen(WEB_PORT, () => {
    console.log(`HTTP redirect running on port ${WEB_PORT} -> HTTPS`);
  });
} else {
  // HTTP only
  http.createServer(app).listen(WEB_PORT, () => {
    console.log(`Web service (HTTP) running on http://0.0.0.0:${WEB_PORT}`);
    console.log(`Proxying /api and /auth to ${API_URL}`);
  });
}
