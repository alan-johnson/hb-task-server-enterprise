const { logUsageEvent } = require('./usageService');

// Classifies a request into the category Step 7 needs to answer "does triage
// usage predict retention": triage (the aggregated Now/Next/Later endpoint),
// rules (reading/writing classification rules), raw_tasks (everything else
// under /api/lists or /api/tasks — the "just pulling raw task lists" case the
// hypothesis is testing against), or other.
function categorize(path) {
  if (path.startsWith('/api/tasks/unified')) return 'triage';
  if (path.startsWith('/auth/me/classification')) return 'rules';
  if (path.startsWith('/api/lists') || path.startsWith('/api/tasks')) return 'raw_tasks';
  return 'other';
}

// Mount after requireApiKeyOrJWT so req.user/req.apiKey are populated.
// Logs on res 'finish' so the real final status code is captured with no
// added latency on the response itself.
function usageLogger(req, res, next) {
  res.on('finish', () => {
    if (!req.user) return;
    logUsageEvent({
      userId: req.user.userId,
      apiKeyId: req.apiKey?.id,
      endpoint: `${req.method} ${req.path}`,
      category: categorize(req.path),
      statusCode: res.statusCode
    });
  });
  next();
}

module.exports = { usageLogger, categorize };
