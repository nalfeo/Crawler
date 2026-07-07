import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLedger,
  validateLedgerText,
  requiredStagesForApples,
  isReviewLedgerPath,
  findReviewLedgerPaths,
  normalizeRepoPath,
  LEDGER_PATH_RE,
  SCHEMA_VERSION,
} from './ledger.mjs';

function cleanRound(extra = {}) {
  return { round: 1, models: ['m1'], concerns_count: 0, resolved_count: 0, clean: true, ...extra };
}
function mmRound(extra = {}) {
  return {
    round: 1,
    models: ['m1', 'm2'],
    concerns_count: 0,
    valid_count: 0,
    resolved_count: 0,
    clean: true,
    ...extra,
  };
}

// A non-clean code_review round with genuine unresolved concerns (for escalation fixtures).
function crUnresolvedRound(extra = {}) {
  return { round: 1, models: ['m1'], concerns_count: 3, resolved_count: 1, clean: false, ...extra };
}
// A non-clean multi_model round with unresolved valid concerns (for escalation fixtures).
function mmUnresolvedRound(extra = {}) {
  return {
    round: 1,
    models: ['m1', 'm2'],
    concerns_count: 3,
    valid_count: 2,
    resolved_count: 0,
    clean: false,
    ...extra,
  };
}

function tier4(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    date: '2026-06-29',
    session_slug: 'improve-local-harness',
    task_title: 'Improve local harness',
    estimated_apples: 4,
    stages: {
      plan_review: {
        completed: true,
        reviewer_model: 'gpt-5.4',
        concerns_count: 6,
        resolved_count: 6,
      },
      dual_plan_synthesis: {
        completed: true,
        plan_models: ['gpt-5.5', 'gemini-3.1-pro-preview'],
        judge_model: 'claude-opus-4.8',
      },
      code_review: { clean: true, rounds: [cleanRound({ concerns_count: 2, resolved_count: 2 })] },
      multi_model_review: {
        clean: true,
        adjudicator_model: 'gpt-5.4',
        rounds: [mmRound({ concerns_count: 3, valid_count: 2, resolved_count: 2 })],
      },
    },
    ...overrides,
  };
}

function tier1() {
  return {
    schema_version: SCHEMA_VERSION,
    date: '2026-06-29',
    session_slug: 'small-fix',
    task_title: 'Small fix',
    estimated_apples: 1,
    stages: {},
  };
}

function tier2() {
  return {
    schema_version: SCHEMA_VERSION,
    date: '2026-06-29',
    session_slug: 'small-change',
    task_title: 'Small change',
    estimated_apples: 2,
    stages: {
      plan_review: {
        completed: true,
        reviewer_model: 'gpt-5.4',
        concerns_count: 1,
        resolved_count: 1,
      },
    },
  };
}

test('requiredStagesForApples maps tiers correctly', () => {
  assert.deepEqual(requiredStagesForApples(1), []);
  assert.deepEqual(requiredStagesForApples(2), []);
  assert.deepEqual(requiredStagesForApples(3), ['plan_review', 'code_review']);
  assert.deepEqual(requiredStagesForApples(4), [
    'plan_review',
    'dual_plan_synthesis',
    'code_review',
    'multi_model_review',
  ]);
  assert.deepEqual(requiredStagesForApples(5), [
    'plan_review',
    'dual_plan_synthesis',
    'code_review',
    'multi_model_review',
  ]);
});

test('a complete tier-4 ledger is valid', () => {
  const r = validateLedger(tier4());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.estimatedApples, 4);
});

test('a tier-1 ledger requires no stages (empty stages object is valid)', () => {
  const r = validateLedger(tier1());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.requiredStages, []);
});

test('a tier-2 ledger requires no stages (plan-review floor raised to 3🍎)', () => {
  const led = tier2();
  led.stages = {};
  const r = validateLedger(led);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.requiredStages, []);
});

test('a tier-2 ledger may still carry a valid (non-required) plan_review stage', () => {
  const r = validateLedger(tier2());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.requiredStages, []);
});

test('code_review becomes required at 3🍎 (was not required at 2🍎)', () => {
  const led = tier2();
  led.estimated_apples = 3;
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /code_review.*missing/);
});

test('rejects wrong schema_version', () => {
  const r = validateLedger(tier4({ schema_version: 'nope/v9' }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /schema_version/);
});

test('rejects estimated_apples out of range', () => {
  for (const bad of [0, 6, -1]) {
    const r = validateLedger(tier4({ estimated_apples: bad }));
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /estimated_apples/);
  }
});

test('rejects non-integer estimated_apples', () => {
  const r = validateLedger(tier4({ estimated_apples: 4.5 }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /estimated_apples/);
});

test('rejects bad date and slug', () => {
  assert.equal(validateLedger(tier4({ date: '6/29/26' })).ok, false);
  assert.equal(validateLedger(tier4({ session_slug: 'Not Kebab' })).ok, false);
});

test('tier-4 missing a required stage fails', () => {
  const led = tier4();
  delete led.stages.multi_model_review;
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /multi_model_review.*missing/);
});

test('plan_review requires resolved >= concerns', () => {
  const led = tier4();
  led.stages.plan_review.resolved_count = 5;
  led.stages.plan_review.concerns_count = 6;
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /resolved_count.*concerns_count/);
});

test('plan_review requires reviewer_model', () => {
  const led = tier4();
  led.stages.plan_review.reviewer_model = '';
  assert.equal(validateLedger(led).ok, false);
});

test('dual_plan_synthesis requires 2 distinct plan models', () => {
  const led = tier4();
  led.stages.dual_plan_synthesis.plan_models = ['gpt-5.5', 'gpt-5.5'];
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /DISTINCT/);
});

test('dual_plan_synthesis judge must differ from plan models', () => {
  const led = tier4();
  led.stages.dual_plan_synthesis.judge_model = 'gpt-5.5';
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /judge_model.*differ/);
});

test('dual_plan_synthesis rejects !=2 plan models', () => {
  const led = tier4();
  led.stages.dual_plan_synthesis.plan_models = ['only-one'];
  assert.equal(validateLedger(led).ok, false);
});

test('code_review last round must be clean', () => {
  const led = tier4();
  led.stages.code_review.rounds = [cleanRound({ clean: false })];
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /last round\.clean/);
});

test('code_review requires non-empty rounds', () => {
  const led = tier4();
  led.stages.code_review.rounds = [];
  assert.equal(validateLedger(led).ok, false);
});

test('code_review last round needs >=1 model', () => {
  const led = tier4();
  led.stages.code_review.rounds = [cleanRound({ models: [] })];
  assert.equal(validateLedger(led).ok, false);
});

test('multi_model_review last round needs >=2 distinct models', () => {
  const led = tier4();
  led.stages.multi_model_review.rounds = [mmRound({ models: ['only'] })];
  assert.equal(validateLedger(led).ok, false);

  const led2 = tier4();
  led2.stages.multi_model_review.rounds = [mmRound({ models: ['dup', 'dup'] })];
  assert.equal(validateLedger(led2).ok, false);
});

test('multi_model_review requires adjudicator_model', () => {
  const led = tier4();
  led.stages.multi_model_review.adjudicator_model = '';
  assert.equal(validateLedger(led).ok, false);
});

test('multi_model_review valid_count must be <= concerns_count', () => {
  const led = tier4();
  led.stages.multi_model_review.rounds = [
    mmRound({ concerns_count: 1, valid_count: 2, resolved_count: 2 }),
  ];
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /valid_count.*<=.*concerns_count/);
});

test('multi_model_review resolved_count must be >= valid_count', () => {
  const led = tier4();
  led.stages.multi_model_review.rounds = [
    mmRound({ concerns_count: 3, valid_count: 3, resolved_count: 1 }),
  ];
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /resolved_count.*valid_count/);
});

// --- #2a: escalated_to_human terminal state (bounded loop -> human) ---

test('code_review accepts escalated_to_human after >= 2 rounds (clean:false)', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: {
      after_round: 2,
      reason: 'Intractable architecture conflict; needs a human call.',
      unresolved_concerns: 2,
    },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('multi_model_review accepts escalated_to_human after >= 2 rounds', () => {
  const led = tier4();
  led.stages.multi_model_review = {
    clean: false,
    adjudicator_model: 'gpt-5.4',
    rounds: [mmUnresolvedRound({ round: 1 }), mmUnresolvedRound({ round: 2 })],
    escalated_to_human: {
      after_round: 2,
      reason: 'Models disagree on a security trade-off.',
      unresolved_concerns: 1,
    },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('escalation on round 1 is rejected (never escalate before 2 rounds)', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 })],
    escalated_to_human: { after_round: 1, reason: 'giving up early', unresolved_concerns: 1 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /at least 2 attempted review rounds/);
});

test('escalation with clean:true is rejected (contradiction)', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: true,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: { after_round: 2, reason: 'contradictory', unresolved_concerns: 1 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /incompatible with clean:true/);
});

test('escalation after_round must equal the final round index (no rounds after escalation)', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: { after_round: 3, reason: 'off-by-one terminal', unresolved_concerns: 1 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /after_round.*must equal the final round index/);
});

test('escalation with a clean final round is rejected', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2, clean: true })],
    escalated_to_human: { after_round: 2, reason: 'final round was clean', unresolved_concerns: 1 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /final round\.clean must not be true/);
});

test('escalation requires genuine unresolved concerns in the final round', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [
      crUnresolvedRound({ round: 1 }),
      crUnresolvedRound({ round: 2, concerns_count: 2, resolved_count: 2 }),
    ],
    escalated_to_human: {
      after_round: 2,
      reason: 'but everything resolved',
      unresolved_concerns: 1,
    },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /resolved_count < concerns_count/);
});

test('escalation requires a non-empty reason and unresolved_concerns >= 1', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: { after_round: 2, reason: '', unresolved_concerns: 0 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /reason must be a non-empty string/);
  assert.match(r.errors.join('\n'), /unresolved_concerns must be an integer >= 1/);
});

test('a malformed escalated_to_human cannot silently fall back to the clean path', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: null,
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /escalated_to_human must be an object/);
});

test('an empty escalated_to_human object is rejected on every required field (no silent pass)', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: {},
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  const joined = r.errors.join('\n');
  assert.match(joined, /after_round .* must equal the final round index/);
  assert.match(joined, /reason must be a non-empty string/);
  assert.match(joined, /unresolved_concerns must be an integer >= 1/);
});

test('a wrong-typed after_round (string) is rejected (not silently coerced)', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1 }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: { after_round: '2', reason: 'valid escalation', unresolved_concerns: 2 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /after_round .* must equal the final round index/);
});

test('escalation validates EVERY round shape (intermediate round missing models fails)', () => {
  const led = tier4();
  led.stages.code_review = {
    clean: false,
    rounds: [crUnresolvedRound({ round: 1, models: [] }), crUnresolvedRound({ round: 2 })],
    escalated_to_human: { after_round: 2, reason: 'valid escalation', unresolved_concerns: 2 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /round\[0\]\.models/);
});

test('multi_model escalation enforces distinct models per round', () => {
  const led = tier4();
  led.stages.multi_model_review = {
    clean: false,
    adjudicator_model: 'gpt-5.4',
    rounds: [
      mmUnresolvedRound({ round: 1, models: ['dup', 'dup'] }),
      mmUnresolvedRound({ round: 2 }),
    ],
    escalated_to_human: { after_round: 2, reason: 'valid escalation', unresolved_concerns: 1 },
  };
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /round\[0\]\.models must be DISTINCT/);
});

// --- #2b: downward-only, diff-justified apple re-scoring ---

test('downward apples_rescored_from is accepted with a reason', () => {
  const led = tier4();
  led.apples_rescored_from = 5;
  led.rescore_reason = 'Diff turned out smaller than the initial 5🍎 estimate.';
  const r = validateLedger(led);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('upward apples_rescored_from is rejected (re-scoring is downward-only)', () => {
  const led = tier4();
  led.apples_rescored_from = 3;
  led.rescore_reason = 'trying to sneak upward';
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /must be strictly greater than estimated_apples/);
});

test('no-op apples_rescored_from (equal to estimate) is rejected', () => {
  const led = tier4();
  led.apples_rescored_from = 4;
  led.rescore_reason = 'no actual change';
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /must be strictly greater than estimated_apples/);
});

test('apples_rescored_from without a rescore_reason is rejected', () => {
  const led = tier4();
  led.apples_rescored_from = 5;
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /rescore_reason must be a non-empty string/);
});

test('apples_rescored_from must be an integer 1..5', () => {
  const led = tier4();
  led.apples_rescored_from = 7;
  led.rescore_reason = 'bad value';
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /apples_rescored_from must be an integer 1\.\.5/);
});

test('orphaned rescore_reason (no apples_rescored_from) is rejected', () => {
  const led = tier4();
  led.rescore_reason = 'left behind after an edit';
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /rescore_reason is only valid alongside apples_rescored_from/);
});

test('a downward re-score to 2🍎 still validates its remaining COMPLETE stages; incomplete scaffolds must be pruned', () => {
  // Scaffolded at 4🍎, rescored down to 2🍎, but a stale INCOMPLETE code_review
  // scaffold was left present -> present stages are always validated -> fails.
  const stale = tier4();
  stale.estimated_apples = 2;
  stale.apples_rescored_from = 4;
  stale.rescore_reason = 'Diff was a one-line tweak; genuinely a 2🍎 change.';
  stale.stages.code_review = { clean: false, rounds: [] };
  const rStale = validateLedger(stale);
  assert.equal(rStale.ok, false, 'stale incomplete scaffold should fail');
  assert.deepEqual(rStale.requiredStages, []);

  // Prune the now-unrequired incomplete stages -> downward re-score validates.
  const pruned = tier4();
  pruned.estimated_apples = 2;
  pruned.apples_rescored_from = 4;
  pruned.rescore_reason = 'Diff was a one-line tweak; genuinely a 2🍎 change.';
  pruned.stages = {};
  const rPruned = validateLedger(pruned);
  assert.equal(rPruned.ok, true, rPruned.errors.join('; '));
  assert.deepEqual(rPruned.requiredStages, []);
});

test('non-object ledger is rejected', () => {
  assert.equal(validateLedger(null).ok, false);
  assert.equal(validateLedger([]).ok, false);
  assert.equal(validateLedger('x').ok, false);
});

test('validateLedgerText surfaces JSON parse errors', () => {
  const r = validateLedgerText('{ not json');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /invalid JSON/);
});

test('validateLedgerText accepts a serialized valid ledger', () => {
  const r = validateLedgerText(JSON.stringify(tier4()));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('LEDGER_PATH_RE and isReviewLedgerPath', () => {
  assert.equal(
    isReviewLedgerPath('docs/knowledge/review-ledgers/2026-06-29-my-change.review-ledger.json'),
    true,
  );
  assert.equal(
    isReviewLedgerPath('docs\\knowledge\\review-ledgers\\2026-06-29-my-change.review-ledger.json'),
    true,
  );
  assert.equal(isReviewLedgerPath('docs/knowledge/review-ledgers/my-change.json'), false);
  assert.equal(isReviewLedgerPath('docs/knowledge/handoffs/2026-06-29-x.md'), false);
  assert.equal(
    LEDGER_PATH_RE.test('docs/knowledge/review-ledgers/2026-06-29-x.review-ledger.json'),
    true,
  );
});

test('findReviewLedgerPaths filters a changed-file list', () => {
  const files = [
    'src/game/foo.ts',
    'docs/knowledge/review-ledgers/2026-06-29-a.review-ledger.json',
    'docs/knowledge/review-ledgers/2026-06-29-b.review-ledger.json',
    'package.json',
  ];
  assert.deepEqual(findReviewLedgerPaths(files), [
    'docs/knowledge/review-ledgers/2026-06-29-a.review-ledger.json',
    'docs/knowledge/review-ledgers/2026-06-29-b.review-ledger.json',
  ]);
  assert.deepEqual(findReviewLedgerPaths(null), []);
});

test('normalizeRepoPath strips ./ and backslashes', () => {
  assert.equal(normalizeRepoPath('./a\\b'), 'a/b');
});
