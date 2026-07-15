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
        return [...rulesetStore.values()];
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

test('enable fails closed instead of silently discarding a drifted classic required_status_checks shape', async () => {
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

test('rollback throws when the ruleset does not exist to disable but classic restore is still verified', async () => {
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

test('printStatus/rollback infer the trusted App id from the live ruleset when appId is not supplied', async () => {
  const { api } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
  });

  const statusReport = await printStatus({ api, appId: null });
  assert.deepEqual(
    statusReport.ruleset.problems,
    [],
    'inferring appId from the live bypass actor should match reality and report no problems',
  );

  const { api: rollbackApi } = makeFakeApi({
    classicProtection: { ...legacyClassicProtection(), required_status_checks: null },
    rulesets: [liveRuleset()],
  });
  const rollbackReport = await rollback({ api: rollbackApi, appId: null, force: false });
  assert.equal(rollbackReport.classic.requiredStatusChecksRestored, true);
  assert.notEqual(rollbackReport.ruleset.enforcement, 'active');
});
