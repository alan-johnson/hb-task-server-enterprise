// Thin HTTP client the MCP server (both stdio and hosted transports) uses to
// call UpQ's own REST API — tools wrap existing endpoints rather than
// reimplementing triage/rules logic, per the lean beta plan's "close to
// free to add on top of the same backend" framing.
async function callUpq(baseUrl, apiKey, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && (data.error.message || data.error)) || `UpQ API error (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.code = data.error && data.error.code;
    throw err;
  }
  return data;
}

function getTriage(baseUrl, apiKey, { listId, excludeList } = {}) {
  const params = new URLSearchParams();
  if (listId) params.set('list_id', listId);
  if (excludeList) params.set('exclude_list', excludeList);
  const qs = params.toString();
  return callUpq(baseUrl, apiKey, `/api/tasks/unified${qs ? `?${qs}` : ''}`);
}

function getRules(baseUrl, apiKey) {
  return callUpq(baseUrl, apiKey, '/auth/me/classification');
}

function setRules(baseUrl, apiKey, rules) {
  return callUpq(baseUrl, apiKey, '/auth/me/classification', { method: 'PUT', body: rules });
}

module.exports = { getTriage, getRules, setRules };
