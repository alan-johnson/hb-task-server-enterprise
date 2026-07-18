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

function evaluatePredicate(task, node, context) {
  if (!node || typeof node !== 'object') return false;

  if (Array.isArray(node.all)) return node.all.every(child => evaluatePredicate(task, child, context));
  if (Array.isArray(node.any)) return node.any.some(child => evaluatePredicate(task, child, context));
  if (node.not) return !evaluatePredicate(task, node.not, context);
  if (node.field) return evaluateLeaf(task, node, context);

  return false;
}

module.exports = { evaluatePredicate, parseDueDate };
