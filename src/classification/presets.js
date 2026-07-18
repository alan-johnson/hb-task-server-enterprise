'use strict';

// Named schemaVersion:2 rulesets a developer or "product designer" persona
// (see docs/upq-rest-api-lean-beta-plan.md) can apply as a starting point
// instead of hand-writing predicate JSON (see
// docs/triage-engine-implementation-plan.md, Phase 2). Applying one is just
// PUT /auth/me/classification with its `rules` value — no separate write
// route needed, this module only needs to be discoverable
// (GET /auth/me/classification/presets).
//
// Three to start, per the plan — confirm the actual persona names with
// product before hardcoding more.
const PRESETS = {
  gtd: {
    label: 'GTD (Getting Things Done)',
    description: 'Now = overdue or high priority. Next = has a future due date (a scheduled next action). Later = everything else (someday/maybe).',
    rules: {
      schemaVersion: 2,
      now:   { any: [{ field: 'dueDate', op: 'overdue' }, { field: 'priority', op: 'eq', value: 'high' }] },
      next:  { field: 'dueDate', op: 'future_due' },
      later: {}
    }
  },
  eisenhower: {
    label: 'Eisenhower Matrix',
    description: 'Now = urgent and important (high priority, due within 3 days). Next = urgent or important on its own (high priority, or due within a week). Later = neither.',
    rules: {
      schemaVersion: 2,
      now:   { all: [{ field: 'priority', op: 'eq', value: 'high' }, { field: 'dueDate', op: 'within_days', value: 3 }] },
      next:  { any: [{ field: 'priority', op: 'eq', value: 'high' }, { field: 'dueDate', op: 'within_days', value: 7 }] },
      later: {}
    }
  },
  support_triage: {
    label: 'Support Triage',
    description: 'Now = overdue or high priority (an SLA-style urgent queue). Next = due within 2 days. Later = no near-term due-date pressure.',
    rules: {
      schemaVersion: 2,
      now:   { any: [{ field: 'dueDate', op: 'overdue' }, { field: 'priority', op: 'eq', value: 'high' }] },
      next:  { field: 'dueDate', op: 'within_days', value: 2 },
      later: {}
    }
  }
};

function listPresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description, rules: p.rules }));
}

module.exports = { PRESETS, listPresets };
