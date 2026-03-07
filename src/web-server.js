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

// Proxy API and auth routes to the task service
app.use(
  ['/api', '/auth', '/billing', '/health'],
  createProxyMiddleware({
    target: API_URL,
    changeOrigin: true,
    onError: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({ error: 'Task service unavailable', message: err.message });
    }
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Legal pages (clean URLs for OAuth app registration)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

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
