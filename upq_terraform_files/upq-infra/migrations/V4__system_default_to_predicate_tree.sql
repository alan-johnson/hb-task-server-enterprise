-- Flyway migration. Filename convention: V<version>__<description.sql>
-- Versions run in order, exactly once, tracked in the flyway_schema_history table.
--
-- Promotes the system-wide default classification ruleset (the 'global' row
-- seeded by V3, see docs/triage-engine-implementation-plan.md Phase 0) from
-- the legacy two-boolean shape to the Phase 1 schemaVersion:2 predicate
-- tree, now that Phase 1 has shipped (predicateEngine.js, classify.js,
-- rulesSchema.js — see test/test-predicate-engine.js) and there is no real
-- customer whose account depends on the legacy shape specifically for the
-- SYSTEM default (early beta: see docs/triage-engine-implementation-plan.md
-- Phase 3 scoping note, 5 total accounts at time of writing).
--
-- Behaviorally identical to the previous default — same two conditions,
-- just expressed as a predicate tree instead of {overdue,priorities}:
--   now   = overdue OR priority = high
--   next  = future-due OR priority = normal   (only checked if not `now`)
--   later = everything else
--
-- This does NOT touch any per-user custom rules (users.classification_rules)
-- — those are untouched, and the dispatcher (classify.js) already handles
-- legacy-shaped per-user rows exactly as it did before this migration. This
-- migration only changes what an account with NO custom rules of its own
-- receives as its default. The in-code last-resort fallback
-- (DEFAULT_CLASSIFICATION in src/task-server.js, used only if this table is
-- unreachable/empty) is deliberately left in the legacy shape — it's meant
-- to be the simplest possible dependency-free safety net, independent of
-- the predicate engine.

UPDATE system_classification_defaults
SET rules = JSON_OBJECT(
        'schemaVersion', 2,
        'now', JSON_OBJECT('any', JSON_ARRAY(
                   JSON_OBJECT('field', 'dueDate', 'op', 'overdue'),
                   JSON_OBJECT('field', 'priority', 'op', 'eq', 'value', 'high')
               )),
        'next', JSON_OBJECT('any', JSON_ARRAY(
                   JSON_OBJECT('field', 'dueDate', 'op', 'future_due'),
                   JSON_OBJECT('field', 'priority', 'op', 'eq', 'value', 'normal')
               )),
        'later', JSON_OBJECT()
    ),
    updated_by = 'migration:V4'
WHERE id = 'global';
