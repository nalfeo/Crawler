import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AmbiguousRulesetNameError,
  GITHUB_ACTIONS_APP_ID,
  PROTECTED_REF,
  RULESET_NAME,
  UnknownClassicStatusChecksShapeError,
  UnsupportedClassicProtectionError,
  assertKnownClassicStatusChecksShape,
  assertSupportedClassicProtection,
  buildClassicProtectionPayload,
  buildRulesetDisablePayload,
  buildRulesetPayload,
  classicProtectionMissing,
  classicStatusChecksDisabled,
  classicStatusChecksRestored,
  findRulesetByName,
  inferTrainAppId,
  legacyRequiredStatusChecks,
  rulesetDisabled,
  rulesetProblems,
} from './protection-lib.mjs';

const TRAIN_APP_ID = 4106541;

// The exact live classic protection shape for nalfeo/Crawler at the time of
// the GH006 incident (captured via `gh api repos/nalfeo/Crawler/branches/main/protection`):
// ci-only, strict, conversation resolution required, force pushes/deletions disabled.
const LIVE_CLASSIC_PROTECTION = {
  required_status_checks: {
    strict: true,
    contexts: ['ci'],
    checks: [{ context: 'ci', app_id: 15368 }],
  },
  required_signatures: { enabled: false },
  enforce_admins: { enabled: false },
  required_linear_history: { enabled: false },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: false },
  required_conversation_resolution: { enabled: true },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
};

function liveRuleset(overrides = {}) {
  return {
    id: 99,
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [PROTECTED_REF], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: 'ci', integration_id: GITHUB_ACTIONS_APP_ID },
            { context: 'merge-train', integration_id: TRAIN_APP_ID },
          ],
        },
      },
    ],
    bypass_actors: [{ actor_id: TRAIN_APP_ID, actor_type: 'Integration', bypass_mode: 'always' }],
    ...overrides,
  };
}

test('buildClassicProtectionPayload disables required_status_checks while preserving every other live setting', () => {
  const payload = buildClassicProtectionPayload(LIVE_CLASSIC_PROTECTION, {
    requiredStatusChecks: null,
  });
  assert.equal(payload.required_status_checks, null);
  assert.equal(payload.enforce_admins, false);
  assert.equal(payload.required_pull_request_reviews, null);
  assert.equal(payload.restrictions, null);
  assert.equal(payload.required_linear_history, false);
  assert.equal(payload.allow_force_pushes, false);
  assert.equal(payload.allow_deletions, false);
  assert.equal(payload.required_conversation_resolution, true);
  assert.equal(payload.block_creations, false);
  assert.equal(payload.lock_branch, false);
  assert.equal(payload.allow_fork_syncing, false);
});

test('buildClassicProtectionPayload can restore the exact legacy ci-only shape', () => {
  const disabled = { ...LIVE_CLASSIC_PROTECTION, required_status_checks: null };
  const payload = buildClassicProtectionPayload(disabled, {
    requiredStatusChecks: legacyRequiredStatusChecks(),
  });
  assert.deepEqual(payload.required_status_checks, {
    strict: true,
    checks: [{ context: 'ci', app_id: 15368 }],
  });
  // Other settings remain preserved through the round trip.
  assert.equal(payload.required_conversation_resolution, true);
  assert.equal(payload.allow_force_pushes, false);
});

test('assertSupportedClassicProtection fails closed on unmodeled settings instead of silently dropping them', () => {
  assert.doesNotThrow(() => assertSupportedClassicProtection(LIVE_CLASSIC_PROTECTION));
  assert.throws(
    () =>
      assertSupportedClassicProtection({
        ...LIVE_CLASSIC_PROTECTION,
        required_pull_request_reviews: { required_approving_review_count: 1 },
      }),
    UnsupportedClassicProtectionError,
  );
  assert.throws(
    () =>
      assertSupportedClassicProtection({
        ...LIVE_CLASSIC_PROTECTION,
        restrictions: { users: [], teams: [], apps: [] },
      }),
    UnsupportedClassicProtectionError,
  );
});

test('buildClassicProtectionPayload refuses to build a payload for unsupported live settings', () => {
  assert.throws(
    () =>
      buildClassicProtectionPayload(
        { ...LIVE_CLASSIC_PROTECTION, restrictions: { users: [] } },
        { requiredStatusChecks: null },
      ),
    UnsupportedClassicProtectionError,
  );
});

test('classicStatusChecksDisabled/Restored read the classic protection shape correctly', () => {
  assert.equal(classicStatusChecksDisabled(LIVE_CLASSIC_PROTECTION), false);
  assert.equal(
    classicStatusChecksDisabled({ ...LIVE_CLASSIC_PROTECTION, required_status_checks: null }),
    true,
  );
  assert.equal(classicStatusChecksDisabled(null), true);

  assert.equal(classicStatusChecksRestored(LIVE_CLASSIC_PROTECTION), true);
  assert.equal(
    classicStatusChecksRestored({
      ...LIVE_CLASSIC_PROTECTION,
      required_status_checks: {
        strict: true,
        checks: [
          { context: 'ci', app_id: 15368 },
          { context: 'merge-train', app_id: TRAIN_APP_ID },
        ],
      },
    }),
    false,
    'restored means EXACTLY the legacy ci-only shape, not ci plus anything else',
  );
  assert.equal(
    classicStatusChecksRestored({ ...LIVE_CLASSIC_PROTECTION, required_status_checks: null }),
    false,
  );
});

test('classicProtectionMissing distinguishes a 404 (null/undefined) from an existing resource with disabled checks (issue #1151 gap 2)', () => {
  assert.equal(classicProtectionMissing(null), true);
  assert.equal(classicProtectionMissing(undefined), true);
  assert.equal(
    classicProtectionMissing({ ...LIVE_CLASSIC_PROTECTION, required_status_checks: null }),
    false,
    'an existing protection resource with required_status_checks disabled is NOT "missing" -- ' +
      'classicStatusChecksDisabled(null) intentionally conflates both, but callers that need to ' +
      'tell them apart (status/enable/rollback postconditions) must use this function instead',
  );
  assert.equal(classicProtectionMissing(LIVE_CLASSIC_PROTECTION), false);
});

test('buildRulesetPayload requires everyone except the trusted App to satisfy ci + merge-train', () => {
  const payload = buildRulesetPayload({ trainAppId: TRAIN_APP_ID });
  assert.equal(payload.target, 'branch');
  assert.equal(payload.enforcement, 'active');
  assert.deepEqual(payload.conditions.ref_name.include, [PROTECTED_REF]);
  const rule = payload.rules.find((entry) => entry.type === 'required_status_checks');
  assert.ok(rule, 'expected a required_status_checks rule');
  assert.equal(rule.parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(rule.parameters.required_status_checks, [
    { context: 'ci', integration_id: GITHUB_ACTIONS_APP_ID },
    { context: 'merge-train', integration_id: TRAIN_APP_ID },
  ]);
  assert.deepEqual(payload.bypass_actors, [
    { actor_id: TRAIN_APP_ID, actor_type: 'Integration', bypass_mode: 'always' },
  ]);
});

test('buildRulesetPayload rejects an invalid trainAppId instead of building an unbypassable ruleset', () => {
  assert.throws(() => buildRulesetPayload({ trainAppId: 0 }), /positive integer/);
  assert.throws(() => buildRulesetPayload({ trainAppId: Number.NaN }), /positive integer/);
  assert.throws(() => buildRulesetPayload({ trainAppId: undefined }), /positive integer/);
});

test('findRulesetByName finds by exact name and returns null when absent', () => {
  const rulesets = [
    { id: 1, name: 'Copilot code review' },
    { id: 2, name: RULESET_NAME },
  ];
  assert.equal(findRulesetByName(rulesets, RULESET_NAME)?.id, 2);
  assert.equal(findRulesetByName(rulesets, 'does not exist'), null);
  assert.equal(findRulesetByName([], RULESET_NAME), null);
});

test('findRulesetByName fails closed (throws) instead of silently picking one when duplicates exist (issue #1151 adversarial plan review)', () => {
  const rulesets = [
    { id: 2, name: RULESET_NAME },
    { id: 3, name: RULESET_NAME },
  ];
  assert.throws(() => findRulesetByName(rulesets, RULESET_NAME), AmbiguousRulesetNameError);
  assert.throws(() => findRulesetByName(rulesets, RULESET_NAME), /Found 2 rulesets named/);
});

test('rulesetProblems accepts a live ruleset that exactly matches the expected shape', () => {
  assert.deepEqual(rulesetProblems(liveRuleset(), { trainAppId: TRAIN_APP_ID }), []);
});

test('rulesetProblems reports a missing ruleset', () => {
  assert.deepEqual(rulesetProblems(null, { trainAppId: TRAIN_APP_ID }), ['ruleset does not exist']);
});

test('rulesetProblems fails closed on a disabled ruleset (rollback state, not enable state)', () => {
  const problems = rulesetProblems(liveRuleset({ enforcement: 'disabled' }), {
    trainAppId: TRAIN_APP_ID,
  });
  assert.ok(problems.some((problem) => problem.includes('enforcement is "disabled"')));
});

test('rulesetProblems fails closed on a wrong or missing bypass actor', () => {
  const noBypass = rulesetProblems(liveRuleset({ bypass_actors: [] }), {
    trainAppId: TRAIN_APP_ID,
  });
  assert.ok(noBypass.some((problem) => problem.includes('no Integration bypass actor')));

  const wrongMode = rulesetProblems(
    liveRuleset({
      bypass_actors: [
        { actor_id: TRAIN_APP_ID, actor_type: 'Integration', bypass_mode: 'pull_request' },
      ],
    }),
    { trainAppId: TRAIN_APP_ID },
  );
  assert.ok(wrongMode.some((problem) => problem.includes('bypass_mode "pull_request"')));

  const extraBypass = rulesetProblems(
    liveRuleset({
      bypass_actors: [
        { actor_id: TRAIN_APP_ID, actor_type: 'Integration', bypass_mode: 'always' },
        { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      ],
    }),
    { trainAppId: TRAIN_APP_ID },
  );
  assert.ok(
    extraBypass.some((problem) => problem.includes('expected exactly 1')),
    'an extra bypass actor beyond the trusted App must be flagged, not silently accepted',
  );
});

test('rulesetProblems fails closed when required contexts are wrong or missing merge-train', () => {
  const ciOnly = rulesetProblems(
    liveRuleset({
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: 'ci', integration_id: GITHUB_ACTIONS_APP_ID }],
          },
        },
      ],
    }),
    { trainAppId: TRAIN_APP_ID },
  );
  assert.ok(ciOnly.some((problem) => problem.includes('required_status_checks contexts are')));

  const notStrict = rulesetProblems(
    liveRuleset({
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [
              { context: 'ci', integration_id: GITHUB_ACTIONS_APP_ID },
              { context: 'merge-train', integration_id: TRAIN_APP_ID },
            ],
          },
        },
      ],
    }),
    { trainAppId: TRAIN_APP_ID },
  );
  assert.ok(notStrict.some((problem) => problem.includes('strict_required_status_checks_policy')));
});

test('rulesetProblems fails closed when the ruleset scope is broadened beyond exactly refs/heads/main', () => {
  const extraInclude = rulesetProblems(
    liveRuleset({
      conditions: { ref_name: { include: [PROTECTED_REF, 'refs/heads/release'], exclude: [] } },
    }),
    { trainAppId: TRAIN_APP_ID },
  );
  assert.ok(
    extraInclude.some((problem) => problem.includes('ruleset ref scope is')),
    'a ruleset that also covers another ref besides main must be flagged, not silently accepted',
  );

  const wrongRef = rulesetProblems(
    liveRuleset({ conditions: { ref_name: { include: ['refs/heads/develop'], exclude: [] } } }),
    { trainAppId: TRAIN_APP_ID },
  );
  assert.ok(wrongRef.some((problem) => problem.includes('ruleset ref scope is')));

  const nonEmptyExclude = rulesetProblems(
    liveRuleset({
      conditions: { ref_name: { include: [PROTECTED_REF], exclude: ['refs/heads/hotfix'] } },
    }),
    { trainAppId: TRAIN_APP_ID },
  );
  assert.ok(
    nonEmptyExclude.some((problem) => problem.includes('ruleset ref scope is')),
    'a non-empty exclude list is scope drift too and must be flagged',
  );
});

test('buildRulesetDisablePayload preserves the trusted App bypass while setting enforcement to disabled', () => {
  const payload = buildRulesetDisablePayload(liveRuleset());
  assert.equal(payload.enforcement, 'disabled');
  assert.deepEqual(payload.bypass_actors, [
    { actor_id: TRAIN_APP_ID, actor_type: 'Integration', bypass_mode: 'always' },
  ]);
  assert.equal(payload.name, RULESET_NAME);
  assert.deepEqual(payload.conditions, liveRuleset().conditions);
  assert.deepEqual(payload.rules, liveRuleset().rules);
});

test('buildRulesetDisablePayload recovers a ruleset with a missing bypass actor instead of throwing (issue #1151 gap 1)', () => {
  // A partially-applied enable() or manual tampering can leave the live
  // ruleset ACTIVE but with no Integration bypass actor at all. rollback()
  // already restores classic ci BEFORE calling this function, so throwing
  // here used to leave main behind an active ruleset requiring merge-train
  // with no automated way to disable it. Shape-preserving disable succeeds
  // regardless -- it only changes `enforcement`.
  const broken = liveRuleset({ bypass_actors: [] });
  const payload = buildRulesetDisablePayload(broken);
  assert.equal(payload.enforcement, 'disabled');
  assert.deepEqual(
    payload.bypass_actors,
    [],
    'no App id supplied and none present on the ruleset -- disable still succeeds with an empty list',
  );
});

test('buildRulesetDisablePayload repairs bypass_actors from an independently-supplied trainAppId when the live ruleset has none', () => {
  // Gap 1's other half: give rollback an App-id source independent of the
  // (possibly-broken) live ruleset, via --app-id/MERGE_TRAIN_APP_ID, so a
  // later enable() re-run starts from a ruleset that still names the
  // trusted App rather than one that silently lost track of it.
  const broken = liveRuleset({ bypass_actors: [] });
  const payload = buildRulesetDisablePayload(broken, { trainAppId: TRAIN_APP_ID });
  assert.equal(payload.enforcement, 'disabled');
  assert.deepEqual(payload.bypass_actors, [
    { actor_id: TRAIN_APP_ID, actor_type: 'Integration', bypass_mode: 'always' },
  ]);
});

test('buildRulesetDisablePayload prefers the live ruleset shape over a supplied trainAppId when both are present', () => {
  // Shape-preservation takes priority: if the live ruleset already has
  // bypass actors (even a drifted/wrong one), disabling must not silently
  // discard/replace them just because --app-id was also passed.
  const drifted = liveRuleset({
    bypass_actors: [{ actor_id: 999, actor_type: 'Integration', bypass_mode: 'always' }],
  });
  const payload = buildRulesetDisablePayload(drifted, { trainAppId: TRAIN_APP_ID });
  assert.deepEqual(payload.bypass_actors, [
    { actor_id: 999, actor_type: 'Integration', bypass_mode: 'always' },
  ]);
});

test('rulesetDisabled is true once enforcement is anything other than active', () => {
  assert.equal(rulesetDisabled(liveRuleset()), false);
  assert.equal(rulesetDisabled(liveRuleset({ enforcement: 'disabled' })), true);
  assert.equal(rulesetDisabled({ exists: false }), true);
});

test('inferTrainAppId returns the Integration bypass actor id, or null when absent/ambiguous', () => {
  assert.equal(inferTrainAppId(liveRuleset()), TRAIN_APP_ID);
  assert.equal(inferTrainAppId(null), null);
  assert.equal(inferTrainAppId(liveRuleset({ bypass_actors: [] })), null);
  assert.equal(
    inferTrainAppId(
      liveRuleset({
        bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
      }),
    ),
    null,
    'a non-Integration bypass actor must not be mistaken for the trusted App',
  );
});

test('assertKnownClassicStatusChecksShape no-ops on the known legacy shape or when already disabled', () => {
  assert.doesNotThrow(() => assertKnownClassicStatusChecksShape(LIVE_CLASSIC_PROTECTION));
  assert.doesNotThrow(() =>
    assertKnownClassicStatusChecksShape({
      ...LIVE_CLASSIC_PROTECTION,
      required_status_checks: null,
    }),
  );
  assert.doesNotThrow(() => assertKnownClassicStatusChecksShape(null));
});

test('assertKnownClassicStatusChecksShape fails closed on classic shape drift instead of silently discarding it', () => {
  assert.throws(
    () =>
      assertKnownClassicStatusChecksShape({
        ...LIVE_CLASSIC_PROTECTION,
        required_status_checks: {
          strict: true,
          checks: [
            { context: 'ci', app_id: 15368 },
            { context: 'lint', app_id: 15368 },
          ],
        },
      }),
    UnknownClassicStatusChecksShapeError,
  );
  assert.throws(
    () =>
      assertKnownClassicStatusChecksShape({
        ...LIVE_CLASSIC_PROTECTION,
        required_status_checks: { strict: false, checks: [{ context: 'ci', app_id: 15368 }] },
      }),
    UnknownClassicStatusChecksShapeError,
  );
});
