// Unified error shape for the developer REST API / MCP surface.
// Not adopted repo-wide — existing routes keep their ad hoc {error: '...'} shapes.
const ERROR_CODES = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  subscription_required: 402,
  provider_error: 502,
  internal_error: 500
};

function apiError(res, code, message, extra = {}) {
  const status = ERROR_CODES[code] || 500;
  return res.status(status).json({ error: { code, message, ...extra } });
}

module.exports = { ERROR_CODES, apiError };
