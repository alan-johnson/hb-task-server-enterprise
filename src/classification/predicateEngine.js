'use strict';

// Predicate tree evaluator for schemaVersion:2 classification rules (see
// docs/triage-engine-implementation-plan.md, Phase 1). Pure, synchronous,
// no I/O — every dependency (today's date) comes in through `context` so
// this is trivially unit-testable without mocking Date.
//
// Grammar:
//   { field, op, value? }        — a leaf predicate
//   { all: Predicate[] }         — AND
//   { any: Predicate[] }         — OR
//   { not: Predicate }           — NOT
//
// A node with none of field/all/any/not (e.g. `{}`) evaluates to false —
// vacuously true would silently make an "any" branch always match, which
// is the more dangerous failure mode of the two. Malformed trees (wrong
// types, unknown op) are rejected at save time by zod validation
// (src/task-server.js), not here — this function assumes it's being
// handed an already-validated tree and stays a pure boolean evaluator.

function parseDueDate(dueDateStr) {
  if (!dueDateStr) return null;
  const m = String(dueDateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(dueDateStr);
  if (isNaN(d)) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

function getFieldValue(task, field, context) {
  switch (field) {
    case 'dueDate':   return parseDueDate(task.dueDate);
    case 'priority':  return task.priority || 'low';
    case 'tags':      return Array.isArray(task.tags) ? task.tags : [];
    case 'listId':    return task.listId;
    case 'ageDays': {
      if (!task.updated) return null;
      const updated = new Date(task.updated);
      if (isNaN(updated)) return null;
      updated.setHours(0, 0, 0, 0);
      return daysBetween(context.today, updated);
    }
    default: return undefined;
  }
}

function evaluateLeaf(task, node, context) {
  const { field, op, value } = node;
  const fieldValue = getFieldValue(task, field, context);

  switch (op) {
    case 'eq':
      return fieldValue === value;

    // Direction-agnostic membership: works for "task's array field contains
    // this value" (e.g. tags) and for "this list of allowed values contains
    // the task's scalar field" (e.g. priority in ['high','normal']) without
    // needing two separate ops.
    case 'includes':
      if (Array.isArray(fieldValue)) return fieldValue.includes(value);
      if (Array.isArray(value)) return value.includes(fieldValue);
      return false;

    case 'gt':
      return fieldValue !== null && fieldValue !== undefined && Number(fieldValue) > Number(value);
    case 'lt':
      return fieldValue !== null && fieldValue !== undefined && Number(fieldValue) < Number(value);

    case 'overdue': {
      const due = getFieldValue(task, 'dueDate', context);
      return !!due && due <= context.today;
    }
    case 'future_due': {
      const due = getFieldValue(task, 'dueDate', context);
      return !!due && due > context.today;
    }
    // "Due within N days" includes anything already due (negative or zero
    // days-until) — the practically useful reading for urgency rules, not
    // a strict future-only window.
    case 'within_days': {
      const due = getFieldValue(task, 'dueDate', context);
      if (!due) return false;
      return daysBetween(due, context.today) <= Number(value);
    }

    default:
      return false;
  }
}

// Human-readable rendering of a leaf, independent of evaluation — used both
// for a matched leaf's own reason and to describe an unmatched child inside
// a "not" (where the reason is "NOT (<what the child would have meant>)",
// since a false child has no match of its own to describe).
function describeLeaf(node) {
  const { field, op, value } = node;
  switch (op) {
    case 'overdue':     return `${field} is overdue`;
    case 'future_due':  return `${field} is in the future`;
    case 'within_days': return `${field} is due within ${value} day(s)`;
    case 'eq':          return `${field} = ${JSON.stringify(value)}`;
    case 'includes':    return `${field} includes ${JSON.stringify(value)}`;
    case 'gt':           return `${field} > ${JSON.stringify(value)}`;
    case 'lt':           return `${field} < ${JSON.stringify(value)}`;
    default:             return `${field} ${op} ${JSON.stringify(value)}`;
  }
}

function describePredicate(node) {
  if (!node || typeof node !== 'object') return '(empty)';
  if (Array.isArray(node.all)) return node.all.map(describePredicate).join(' AND ');
  if (Array.isArray(node.any)) return `(${node.any.map(describePredicate).join(' OR ')})`;
  if (node.not) return `NOT (${describePredicate(node.not)})`;
  if (node.field) return describeLeaf(node);
  return '(empty)';
}

// Walks the tree once, returning both the boolean result and — only when
// matched — a human-readable reason. For "any", the reason is whichever
// child actually fired (not the whole OR-block), which is the genuinely
// useful part of explainability: not just "an any-block matched" but which
// alternative did. For "all", every child necessarily matched, so the
// reason is all of their reasons joined. Unmatched nodes carry no reason —
// there's nothing to explain about a rule that didn't fire.
function evaluateWithReason(task, node, context) {
  if (!node || typeof node !== 'object') return { matched: false, reason: null };

  if (Array.isArray(node.all)) {
    const results = node.all.map(child => evaluateWithReason(task, child, context));
    const matched = results.every(r => r.matched);
    return { matched, reason: matched ? results.map(r => r.reason).join(' AND ') : null };
  }
  if (Array.isArray(node.any)) {
    const firstMatch = node.any.map(child => evaluateWithReason(task, child, context)).find(r => r.matched);
    return { matched: !!firstMatch, reason: firstMatch ? firstMatch.reason : null };
  }
  if (node.not) {
    const child = evaluateWithReason(task, node.not, context);
    const matched = !child.matched;
    return { matched, reason: matched ? `NOT (${describePredicate(node.not)})` : null };
  }
  if (node.field) {
    const matched = evaluateLeaf(task, node, context);
    return { matched, reason: matched ? describeLeaf(node) : null };
  }

  return { matched: false, reason: null };
}

// Boolean-only entry point — kept as the primary API for callers (and tests)
// that only need the match result, delegating to evaluateWithReason so the
// two never drift apart into two slightly-different implementations of the
// same tree walk.
function evaluatePredicate(task, node, context) {
  return evaluateWithReason(task, node, context).matched;
}

module.exports = { evaluatePredicate, evaluateWithReason, describePredicate, parseDueDate };
