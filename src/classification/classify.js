'use strict';

const { evaluatePredicate, parseDueDate } = require('./predicateEngine');

// The original two-field classifier, unchanged from src/task-server.js.
// Rules with no schemaVersion (or schemaVersion: 1) are legacy shape and
// must classify identically forever — real accounts already have rules
// saved in this shape and nothing here should force a migration.
function classifyTaskLegacy(task, rules) {
  if (task.completed) return null;
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

  const nowMatch = (rules.now.overdue && isOverdue) ||
                   (rules.now.priorities && rules.now.priorities.includes(priority));
  if (nowMatch) return 'now';

  const nextMatch = (rules.next.future_due && isFuture) ||
                    (rules.next.priorities && rules.next.priorities.includes(priority));
  if (nextMatch) return 'next';

  return 'later';
}

// schemaVersion:2 classifier — rules.now/rules.next are predicate trees
// (see src/classification/predicateEngine.js). Same now→next→later cascade
// order as the legacy classifier; rules.later is never itself evaluated as
// a predicate, same as legacy — it's the fallback bucket, not a match target.
function classifyTaskV2(task, rules, context = {}) {
  if (task.completed) return null;
  const today = context.today || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const ctx = { today };

  if (evaluatePredicate(task, rules.now, ctx)) return 'now';
  if (evaluatePredicate(task, rules.next, ctx)) return 'next';
  return 'later';
}

// Dispatcher — every existing call site in task-server.js calls
// classifyTask(task, rules) and gets a bucket string back; this preserves
// that exact signature so nothing downstream needs to change.
function classifyTask(task, rules) {
  if (rules && rules.schemaVersion === 2) return classifyTaskV2(task, rules);
  return classifyTaskLegacy(task, rules);
}

module.exports = { classifyTask, classifyTaskLegacy, classifyTaskV2, parseDueDate };
