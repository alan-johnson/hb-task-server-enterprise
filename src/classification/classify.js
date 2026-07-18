'use strict';

const { evaluateWithReason, parseDueDate } = require('./predicateEngine');

// The original two-field classifier, unchanged from src/task-server.js.
// Rules with no schemaVersion (or schemaVersion: 1) are legacy shape and
// must classify identically forever — real accounts already have rules
// saved in this shape and nothing here should force a migration.
//
// Returns { bucket, reason } — classifyTaskLegacy() below is a thin wrapper
// extracting just .bucket, so the original bare-string contract every
// existing caller/test relies on is completely unchanged; this is the
// richer entry point new callers (explainability) use instead.
function classifyTaskLegacyWithReason(task, rules) {
  if (task.completed) return { bucket: null, reason: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let dueDate = null;
  if (task.dueDate) {
    const m = task.dueDate.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      dueDate = new Date(+m[1], +m[2] - 1, +m[3]);
    } else {
      const d = new Date(task.dueDate);
      if (!isNaN(d)) { dueDate = new Date(d); dueDate.setHours(0, 0, 0, 0); }
    }
  }

  const priority  = task.priority || 'low';
  const isOverdue = dueDate && dueDate <= today;
  const isFuture  = dueDate && dueDate > today;

  const nowByOverdue  = !!(rules.now.overdue && isOverdue);
  const nowByPriority = !!(rules.now.priorities && rules.now.priorities.includes(priority));
  if (nowByOverdue || nowByPriority) {
    const reasons = [];
    if (nowByOverdue)  reasons.push('overdue');
    if (nowByPriority) reasons.push(`priority "${priority}" is in now.priorities`);
    return { bucket: 'now', reason: reasons.join(' and ') };
  }

  const nextByFuture   = !!(rules.next.future_due && isFuture);
  const nextByPriority = !!(rules.next.priorities && rules.next.priorities.includes(priority));
  if (nextByFuture || nextByPriority) {
    const reasons = [];
    if (nextByFuture)   reasons.push('due in the future');
    if (nextByPriority) reasons.push(`priority "${priority}" is in next.priorities`);
    return { bucket: 'next', reason: reasons.join(' and ') };
  }

  return { bucket: 'later', reason: 'no now/next rule matched' };
}

// schemaVersion:2 classifier — rules.now/rules.next are predicate trees
// (see src/classification/predicateEngine.js). Same now→next→later cascade
// order as the legacy classifier; rules.later is never itself evaluated as
// a predicate, same as legacy — it's the fallback bucket, not a match target.
function classifyTaskV2WithReason(task, rules, context = {}) {
  if (task.completed) return { bucket: null, reason: null };
  const today = context.today || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const ctx = { today };

  const nowResult = evaluateWithReason(task, rules.now, ctx);
  if (nowResult.matched) return { bucket: 'now', reason: nowResult.reason };

  const nextResult = evaluateWithReason(task, rules.next, ctx);
  if (nextResult.matched) return { bucket: 'next', reason: nextResult.reason };

  return { bucket: 'later', reason: 'no now/next rule matched' };
}

// Dispatcher (richer form) — every triage-adjacent route calls this to get
// both task.classification and task.classificationReason.
function classifyTaskWithReason(task, rules, context) {
  if (rules && rules.schemaVersion === 2) return classifyTaskV2WithReason(task, rules, context);
  return classifyTaskLegacyWithReason(task, rules);
}

// Bare-string dispatcher — every existing call site calls classifyTask(task,
// rules) and gets a bucket string back; this preserves that exact signature
// so nothing already depending on it needs to change. Derived from the
// *WithReason functions above so there is exactly one implementation of the
// actual classification logic, not two that could drift apart.
function classifyTask(task, rules) {
  return classifyTaskWithReason(task, rules).bucket;
}
function classifyTaskLegacy(task, rules) {
  return classifyTaskLegacyWithReason(task, rules).bucket;
}
function classifyTaskV2(task, rules, context) {
  return classifyTaskV2WithReason(task, rules, context).bucket;
}

module.exports = {
  classifyTask, classifyTaskLegacy, classifyTaskV2,
  classifyTaskWithReason, classifyTaskLegacyWithReason, classifyTaskV2WithReason,
  parseDueDate
};
