'use strict';

const { z } = require('zod');

// Recursive predicate-tree schema, mirroring src/classification/predicateEngine.js's
// grammar exactly. An empty object ({}) is accepted (the conventional "later"
// catch-all bucket, which the classifier never evaluates as a predicate).
const LeafPredicate = z.object({
  field: z.string(),
  op: z.enum(['eq', 'includes', 'gt', 'lt', 'overdue', 'future_due', 'within_days']),
  value: z.any().optional()
});

const Predicate = z.lazy(() => z.union([
  LeafPredicate,
  z.object({ all: z.array(Predicate) }),
  z.object({ any: z.array(Predicate) }),
  z.object({ not: Predicate }),
  z.object({}).strict()
]));

const RulesV2 = z.object({
  schemaVersion: z.literal(2),
  now: Predicate,
  next: Predicate,
  later: Predicate.optional().default({})
});

// Legacy shape (no schemaVersion, or schemaVersion:1) — real accounts already
// have rules saved like this; .passthrough() so old clients that send an
// extra field (e.g. a stray `label`) don't get newly rejected. But reject
// the specific case of a predicate-shaped key (field/op/all/any/not)
// showing up in a legacy bucket without schemaVersion:2 — passthrough would
// otherwise silently accept a caller's v2 predicate tree as "harmless extra
// fields on an empty legacy bucket" if they forgot the version flag, which
// then classifies as a silently-inert no-op rule instead of a clear error.
const RESERVED_V2_KEYS = ['field', 'op', 'all', 'any', 'not'];
const LegacyBucket = z.object({
  label:       z.string().optional(),
  overdue:     z.boolean().optional(),
  future_due:  z.boolean().optional(),
  priorities:  z.array(z.string()).optional()
}).passthrough().refine(
  bucket => !RESERVED_V2_KEYS.some(k => k in bucket),
  { message: 'This looks like a schemaVersion:2 predicate node — add "schemaVersion": 2 at the top level to use predicate-tree rules' }
);

const RulesLegacy = z.object({
  schemaVersion: z.literal(1).optional(),
  now:   LegacyBucket,
  next:  LegacyBucket,
  later: LegacyBucket
});

// Dispatches on schemaVersion rather than a loose z.union() of the two
// shapes — LegacyBucket's .passthrough() would otherwise happily accept a
// v2 predicate tree's {any:[...]} as "extra fields on an empty legacy
// bucket," silently misclassifying which schema actually validated it.
function validateRules(body) {
  if (body && body.schemaVersion === 2) return RulesV2.safeParse(body);
  return RulesLegacy.safeParse(body);
}

module.exports = { validateRules, RulesV2, RulesLegacy, Predicate };
