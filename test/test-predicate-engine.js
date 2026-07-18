#!/usr/bin/env node

/**
 * Predicate Engine Tests — pure unit tests, no running server needed
 * (see docs/triage-engine-implementation-plan.md, Phase 1 and Phase 2).
 *
 * Covers src/classification/predicateEngine.js (evaluatePredicate: all/any/not
 * composition, each op; evaluateWithReason: explainability), and
 * src/classification/classify.js (the legacy-vs-v2 classifyTask dispatcher,
 * and the *WithReason variants).
 *
 * Usage:
 *   node test/test-predicate-engine.js
 */

const { evaluatePredicate, evaluateWithReason, describePredicate } = require('../src/classification/predicateEngine');
const { classifyTask, classifyTaskLegacy, classifyTaskV2, classifyTaskWithReason, classifyTaskLegacyWithReason, classifyTaskV2WithReason } = require('../src/classification/classify');

let passed = 0, failed = 0;
function pass(msg) { console.log(`  ✓  ${msg}`); passed++; }
function fail(msg, detail) { console.error(`  ✗  ${msg}`); if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`); failed++; }
function assert(condition, passMsg, failMsg, detail) { condition ? pass(passMsg) : fail(failMsg, detail); }
function section(title) { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`); }

const today = new Date(); today.setHours(0, 0, 0, 0);
const context = { today };
function iso(offsetDays) {
  const d = new Date(today);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function testOps() {
  section('Leaf ops');

  assert(evaluatePredicate({ dueDate: iso(-1) }, { field: 'dueDate', op: 'overdue' }, context) === true,
    'overdue: true for a past due date', 'overdue op wrong for past date');
  assert(evaluatePredicate({ dueDate: iso(1) }, { field: 'dueDate', op: 'overdue' }, context) === false,
    'overdue: false for a future due date', 'overdue op wrong for future date');
  assert(evaluatePredicate({}, { field: 'dueDate', op: 'overdue' }, context) === false,
    'overdue: false when dueDate is missing', 'overdue op should be false, not throw, on missing dueDate');

  assert(evaluatePredicate({ dueDate: iso(3) }, { field: 'dueDate', op: 'future_due' }, context) === true,
    'future_due: true for a future date', 'future_due op wrong for future date');
  assert(evaluatePredicate({ dueDate: iso(-3) }, { field: 'dueDate', op: 'future_due' }, context) === false,
    'future_due: false for a past date', 'future_due op wrong for past date');

  assert(evaluatePredicate({ dueDate: iso(3) }, { field: 'dueDate', op: 'within_days', value: 5 }, context) === true,
    'within_days: true when 3 days out and window is 5', 'within_days op wrong (3 within 5)');
  assert(evaluatePredicate({ dueDate: iso(10) }, { field: 'dueDate', op: 'within_days', value: 5 }, context) === false,
    'within_days: false when 10 days out and window is 5', 'within_days op wrong (10 not within 5) — this exact case caught a real sign-flip bug during implementation');
  assert(evaluatePredicate({ dueDate: iso(-2) }, { field: 'dueDate', op: 'within_days', value: 5 }, context) === true,
    'within_days: true for an already-overdue task (inclusive of overdue, not future-only)', 'within_days should treat overdue as within the window');

  assert(evaluatePredicate({ priority: 'high' }, { field: 'priority', op: 'eq', value: 'high' }, context) === true,
    'eq: matches on priority', 'eq op failed');
  assert(evaluatePredicate({ priority: 'normal' }, { field: 'priority', op: 'includes', value: ['high', 'normal'] }, context) === true,
    'includes: scalar field found in a value array', 'includes (field-in-value-array direction) failed');
  assert(evaluatePredicate({ tags: ['urgent', 'client'] }, { field: 'tags', op: 'includes', value: 'urgent' }, context) === true,
    'includes: value found in an array field', 'includes (value-in-field-array direction) failed');
  assert(evaluatePredicate({}, { field: 'tags', op: 'includes', value: 'urgent' }, context) === false,
    'includes: false (not throw) when the array field is entirely absent', 'includes should degrade to false for a task with no tags field at all');

  assert(evaluatePredicate({ updated: iso(-10) }, { field: 'ageDays', op: 'gt', value: 5 }, context) === true,
    'ageDays gt: true for a task updated 10 days ago with threshold 5', 'ageDays/gt failed');
  assert(evaluatePredicate({ updated: iso(-1) }, { field: 'ageDays', op: 'lt', value: 5 }, context) === true,
    'ageDays lt: true for a task updated yesterday with threshold 5', 'ageDays/lt failed');
}

function testComposition() {
  section('all / any / not composition');

  const highOverdue = { priority: 'high', dueDate: iso(-1) };
  const highFuture   = { priority: 'high', dueDate: iso(5) };
  const lowOverdue   = { priority: 'low',  dueDate: iso(-1) };

  const allNode = { all: [{ field: 'priority', op: 'eq', value: 'high' }, { field: 'dueDate', op: 'overdue' }] };
  assert(evaluatePredicate(highOverdue, allNode, context) === true,
    'all: true when every child matches', 'all composition failed (expected true)');
  assert(evaluatePredicate(highFuture, allNode, context) === false,
    'all: false when one child fails (this is exactly what today\'s two-boolean classifier cannot express)', 'all composition failed (expected false)');

  const anyNode = { any: [{ field: 'dueDate', op: 'overdue' }, { field: 'priority', op: 'eq', value: 'high' }] };
  assert(evaluatePredicate(lowOverdue, anyNode, context) === true,
    'any: true when at least one child matches', 'any composition failed');
  assert(evaluatePredicate({ priority: 'low', dueDate: iso(5) }, anyNode, context) === false,
    'any: false when no child matches', 'any composition failed (expected false)');

  assert(evaluatePredicate(highFuture, { not: { field: 'dueDate', op: 'overdue' } }, context) === true,
    'not: inverts a false child to true', 'not composition failed');
  assert(evaluatePredicate(highOverdue, { not: { field: 'dueDate', op: 'overdue' } }, context) === false,
    'not: inverts a true child to false', 'not composition failed (expected false)');

  const nested = { all: [{ field: 'priority', op: 'eq', value: 'high' }, { not: { field: 'dueDate', op: 'overdue' } }] };
  assert(evaluatePredicate(highFuture, nested, context) === true,
    'nested all+not: high priority AND NOT overdue matches a future high-priority task', 'nested composition failed');

  assert(evaluatePredicate({}, {}, context) === false,
    'an empty node ({}) evaluates to false, not vacuously true', 'empty predicate node should not match everything');
}

function testClassifyDispatch() {
  section('classifyTask legacy/v2 dispatch');

  const legacyRules = { now: { overdue: true, priorities: ['high'] }, next: { future_due: true, priorities: ['normal'] }, later: {} };
  const overdueTask  = { priority: 'high', dueDate: iso(-1), completed: false };

  assert(classifyTask(overdueTask, legacyRules) === 'now',
    'classifyTask dispatches to legacy classifier when schemaVersion is absent', 'legacy dispatch failed');
  assert(classifyTaskLegacy(overdueTask, legacyRules) === classifyTask(overdueTask, legacyRules),
    'classifyTask(legacy rules) matches classifyTaskLegacy called directly, byte-for-byte behavior', 'dispatcher diverged from direct legacy call');

  const v2Rules = {
    schemaVersion: 2,
    now: { all: [{ field: 'priority', op: 'eq', value: 'high' }, { field: 'dueDate', op: 'within_days', value: 3 }] },
    next: { field: 'dueDate', op: 'future_due' },
    later: {}
  };
  assert(classifyTask(overdueTask, v2Rules) === 'now',
    'classifyTask dispatches to v2 predicate engine when schemaVersion:2', 'v2 dispatch failed');
  assert(classifyTaskV2(overdueTask, v2Rules) === classifyTask(overdueTask, v2Rules),
    'classifyTask(v2 rules) matches classifyTaskV2 called directly', 'dispatcher diverged from direct v2 call');

  const expressibleOnlyInV2 = {
    schemaVersion: 2,
    now: { all: [{ field: 'priority', op: 'eq', value: 'high' }, { field: 'dueDate', op: 'within_days', value: 3 }] },
    next: {}, later: {}
  };
  // High priority but due in 10 days — legacy rules would put this in "now"
  // purely on priority; a v2 AND-composed rule correctly excludes it.
  const highButFar = { priority: 'high', dueDate: iso(10), completed: false };
  assert(classifyTask(highButFar, expressibleOnlyInV2) !== 'now',
    'v2 AND composition expresses "high priority AND due soon" — something the legacy shape cannot', 'v2 rule failed to exclude a high-priority-but-not-soon task');

  assert(classifyTask({ completed: true, priority: 'high', dueDate: iso(-1) }, legacyRules) === null,
    'completed tasks classify to null under legacy rules', 'completed-task handling failed (legacy)');
  assert(classifyTask({ completed: true, priority: 'high', dueDate: iso(-1) }, v2Rules) === null,
    'completed tasks classify to null under v2 rules', 'completed-task handling failed (v2)');
}

function testExplainability() {
  section('Explainability (evaluateWithReason / classifyTaskWithReason)');

  const leaf = evaluateWithReason({ priority: 'high' }, { field: 'priority', op: 'eq', value: 'high' }, context);
  assert(leaf.matched === true && leaf.reason === 'priority = "high"',
    'a matched leaf carries a human-readable reason', 'leaf reason wrong or missing', leaf);

  const unmatched = evaluateWithReason({ priority: 'low' }, { field: 'priority', op: 'eq', value: 'high' }, context);
  assert(unmatched.matched === false && unmatched.reason === null,
    'an unmatched node carries no reason (null, not a misleading string)', 'unmatched node should have reason: null', unmatched);

  // "any" must report only the branch that actually fired, not a generic
  // "an any-block matched" — that's the part of explainability actually
  // useful to a rule-tuning UI or an agent.
  const anyNode = { any: [{ field: 'priority', op: 'eq', value: 'high' }, { field: 'dueDate', op: 'overdue' }] };
  const anySecondBranch = evaluateWithReason({ priority: 'low', dueDate: iso(-1) }, anyNode, context);
  assert(anySecondBranch.reason === 'dueDate is overdue',
    'any reports the specific branch that matched, not the whole OR block', 'any reason should identify the firing branch', anySecondBranch);

  const allNode = { all: [{ field: 'priority', op: 'eq', value: 'high' }, { field: 'dueDate', op: 'overdue' }] };
  const allBoth = evaluateWithReason({ priority: 'high', dueDate: iso(-1) }, allNode, context);
  assert(allBoth.reason === 'priority = "high" AND dueDate is overdue',
    'all joins every child\'s reason (all of them necessarily matched)', 'all reason should join every child reason', allBoth);

  const notNode = { not: { field: 'dueDate', op: 'overdue' } };
  const notMatch = evaluateWithReason({ dueDate: iso(3) }, notNode, context);
  assert(notMatch.reason === 'NOT (dueDate is overdue)',
    'not describes the negated child structurally', 'not reason format wrong', notMatch);

  assert(describePredicate({}) === '(empty)', 'describePredicate renders an empty node as (empty)', 'describePredicate empty-node rendering wrong');
  assert(describePredicate({ field: 'priority', op: 'eq', value: 'high' }) === 'priority = "high"',
    'describePredicate renders a leaf the same way evaluateWithReason does', 'describePredicate leaf rendering wrong');

  section('classifyTaskWithReason');

  const legacyRules = { now: { overdue: true, priorities: ['high'] }, next: { future_due: true, priorities: ['normal'] }, later: {} };
  const overdueHigh  = { priority: 'high', dueDate: iso(-1), completed: false };
  const legacyResult = classifyTaskLegacyWithReason(overdueHigh, legacyRules);
  assert(legacyResult.bucket === 'now' && legacyResult.reason.includes('overdue') && legacyResult.reason.includes('priority "high"'),
    'legacy classifier reason mentions both overdue and the matching priority', 'legacy classifyTaskWithReason reason wrong', legacyResult);
  assert(classifyTaskLegacy(overdueHigh, legacyRules) === legacyResult.bucket,
    'classifyTaskLegacy (bare) still returns exactly classifyTaskLegacyWithReason(...).bucket', 'legacy bare/reason dispatch diverged');

  const v2Rules = { schemaVersion: 2, now: { any: [{ field: 'dueDate', op: 'overdue' }, { field: 'priority', op: 'eq', value: 'high' }] }, next: {}, later: {} };
  const v2Result = classifyTaskV2WithReason(overdueHigh, v2Rules);
  assert(v2Result.bucket === 'now' && v2Result.reason === 'dueDate is overdue',
    'v2 classifier reason identifies the specific matching branch', 'v2 classifyTaskWithReason reason wrong', v2Result);
  assert(classifyTaskV2(overdueHigh, v2Rules) === v2Result.bucket,
    'classifyTaskV2 (bare) still returns exactly classifyTaskV2WithReason(...).bucket', 'v2 bare/reason dispatch diverged');

  assert(classifyTaskWithReason(overdueHigh, v2Rules).bucket === classifyTask(overdueHigh, v2Rules),
    'classifyTaskWithReason dispatcher agrees with the bare classifyTask dispatcher', 'WithReason dispatcher diverged from bare dispatcher');

  const later = classifyTaskWithReason({ priority: 'low', dueDate: null, completed: false }, legacyRules);
  assert(later.bucket === 'later' && later.reason === 'no now/next rule matched',
    'the later fallback carries an explicit reason, not null', 'later-bucket reason should be an explicit fallthrough message', later);

  const completed = classifyTaskWithReason({ completed: true, priority: 'high', dueDate: iso(-1) }, legacyRules);
  assert(completed.bucket === null && completed.reason === null,
    'a completed task has both bucket and reason null', 'completed-task WithReason handling wrong', completed);
}

function run() {
  console.log('Predicate Engine Tests — hb-task-server-enterprise');
  console.log('═'.repeat(62));

  testOps();
  testComposition();
  testClassifyDispatch();
  testExplainability();

  console.log('\n' + '═'.repeat(62));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(62));

  process.exit(failed > 0 ? 1 : 0);
}

run();
