// Orchestration tests for protection.mjs (enable/rollback/status) against an
// in-memory fake `api`, so ordering/idempotence/fail-closed behavior is
// covered without touching the network. See protection-lib.test.mjs for the
// pure payload-builder/validator unit tests this orchestration relies on.

import assert from 'node:assert/strict';
import test from 'node:test';

import { GITHUB_ACTIONS_APP_ID, legacyRequiredStatusChecks } from './protection-lib.mjs';
import { enable, printStatus, rollback } from './protection.mjs';

const TRAIN_APP_ID = 4106541;

function legacyClassicProtection() {
  return {
    required_status_checks: legacyRequiredStatusChecks(),
    enforce_admins: { enabled: false },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_linear_history: { enabled: false },
    block_creations: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
  };
}

function liveRuleset({ id = 1, enforcement = 'active' } = {}) {
  return {
    id,
    name: 'Merge Train Required Checks',
    target: 'branch',
    enforcement,
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: 'ci', integration_id: GITHUB_ACTIONS_APP_ID },
            { context: 'merge-train', integration_id: TRAIN_APP_ID },
          ],
        },
      },
    ],
    bypass_actors: [{ actor_id: TRAIN_APP_ID, actor_type: 'Integration', bypass_mode: 'always' }],
  };
}

/**
 * A tiny in-memory fake of the GitHub API surface enable/rollback/printStatus
 * need, recording every call so tests can assert call order.
 *
 * `getRulesets()` deliberately returns STRIPPED summary objects (only
 * `id`/`name`/`target`/`enforcement`, matching what GitHub's real
 * `GET /repos/{owner}/{repo}/rulesets` LIST endpoint returns) while
 * `getRuleset(id)` returns the full stored detail object (`conditions`/
 * `rules`/`bypass_actors` included, matching the real
 * `GET /repos/{owner}/{repo}/rulesets/{id}` DETAIL endpoint). This
 * distinction is intentional and load-bearing: an earlier version of this
 * fake returned full detail objects from BOTH endpoints, which hid the
 * exact bug that caused a live false-failure incident on 2026-07-15 --
 * `printStatus` validated the un-hydrated list-summary object directly
 * instead of fetching detail via `getRuleset(id)` first, so a genuinely
 * correct live ruleset reported as completely broken (empty ref scope, no
 * required checks, no bypass actor). Any code path here that reads
 * `conditions`/`rules`/`bypass_actors` off a `getRulesets()` result without
 * first re-fetching via `getRuleset(id)` will now fail these tests instead
 * of silently passing against an unrealistic fake.
 */
function makeFakeApi({
  classicProtection = legacyClassicProtection(),
  rulesets = [],
  mergeTrainEnabled = false,
} = {}) {
  const calls = [];
  let protection = classicProtection;
  const rulesetStore = new Map(rulesets.map((ruleset) => [ruleset.id, ruleset]));
  let nextId = rulesetStore.size + 1;

  function toListSummary(ruleset) {
    const { id, name, target, enforcement } = ruleset;
    return { id, name, target, enforcement };
  }

  return {
    calls,
    api: {
      async getClassicProtection() {
        calls.push('getClassicProtection');
        return protection;
      },
      async putClassicProtection(body) {
        calls.push('putClassicProtection');
        protection = {
          required_status_checks: body.required_status_checks,
          enforce_admins: { enabled: body.enforce_admins },
          required_conversation_resolution: { enabled: body.required_conversation_resolution },
          allow_force_pushes: { enabled: body.allow_force_pushes },
          allow_deletions: { enabled: body.allow_deletions },
          required_linear_history: { enabled: body.required_linear_history },
          block_creations: { enabled: body.block_creations },
          lock_branch: { enabled: body.lock_branch },
          allow_fork_syncing: { enabled: body.allow_fork_syncing },
        };
      },
      async getRulesets() {
        calls.push('getRulesets');
        return [...rulesetStore.values()].map(toListSummary);
      },
      async getRuleset(id) {
        calls.push('getRuleset');
        return rulesetStore.get(id);
      },
      async createRuleset(body) {
        calls.push('createRuleset');
        const created = { id: nextId++, ...body };
        rulesetStore.set(created.id, created);
        return created;
      },
      async updateRuleset(id, body) {
        calls.push('updateRuleset');
        const updated = { id, ...body };
        rulesetStore.set(id, updated);
        return updated;
      },
      async getMergeTrainEnabled() {
        calls.push('getMergeTrainEnabled');
        return mergeTrainEnabled;
      },
    },
  };
}

test('enable creates/verifies the ruleset BEFORE disabling classic checks, so a ruleset failure never leaves main unprotected', async () => {
  const { api, calls } = makeFakeApi();
  const report = await enable({ api, appId: TRAIN_APP_ID });

  assert.equal(report.classic.requiredStatusChecksDisabled, true);
  assert.equal(report.ruleset.enforcement, 'active');
  assert.deepEqual(report.ruleset.problems, []);

  const classicPutIndex = calls.indexOf('putClassicProtection');
  const rulesetCreateIndex = calls.indexOf('createRuleset');
  assert.ok(classicPutIndex >= 0, 'classic protection must be updated');
  assert.ok(rulesetCreateIndex >= 0, 'ruleset must be created');
  assert.ok(
    rulesetCreateIndex < classicPutIndex,
    'the ruleset must be created and its postcondition verified BEFORE classic required_status_checks ' +
      'is disabled -- never a window with neither mechanism enforcing ci',
  );
});

test('enable is idempotent: re-running against an already-enabled repo updates rather than duplicates', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
  });
  const report = await enable({ api, appId: TRAIN_APP_ID });

  assert.equal(report.classic.requiredStatusChecksDisabled, true);
  assert.deepEqual(report.ruleset.problems, []);
  assert.ok(
    !calls.includes('createRuleset'),
    're-running enable must not create a duplicate ruleset',
  );
  assert.ok(
    calls.includes('updateRuleset'),
    're-running enable should update the existing ruleset in place',
  );
  assert.ok(
    !calls.includes('putClassicProtection'),
    'classic protection should not be re-written once already disabled',
  );
});

test('enable throws when the postcondition is not met (ruleset missing required train context), and never touches classic protection', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
  });
  // Simulate GitHub persisting a broken shape (missing the merge-train
  // context) so the direct re-read via getRuleset() -- not the
  // create/update response -- must catch it.
  const realGetRuleset = api.getRuleset;
  api.getRuleset = async (id) => {
    const stored = await realGetRuleset(id);
    return {
      ...stored,
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: 'ci', integration_id: GITHUB_ACTIONS_APP_ID }],
          },
        },
      ],
    };
  };

  await assert.rejects(
    () => enable({ api, appId: TRAIN_APP_ID }),
    /enable aborted before touching classic protection/,
  );
  assert.ok(
    !calls.includes('putClassicProtection'),
    'a failed ruleset postcondition must abort before classic protection is ever touched',
  );
});

test('enable fails closed instead of silently discarding a drifted classic required_status_checks shape, and never creates the ruleset', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: {
      ...legacyClassicProtection(),
      required_status_checks: {
        strict: true,
        checks: [
          { context: 'ci', app_id: GITHUB_ACTIONS_APP_ID },
          { context: 'lint', app_id: GITHUB_ACTIONS_APP_ID },
        ],
      },
    },
  });

  await assert.rejects(() => enable({ api, appId: TRAIN_APP_ID }), /unexpected shape/);
  assert.ok(
    !calls.includes('putClassicProtection'),
    'a drifted classic shape must never be silently overwritten/discarded',
  );
  assert.ok(
    !calls.includes('createRuleset') && !calls.includes('updateRuleset'),
    'classic shape must be validated BEFORE the ruleset is created/activated -- otherwise an ' +
      'aborted run would leave main behind an active ruleset requiring merge-train while ' +
      'MERGE_TRAIN_ENABLED is still false, permanently blocking ordinary merges',
  );
});

test('enable fails closed when classic branch protection does not exist at all (404), and never touches the ruleset', async () => {
  const { api, calls } = makeFakeApi({ classicProtection: null });

  await assert.rejects(() => enable({ api, appId: TRAIN_APP_ID }), /does not exist \(404/);
  assert.ok(
    !calls.includes('createRuleset') && !calls.includes('updateRuleset'),
    'a missing classic-protection resource must abort before the ruleset is ever touched',
  );
  assert.ok(
    !calls.includes('putClassicProtection'),
    'a missing classic-protection resource must never be silently treated as "already migrated"',
  );
});

test('rollback refuses to run while MERGE_TRAIN_ENABLED is true, unless --force is passed', async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
    mergeTrainEnabled: true,
  });

  await assert.rejects(
    () => rollback({ api, appId: TRAIN_APP_ID, force: false }),
    /MERGE_TRAIN_ENABLED is true/,
  );
});

test('rollback with --force while MERGE_TRAIN_ENABLED=true still restores classic before disabling the ruleset', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
    mergeTrainEnabled: true,
  });

  const report = await rollback({ api, appId: TRAIN_APP_ID, force: true });

  assert.equal(report.classic.requiredStatusChecksRestored, true);
  assert.notEqual(report.ruleset.enforcement, 'active');

  const classicPutIndex = calls.indexOf('putClassicProtection');
  const rulesetUpdateIndex = calls.indexOf('updateRuleset');
  assert.ok(classicPutIndex >= 0 && rulesetUpdateIndex >= 0);
  assert.ok(
    classicPutIndex < rulesetUpdateIndex,
    'classic required_status_checks must be restored BEFORE the ruleset is disabled -- never a window with neither enforcing ci',
  );
});

test('rollback from the live-enabled state restores legacy classic and disables (not deletes) the ruleset', async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
    mergeTrainEnabled: false,
  });

  const report = await rollback({ api, appId: TRAIN_APP_ID, force: false });

  assert.equal(report.classic.requiredStatusChecksRestored, true);
  assert.equal(
    report.ruleset.exists,
    true,
    'ruleset must be kept (disabled), not deleted, for audit/re-enable',
  );
  assert.notEqual(report.ruleset.enforcement, 'active');
});

test('rollback is idempotent: re-running against an already-rolled-back repo is a safe no-op', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: legacyClassicProtection(),
    rulesets: [liveRuleset({ enforcement: 'disabled' })],
    mergeTrainEnabled: false,
  });

  const report = await rollback({ api, appId: TRAIN_APP_ID, force: false });

  assert.equal(report.classic.requiredStatusChecksRestored, true);
  assert.notEqual(report.ruleset.enforcement, 'active');
  assert.ok(
    !calls.includes('putClassicProtection'),
    'classic protection already restored, must not be re-written',
  );
  assert.ok(!calls.includes('updateRuleset'), 'ruleset already disabled, must not be re-patched');
});

test('rollback succeeds when the ruleset does not exist to disable, verifying classic restore only', async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [],
    mergeTrainEnabled: false,
  });

  const report = await rollback({ api, appId: TRAIN_APP_ID, force: false });
  assert.equal(report.classic.requiredStatusChecksRestored, true);
  assert.equal(report.ruleset.exists, false);
});

test('rollback fails closed instead of silently discarding a drifted classic required_status_checks shape', async () => {
  // Mirrors the enable() shape-drift test above: an operator manually
  // strengthened classic protection (e.g. added a "lint" context) while the
  // ruleset was live. rollback must never silently overwrite that drift with
  // the legacy ci-only shape -- it must fail closed until a human reconciles
  // the live shape, exactly like enable() already does before disabling.
  const { api, calls } = makeFakeApi({
    classicProtection: {
      ...legacyClassicProtection(),
      required_status_checks: {
        strict: true,
        checks: [
          { context: 'ci', app_id: GITHUB_ACTIONS_APP_ID },
          { context: 'lint', app_id: GITHUB_ACTIONS_APP_ID },
        ],
      },
    },
    rulesets: [liveRuleset()],
    mergeTrainEnabled: false,
  });

  await assert.rejects(
    () => rollback({ api, appId: TRAIN_APP_ID, force: false }),
    /unexpected shape/,
  );
  assert.ok(
    !calls.includes('putClassicProtection'),
    'a drifted classic shape must never be silently overwritten/discarded by rollback either',
  );
  assert.ok(
    !calls.includes('updateRuleset'),
    'rollback must abort before touching the ruleset too, since classic restore never completed',
  );
});

test('rollback fails closed when classic branch protection does not exist at all (404), and never touches the ruleset', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: null,
    rulesets: [liveRuleset()],
    mergeTrainEnabled: false,
  });

  await assert.rejects(
    () => rollback({ api, appId: TRAIN_APP_ID, force: false }),
    /does not exist \(404/,
  );
  assert.ok(
    !calls.includes('putClassicProtection') && !calls.includes('updateRuleset'),
    'a missing classic-protection resource must abort before any write, on rollback too',
  );
});

test('printStatus reports both classic and ruleset state without mutating anything', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
  });

  const report = await printStatus({ api, appId: TRAIN_APP_ID });

  assert.equal(report.classic.requiredStatusChecksDisabled, true);
  assert.equal(report.ruleset.enforcement, 'active');
  assert.deepEqual(report.ruleset.problems, []);
  assert.ok(
    !calls.some(
      (call) => call.startsWith('put') || call.startsWith('create') || call.startsWith('update'),
    ),
    'status must be read-only',
  );
});

test('printStatus always computes ruleset.problems, even when the ruleset does not exist (no silent pass-through)', async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [],
  });

  const report = await printStatus({ api, appId: TRAIN_APP_ID });

  assert.equal(report.ruleset.exists, false);
  assert.ok(
    Array.isArray(report.ruleset.problems),
    'problems must always be an array, never undefined',
  );
  assert.deepEqual(report.ruleset.problems, ['ruleset does not exist']);
});

test('printStatus reports an explicit "cannot validate" problem (never a false-clean pass) when appId is not supplied, since inferring the expected id from the live ruleset itself would be circular', async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
  });

  const statusReport = await printStatus({ api, appId: null });
  assert.equal(
    statusReport.ruleset.problems.length,
    1,
    'without a trusted --app-id/MERGE_TRAIN_APP_ID, problems must not silently report [] -- a ' +
      'ruleset drifted to bypass a wrong/compromised Integration actor would otherwise trivially ' +
      'validate against itself',
  );
  assert.match(statusReport.ruleset.problems[0], /trusted App id not supplied/);
  assert.equal(
    statusReport.ruleset.bypassActorId,
    TRAIN_APP_ID,
    'the live bypass actor id is still surfaced for informational/display purposes',
  );

  // With an explicit trusted appId, validation proceeds normally and can
  // report a genuinely clean ruleset.
  const validatedReport = await printStatus({ api, appId: TRAIN_APP_ID });
  assert.deepEqual(validatedReport.ruleset.problems, []);

  const { api: rollbackApi } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
  });
  const rollbackReport = await rollback({ api: rollbackApi, appId: null, force: false });
  assert.equal(rollbackReport.classic.requiredStatusChecksRestored, true);
  assert.notEqual(rollbackReport.ruleset.enforcement, 'active');
});

// --- Issue #1151 gap 1: rollback recovery when the live ruleset's bypass
// actor is missing/drifted --------------------------------------------------

test('rollback disables a ruleset whose Integration bypass actor is missing (partial-enable/broken-ruleset recovery), instead of throwing after classic ci is already restored', async () => {
  // Simulates the exact incident gap 1 covers: enable() partially applied
  // (or an operator manually tampered with the ruleset), leaving it ACTIVE
  // but with no Integration bypass actor. Before the fix, rollback() would
  // restore classic ci successfully, then throw while trying to disable the
  // ruleset (buildRulesetDisablePayload's old requireTrainBypassId() had
  // nothing to infer from) -- leaving main behind an active ruleset
  // requiring merge-train with no automated way out.
  const brokenRuleset = liveRuleset();
  delete brokenRuleset.bypass_actors;
  brokenRuleset.bypass_actors = [];

  const { api, calls } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [brokenRuleset],
    mergeTrainEnabled: false,
  });

  const report = await rollback({ api, appId: TRAIN_APP_ID, force: false });

  assert.equal(report.classic.requiredStatusChecksRestored, true);
  assert.notEqual(
    report.ruleset.enforcement,
    'active',
    'rollback must succeed in disabling the ruleset even though it had no bypass actor to preserve',
  );
  assert.ok(
    calls.includes('updateRuleset'),
    'the broken ruleset must still be disabled, not left active',
  );
});

test('rollback recovers a broken ruleset even when NO --app-id is supplied, by shape-preserving the (empty) bypass_actors rather than repairing it', async () => {
  const brokenRuleset = liveRuleset();
  brokenRuleset.bypass_actors = [];

  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [brokenRuleset],
    mergeTrainEnabled: false,
  });

  // No appId at all -- rollback must still be able to disable the ruleset;
  // it only needs classic protection's own shape, never the App id, to
  // succeed at DISABLING (as opposed to fully re-validating) the ruleset.
  const report = await rollback({ api, appId: null, force: false });
  assert.equal(report.classic.requiredStatusChecksRestored, true);
  assert.notEqual(report.ruleset.enforcement, 'active');
});

// --- Issue #1151 gap 2: status/postconditions must flag a missing classic
// protection resource (404), not treat null as "checks disabled" -----------

test('printStatus reports classic protection as missing (404) rather than silently treating it as "already disabled"', async () => {
  const { api } = makeFakeApi({
    classicProtection: null,
    rulesets: [liveRuleset()],
  });

  const report = await printStatus({ api, appId: TRAIN_APP_ID });

  assert.equal(report.classic.missing, true);
  assert.equal(
    report.classic.requiredStatusChecksDisabled,
    true,
    'the underlying pure classicStatusChecksDisabled(null) is deliberately blind to this ' +
      'distinction (see its doc comment) -- callers must check classic.missing separately, which ' +
      'this report now surfaces explicitly',
  );
});

test("enable's final postcondition fails closed if classic branch protection vanishes between the mutation and the postcondition read", async () => {
  const { api, calls } = makeFakeApi();
  // Simulate classic protection being deleted out-of-band (e.g. by another
  // operator/tool) right after enable() successfully disabled it but before
  // the final postcondition read.
  let readCount = 0;
  const realGetClassicProtection = api.getClassicProtection;
  api.getClassicProtection = async () => {
    readCount += 1;
    // Reads 1 and 2 are enable()'s own pre-flight/re-validate reads (must
    // stay real so enable proceeds normally); the 3rd read is inside the
    // final printStatus() postcondition call.
    if (readCount >= 3) return null;
    return realGetClassicProtection();
  };

  await assert.rejects(
    () => enable({ api, appId: TRAIN_APP_ID }),
    /enable postcondition failed: classicMissing=true/,
  );
  assert.ok(calls.includes('putClassicProtection'), 'the mutation itself must still have run');
});

test("rollback's final postcondition fails closed if classic branch protection vanishes between the mutation and the postcondition read", async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
    mergeTrainEnabled: false,
  });
  let readCount = 0;
  const realGetClassicProtection = api.getClassicProtection;
  api.getClassicProtection = async () => {
    readCount += 1;
    if (readCount >= 2) return null; // vanish right after rollback's own restore-read/write
    return realGetClassicProtection();
  };

  await assert.rejects(
    () => rollback({ api, appId: TRAIN_APP_ID, force: false }),
    /rollback postcondition failed: classicMissing=true/,
  );
});

// --- Issue #1151 gap 3 (live-reproduced 2026-07-15): ruleset list-summary
// vs. full-detail hydration --------------------------------------------------

test('printStatus hydrates the ruleset via getRuleset(id) instead of validating the un-hydrated list-summary object (reproduces the 2026-07-15 live false-failure)', async () => {
  // makeFakeApi()'s getRulesets() always returns stripped summaries (see its
  // doc comment) -- this test just makes the scenario explicit and names the
  // incident: a genuinely correct, fully-configured live ruleset must be
  // reported clean, not "ruleset ref scope is include=[] exclude=[], no
  // required_status_checks rule, no bypass actor" (what validating the raw
  // list-summary object directly produces).
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
  });

  const summaries = await api.getRulesets();
  assert.ok(
    !('conditions' in summaries[0]) &&
      !('rules' in summaries[0]) &&
      !('bypass_actors' in summaries[0]),
    "sanity check: the fake list endpoint really does omit detail fields, matching GitHub's real API",
  );

  const report = await printStatus({ api, appId: TRAIN_APP_ID });
  assert.deepEqual(
    report.ruleset.problems,
    [],
    'a genuinely correct live ruleset must report zero problems once hydrated via getRuleset(id)',
  );
});

test('enable does not false-rollback (its postcondition does not falsely fail) when getRulesets() returns list-summary-only objects for a freshly created ruleset', async () => {
  const { api, calls } = makeFakeApi(); // no pre-existing ruleset -- enable() creates one from scratch

  const report = await enable({ api, appId: TRAIN_APP_ID });

  assert.deepEqual(
    report.ruleset.problems,
    [],
    'enable must not report a false postcondition failure just because the shared getRulesets() ' +
      'list endpoint returns summary-only objects -- printStatus must hydrate via getRuleset(id)',
  );
  assert.ok(calls.includes('createRuleset'));
});

test('printStatus fails closed (non-empty problems) when the hydrated ruleset detail reveals a genuine drift that the list-summary name match alone could not show', async () => {
  // The list summary only has id/name/target/enforcement -- a ruleset that
  // matches by name there could still be badly misconfigured underneath.
  // This proves problems are computed from the HYDRATED detail, not just
  // "found by name in the list", so a real drift is never silently missed.
  const driftedDetail = liveRuleset();
  driftedDetail.bypass_actors = [];
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [driftedDetail],
  });

  const report = await printStatus({ api, appId: TRAIN_APP_ID });
  assert.ok(
    report.ruleset.problems.length > 0,
    'a missing bypass actor must be flagged as a problem',
  );
  assert.ok(
    report.ruleset.problems.some((problem) => problem.includes('no Integration bypass actor')),
  );
});

// The following three tests cover the [Blocking] concern raised by issue
// #1151's adversarial plan review: findRulesetByName() previously picked the
// FIRST match silently when more than one ruleset shared the expected name,
// which could let status/enable/rollback all inspect/mutate the "wrong" one
// while a second, untouched duplicate kept blocking (or failing to block)
// merges invisibly. It now fails closed (throws AmbiguousRulesetNameError)
// instead. These prove that failure propagates through every orchestration
// entry point rather than being swallowed anywhere along the way.

test('printStatus fails closed instead of silently picking one when duplicate-named rulesets exist live', async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset({ id: 10 }), liveRuleset({ id: 11 })],
  });

  await assert.rejects(printStatus({ api, appId: TRAIN_APP_ID }), /Found 2 rulesets named/);
});

test('enable fails closed instead of silently updating one of several duplicate-named rulesets', async () => {
  const { api, calls } = makeFakeApi({
    rulesets: [liveRuleset({ id: 10 }), liveRuleset({ id: 11 })],
  });

  await assert.rejects(enable({ api, appId: TRAIN_APP_ID }), /Found 2 rulesets named/);
  assert.ok(
    !calls.includes('updateRuleset') && !calls.includes('createRuleset'),
    'enable must abort before mutating any ruleset once duplicates are detected',
  );
  assert.ok(
    !calls.includes('putClassicProtection'),
    'enable must never touch classic protection once ruleset lookup fails closed',
  );
});

test('rollback fails closed instead of silently disabling one of several duplicate-named rulesets', async () => {
  const { api, calls } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset({ id: 10 }), liveRuleset({ id: 11 })],
  });

  await assert.rejects(rollback({ api, appId: TRAIN_APP_ID }), /Found 2 rulesets named/);
  assert.ok(
    !calls.includes('updateRuleset'),
    'rollback must abort before disabling any ruleset once duplicates are detected',
  );
});

test('rollback logs an operator-visible warning (but does not normalize) when disabling a ruleset whose live bypass actor does not match the supplied --app-id', async () => {
  const drifted = liveRuleset();
  drifted.bypass_actors = [{ actor_id: 999999, actor_type: 'Integration', bypass_mode: 'always' }];
  const { api } = makeFakeApi({
    mergeTrainEnabled: true,
    rulesets: [drifted],
  });

  const logLines = [];
  const report = await rollback({
    api,
    appId: TRAIN_APP_ID,
    force: true,
    log: (line) => logLines.push(line),
  });

  const logged = logLines.join('');
  assert.ok(
    logged.includes('WARNING'),
    'a drifted bypass actor must be flagged, not silently carried forward',
  );
  assert.ok(logged.includes('999999') && logged.includes(String(TRAIN_APP_ID)));
  // The drifted actor is still preserved verbatim (not normalized to appId) --
  // rollback's disable path never makes a policy decision about which actor
  // is "correct", it only makes the existing one inert.
  assert.equal(report.ruleset.bypassActorId, 999999);
});

test('rollback does not log a drift warning when no trusted --app-id is supplied to compare against (nothing to compare, not a false drift signal)', async () => {
  // Distinct from the "no --app-id, empty bypass_actors" recovery test above
  // -- this exercises a DRIFTED-BUT-PRESENT bypass actor (liveBypassId is
  // truthy) with appId omitted, which is the one combination the warning
  // gate's `appId && liveBypassId && liveBypassId !== appId` condition must
  // suppress: with no trusted id to compare against, there is nothing to
  // call "drift", so no WARNING should be emitted.
  const drifted = liveRuleset();
  drifted.bypass_actors = [{ actor_id: 999999, actor_type: 'Integration', bypass_mode: 'always' }];
  const { api } = makeFakeApi({
    mergeTrainEnabled: true,
    rulesets: [drifted],
  });

  const logLines = [];
  await rollback({
    api,
    appId: null,
    force: true,
    log: (line) => logLines.push(line),
  });

  assert.ok(
    !logLines.join('').includes('WARNING'),
    'omitting --app-id must not itself be treated as drift -- there is no trusted id to compare against',
  );
});

test('rollback logs the drift warning even when the live bypass actor is not an Integration type at all (multi-model review finding)', async () => {
  // inferTrainAppId() strictly filters for actor_type === 'Integration' and
  // returns null for anything else -- a ruleset tampered to bypass via a
  // 'RepositoryRole' or 'Team' actor instead would make `liveBypassId` null,
  // which is indistinguishable from "no bypass actors at all" if the warning
  // gate only checked `liveBypassId` truthiness. buildRulesetDisablePayload
  // still preserves this non-Integration actor verbatim (bypass_actors.length
  // > 0), so it must still be flagged -- gating on `hasLiveActors` instead of
  // `liveBypassId` truthiness is what catches this.
  const drifted = liveRuleset();
  drifted.bypass_actors = [{ actor_id: 42, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
  const { api } = makeFakeApi({
    mergeTrainEnabled: true,
    rulesets: [drifted],
  });

  const logLines = [];
  await rollback({
    api,
    appId: TRAIN_APP_ID,
    force: true,
    log: (line) => logLines.push(line),
  });

  assert.ok(
    logLines.join('').includes('WARNING'),
    'a non-Integration bypass actor is still drift that gets preserved verbatim, and must be flagged',
  );
});
