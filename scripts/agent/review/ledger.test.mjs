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
  GRADE_CRITERIA,
  priorReviewModels,
} from './ledger.mjs';

// A valid independent_grade stage: a grader model that appears in NO other
// stage, a graded sha, and every criterion scored 1..5.
function validGrade(extra = {}) {
  const criteria = {};
  for (const c of GRADE_CRITERIA) criteria[c] = 4;
  return {
    completed: true,
    grader_model: 'independent-grader-model',
    head_sha: 'a'.repeat(40),
    criteria,
    verdict: 'pass',
    findings_count: 0,
    ...extra,
  };
}

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
        adversarial: true,
        alternatives_considered: 2,
        plan_divergence: 'convergent',
      },
      code_review: { clean: true, rounds: [cleanRound({ concerns_count: 2, resolved_count: 2 })] },
      multi_model_review: {
        clean: true,
        adjudicator_model: 'gpt-5.4',
        rounds: [mmRound({ concerns_count: 3, valid_count: 2, resolved_count: 2 })],
      },
      independent_grade: validGrade(),
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

// A valid LEGACY dual_plan_synthesis stage (ADR 0051): no longer required at any
// tier, but still ACCEPTED when present so historical ledgers that recorded it
// remain parseable + validated.
function legacyDualPlanSynthesis(extra = {}) {
  return {
    completed: true,
    plan_models: ['gpt-5.5', 'gemini-3.1-pro-preview'],
    judge_model: 'claude-opus-4.8',
    ...extra,
  };
}

// A canonical valid 3🍎 ledger (plan_review + code_review). plan_divergence is
// REQUIRED at 3🍎; adversarial/alternatives_considered are NOT.
function tier3(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    date: '2026-07-08',
    session_slug: 'three-apple',
    task_title: 'Three apple change',
    estimated_apples: 3,
    stages: {
      plan_review: {
        completed: true,
        reviewer_model: 'gpt-5.4',
        concerns_count: 1,
        resolved_count: 1,
        plan_divergence: 'minor',
      },
      code_review: { clean: true, rounds: [cleanRound({ concerns_count: 1, resolved_count: 1 })] },
      independent_grade: validGrade(),
    },
    ...overrides,
  };
}

test('requiredStagesForApples maps tiers correctly', () => {
  assert.deepEqual(requiredStagesForApples(1), []);
  assert.deepEqual(requiredStagesForApples(2), []);
  assert.deepEqual(requiredStagesForApples(3), ['plan_review', 'code_review', 'independent_grade']);
  assert.deepEqual(requiredStagesForApples(4), [
    'plan_review',
    'code_review',
    'multi_model_review',
    'independent_grade',
  ]);
  assert.deepEqual(requiredStagesForApples(5), [
    'plan_review',
    'code_review',
    'multi_model_review',
    'independent_grade',
  ]);
});

test('independent_grade is required only on schema v2 (historical v1 ledgers stay valid)', () => {
  for (const apples of [3, 4, 5]) {
    assert.equal(
      requiredStagesForApples(apples, 'review-ledger/v1').includes('independent_grade'),
      false,
      `v1 ${apples}🍎 must not require independent_grade`,
    );
    assert.equal(
      requiredStagesForApples(apples, 'review-ledger/v2').includes('independent_grade'),
      true,
    );
  }
  // 1-2🍎 never requires it, on any schema version.
  assert.deepEqual(requiredStagesForApples(2, 'review-ledger/v2'), []);
});

test('a v1 3🍎 ledger without independent_grade is still valid', () => {
  const led = tier3();
  led.schema_version = 'review-ledger/v1';
  delete led.stages.independent_grade;
  const r = validateLedger(led);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.requiredStages, ['plan_review', 'code_review']);
});

test('a v2 3🍎 ledger WITHOUT independent_grade is rejected', () => {
  const led = tier3();
  delete led.stages.independent_grade;
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /required stage 'independent_grade' is missing/);
});

test('an unknown schema_version is rejected and names the supported set', () => {
  const r = validateLedger(tier3({ schema_version: 'review-ledger/v9' }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /schema_version must be one of/);
});

// ---------------------------------------------------------------------------
// independent_grade (schema v2)
// ---------------------------------------------------------------------------

test('independent_grade requires a grader model that reviewed nothing else', () => {
  // 'gpt-5.4' is tier3's plan reviewer -> must not be the grader.
  const r = validateLedger(
    tier3({
      stages: {
        ...tier3().stages,
        independent_grade: validGrade({ grader_model: 'gpt-5.4' }),
      },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /must be INDEPENDENT/);
});

test('priorReviewModels collects every model from the other stages', () => {
  const models = priorReviewModels(tier4().stages);
  assert.ok(models.includes('gpt-5.4'), 'plan reviewer + adjudicator');
  assert.ok(models.includes('m1'), 'code_review round model');
  assert.ok(models.includes('m2'), 'multi_model_review round model');
  assert.equal(new Set(models).size, models.length, 'deduplicated');
});

test('independent_grade requires every criterion scored 1..5 and rejects unknown criteria', () => {
  const bad = validGrade();
  bad.criteria = { ...bad.criteria, correctness: 0, bogus_criterion: 3 };
  const r = validateLedger(tier3({ stages: { ...tier3().stages, independent_grade: bad } }));
  assert.equal(r.ok, false);
  const msg = r.errors.join('; ');
  assert.match(msg, /criteria\.correctness must be an integer 1\.\.5/);
  assert.match(msg, /unknown criteria: bogus_criterion/);
});

test('independent_grade requires head_sha so a grade cannot be carried across a rewrite', () => {
  const r = validateLedger(
    tier3({
      stages: { ...tier3().stages, independent_grade: validGrade({ head_sha: '' }) },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /head_sha must be the non-empty git sha/);
});

test("independent_grade verdict 'fail' requires an escalated_to_human record", () => {
  const r = validateLedger(
    tier3({
      stages: { ...tier3().stages, independent_grade: validGrade({ verdict: 'fail' }) },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /requires an escalated_to_human record/);
});

test("independent_grade verdict 'fail' WITH a valid escalation is accepted", () => {
  const r = validateLedger(
    tier3({
      stages: {
        ...tier3().stages,
        independent_grade: validGrade({
          verdict: 'fail',
          findings_count: 2,
          escalated_to_human: { reason: '1 blocker finding', unresolved_findings: 1 },
        }),
      },
    }),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('independent_grade rejects escalated_to_human alongside a passing verdict', () => {
  const r = validateLedger(
    tier3({
      stages: {
        ...tier3().stages,
        independent_grade: validGrade({
          escalated_to_human: { reason: 'x', unresolved_findings: 1 },
        }),
      },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /only valid alongside verdict 'fail'/);
});

test('independent_grade rejects an invalid verdict value', () => {
  const r = validateLedger(
    tier3({
      stages: { ...tier3().stages, independent_grade: validGrade({ verdict: 'maybe' }) },
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /verdict must be one of: pass, fail/);
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

test('dual_plan_synthesis (legacy-optional) requires 2 distinct plan models when present', () => {
  const led = tier4();
  led.stages.dual_plan_synthesis = legacyDualPlanSynthesis({ plan_models: ['gpt-5.5', 'gpt-5.5'] });
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /DISTINCT/);
});

test('dual_plan_synthesis (legacy-optional) judge must differ from plan models', () => {
  const led = tier4();
  led.stages.dual_plan_synthesis = legacyDualPlanSynthesis({ judge_model: 'gpt-5.5' });
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /judge_model.*differ/);
});

test('dual_plan_synthesis (legacy-optional) rejects !=2 plan models', () => {
  const led = tier4();
  led.stages.dual_plan_synthesis = legacyDualPlanSynthesis({ plan_models: ['only-one'] });
  assert.equal(validateLedger(led).ok, false);
});

// --- ADR 0051: adversarial plan review + plan_divergence instrumentation ---

test('4🍎 no longer requires dual_plan_synthesis (adversarial plan_review replaces it)', () => {
  const led = tier4(); // canonical fixture omits dual_plan_synthesis
  assert.equal('dual_plan_synthesis' in led.stages, false);
  const r = validateLedger(led);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.requiredStages, [
    'plan_review',
    'code_review',
    'multi_model_review',
    'independent_grade',
  ]);
});

test('4🍎 may still carry a valid legacy dual_plan_synthesis stage (validated-if-present)', () => {
  const led = tier4();
  led.stages.dual_plan_synthesis = legacyDualPlanSynthesis();
  const r = validateLedger(led);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('4🍎 requires plan_review.adversarial === true', () => {
  const missing = tier4();
  delete missing.stages.plan_review.adversarial;
  const rMissing = validateLedger(missing);
  assert.equal(rMissing.ok, false);
  assert.match(rMissing.errors.join('\n'), /adversarial must be true/);

  const falseAdv = tier4();
  falseAdv.stages.plan_review.adversarial = false;
  assert.equal(validateLedger(falseAdv).ok, false);
});

test('4🍎 requires plan_review.alternatives_considered integer >= 2', () => {
  const one = tier4();
  one.stages.plan_review.alternatives_considered = 1;
  const rOne = validateLedger(one);
  assert.equal(rOne.ok, false);
  assert.match(rOne.errors.join('\n'), /alternatives_considered must be an integer >= 2/);

  const missing = tier4();
  delete missing.stages.plan_review.alternatives_considered;
  assert.equal(validateLedger(missing).ok, false);
});

test('plan_divergence is required at 4🍎 and must be a valid enum', () => {
  const missing = tier4();
  delete missing.stages.plan_review.plan_divergence;
  const rMissing = validateLedger(missing);
  assert.equal(rMissing.ok, false);
  assert.match(rMissing.errors.join('\n'), /plan_divergence must be one of/);

  const bad = tier4();
  bad.stages.plan_review.plan_divergence = 'huge';
  assert.equal(validateLedger(bad).ok, false);

  for (const v of ['convergent', 'minor', 'major_fork']) {
    const good = tier4();
    good.stages.plan_review.plan_divergence = v;
    assert.equal(validateLedger(good).ok, true, `${v} should be accepted`);
  }
});

test('plan_divergence is required at 3🍎, but adversarial/alternatives are NOT', () => {
  const led = tier3();
  assert.equal(validateLedger(led).ok, true, validateLedger(led).errors.join('; '));

  const missing = tier3();
  delete missing.stages.plan_review.plan_divergence;
  const r = validateLedger(missing);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /plan_divergence must be one of/);
});

test('a 3🍎 plan_review MAY carry adversarial fields (validated-if-present)', () => {
  const led = tier3();
  led.stages.plan_review.adversarial = true;
  led.stages.plan_review.alternatives_considered = 3;
  assert.equal(validateLedger(led).ok, true, validateLedger(led).errors.join('; '));

  const badAdv = tier3();
  badAdv.stages.plan_review.adversarial = 'yes';
  assert.equal(validateLedger(badAdv).ok, false);

  const badAlt = tier3();
  badAlt.stages.plan_review.alternatives_considered = -1;
  assert.equal(validateLedger(badAlt).ok, false);
});

test('a voluntary sub-3🍎 plan_review does NOT require plan_divergence, but validates it if present', () => {
  // tier2() carries a plan_review with no plan_divergence -> still valid.
  assert.equal(validateLedger(tier2()).ok, true, validateLedger(tier2()).errors.join('; '));

  const bad = tier2();
  bad.stages.plan_review.plan_divergence = 'nope';
  const r = validateLedger(bad);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /plan_divergence must be one of/);
});

test('an invalid estimated_apples does not crash tier-conditional plan_review checks', () => {
  // tier=null guard: an out-of-range estimate errors at the top level and the
  // plan_review tier-conditional REQUIRES are skipped (no throw).
  const led = tier4({ estimated_apples: 9 });
  const r = validateLedger(led);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /estimated_apples/);
});

test('historical-style 4🍎 plan_review lacking the ADR-0051 fields fails explicit re-validation (by design)', () => {
  // ADR 0051 backward-compat: the ~17 pre-0051 4🍎 ledgers are NEVER
  // re-validated by any production path — the guard checks only branch-ADDED
  // ledgers (pr-review-ledger.mjs) and `validate` checks only the newest/given
  // path. So a pre-0051 ledger that lacks adversarial/alternatives_considered/
  // plan_divergence is harmless on main. If one IS explicitly re-validated by
  // hand it is rejected under the new rules — and that is the intended, SAFE
  // behavior: the presence of a legacy dual_plan_synthesis stage must NOT
  // exempt a ledger from the new HARD requirements (that exemption is the
  // rule-#12 bypass ADR 0051 explicitly rejects; validation keys ONLY on
  // estimated_apples, never on which stages happen to be present).
  const historical = {
    schema_version: SCHEMA_VERSION,
    date: '2026-06-01',
    session_slug: 'pre-adr-0051-change',
    task_title: 'A pre-ADR-0051 4-apple change',
    estimated_apples: 4,
    stages: {
      plan_review: {
        completed: true,
        reviewer_model: 'gpt-5.4',
        concerns_count: 6,
        resolved_count: 6,
      },
      dual_plan_synthesis: legacyDualPlanSynthesis(),
      code_review: { clean: true, rounds: [cleanRound()] },
      multi_model_review: {
        clean: true,
        adjudicator_model: 'gpt-5.4',
        rounds: [mmRound()],
      },
    },
  };
  const r = validateLedger(historical);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /adversarial must be true/);
  assert.match(r.errors.join('\n'), /plan_divergence must be one of/);
});

test('a dual_plan_synthesis stage does NOT exempt a new 4🍎 ledger from the adversarial requirement (no rule-#12 bypass)', () => {
  // Regression for the footgun ADR 0051 rejects (Alternative 3 / "no
  // schema_version v2 axis"): bolting a legacy dual block onto a NEW 4🍎 ledger
  // must NOT let its author skip the adversarial red-team + plan_divergence
  // instrumentation. Validation is a pure function of estimated_apples.
  const led = tier4({ date: '2026-07-08', session_slug: 'new-era-with-dual-block' });
  led.stages.dual_plan_synthesis = legacyDualPlanSynthesis();
  led.stages.plan_review.adversarial = false;
  delete led.stages.plan_review.alternatives_considered;
  delete led.stages.plan_review.plan_divergence;
  const r = validateLedger(led);
  assert.equal(r.ok, false, 'a dual block must not waive the adversarial requirement');
  assert.match(r.errors.join('\n'), /adversarial must be true/);
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
