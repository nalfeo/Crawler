import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SOAK_DAYS,
  DEFAULT_STATE_PATH,
  LEGACY_MUTATION_SURFACE,
  decideLegacyDecommission,
  evaluateLegacyMutationSurface,
  laneGateSatisfied,
  legacyLaneGateExpression,
} from './lifecycle-decommission.mjs';
import { LIFECYCLE_PR_LANES } from './lifecycle-ownership.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workflowsDir = path.join(repoRoot, '.github/workflows');
const committedState = JSON.parse(readFileSync(path.join(repoRoot, DEFAULT_STATE_PATH), 'utf8'));

const readWorkflows = () =>
  Object.fromEntries(
    LEGACY_MUTATION_SURFACE.map((surface) => [
      surface.workflow,
      readFileSync(path.join(workflowsDir, surface.workflow), 'utf8'),
    ]),
  );

const NOW = '2026-10-01T00:00:00.000Z';

function readyState(overrides = {}) {
  return {
    version: 1,
    lanes: Object.fromEntries(LIFECYCLE_PR_LANES.map((lane) => [lane, 'goobers'])),
    soak: { startedAt: '2026-09-01T00:00:00.000Z' },
    rollbackActivations: [],
    rollbackDrill: {
      result: 'pass',
      completedAt: '2026-09-20T00:00:00.000Z',
      runIds: ['1234567890'],
    },
    emergencyBridge: { retained: true, boundedUntil: '2026-12-01T00:00:00.000Z' },
    branchProtection: {
      updatedToGoobersContexts: true,
      requiredChecks: ['ci', 'goobers-validate'],
    },
    ...overrides,
  };
}

test('a fully evidenced state is the only way to reach ready', () => {
  const decision = decideLegacyDecommission({ state: readyState(), now: NOW });
  assert.deepEqual(decision.blockers, []);
  assert.equal(decision.ready, true);
  assert.equal(decision.soak.requiredDays, DEFAULT_SOAK_DAYS);
});

test('missing or malformed evidence fails closed', () => {
  for (const state of [null, undefined, 'legacy', [], 42]) {
    const decision = decideLegacyDecommission({ state, now: NOW });
    assert.equal(decision.ready, false);
    assert.deepEqual(decision.blockers, ['invalid-state']);
  }
  assert.equal(decideLegacyDecommission({ state: readyState(), now: 'not-a-date' }).ready, false);
});

test('every unmigrated PR lane is reported, and only the literal goobers migrates one', () => {
  const decision = decideLegacyDecommission({ state: readyState({ lanes: {} }), now: NOW });
  assert.deepEqual(
    decision.blockers,
    LIFECYCLE_PR_LANES.map((lane) => `lane-not-migrated:${lane}`),
  );

  for (const owner of ['legacy', 'Goobers', ' goobers', 'goobrs', '', true]) {
    const state = readyState({ lanes: { ...readyState().lanes, 'merge-train': owner } });
    assert.deepEqual(
      decideLegacyDecommission({ state, now: NOW }).blockers,
      ['lane-not-migrated:merge-train'],
      `owner ${JSON.stringify(owner)} must not migrate the lane`,
    );
  }
});

test('an incomplete soak window blocks, and elapsed days are reported', () => {
  const state = readyState({
    soak: { startedAt: '2026-09-25T00:00:00.000Z' },
    rollbackDrill: { result: 'pass', completedAt: '2026-09-26T00:00:00.000Z', runIds: ['1'] },
  });
  const decision = decideLegacyDecommission({ state, now: NOW });
  assert.deepEqual(decision.blockers, ['soak-incomplete']);
  assert.equal(decision.soak.elapsedDays, 6);
  // Reported rounded, but compared unrounded: 13.9 days is still incomplete.
  const almost = decideLegacyDecommission({
    state: readyState({ soak: { startedAt: '2026-09-17T02:24:00.000Z' } }),
    now: NOW,
  });
  assert.equal(almost.soak.elapsedDays, 13.9);
  assert.deepEqual(almost.blockers, ['soak-incomplete']);

  assert.deepEqual(decideLegacyDecommission({ state, now: NOW, soakDays: 5 }).blockers, []);
  // The record's own `requiredDays` is honored, and the argument overrides it.
  const longSoak = { ...state, soak: { ...state.soak, requiredDays: 30 } };
  assert.deepEqual(decideLegacyDecommission({ state: longSoak, now: NOW }).blockers, [
    'soak-incomplete',
  ]);
  assert.equal(decideLegacyDecommission({ state: longSoak, now: NOW }).soak.requiredDays, 30);
  assert.deepEqual(
    decideLegacyDecommission({ state: longSoak, now: NOW, soakDays: 5 }).blockers,
    [],
  );
  // A malformed `requiredDays` must not shorten the soak.
  for (const requiredDays of [0, -1, 'forever', null, 1.5]) {
    const decision = decideLegacyDecommission({
      state: { ...state, soak: { ...state.soak, requiredDays } },
      now: NOW,
    });
    assert.equal(decision.soak.requiredDays, DEFAULT_SOAK_DAYS);
    assert.deepEqual(decision.blockers, ['soak-incomplete']);
  }
  // An unstarted soak cannot also be "predated" by the drill.
  assert.deepEqual(
    decideLegacyDecommission({ state: readyState({ soak: {} }), now: NOW }).blockers,
    ['soak-not-started'],
  );
});

test('a rollback activation inside the soak window blocks; an earlier one does not', () => {
  const during = readyState({ rollbackActivations: [{ at: '2026-09-10T00:00:00.000Z' }] });
  assert.deepEqual(decideLegacyDecommission({ state: during, now: NOW }).blockers, [
    'rollback-activation:2026-09-10T00:00:00.000Z',
  ]);

  const before = readyState({ rollbackActivations: [{ at: '2026-08-10T00:00:00.000Z' }] });
  assert.deepEqual(decideLegacyDecommission({ state: before, now: NOW }).blockers, []);

  const unparseable = readyState({ rollbackActivations: [{ at: 'whenever' }] });
  assert.deepEqual(decideLegacyDecommission({ state: unparseable, now: NOW }).blockers, [
    'rollback-activation:unparseable',
  ]);
});

test('the rollback drill must pass, be evidenced, and post-date the soak start', () => {
  const cases = [
    [{ rollbackDrill: undefined }, 'rollback-drill-missing'],
    [
      { rollbackDrill: { result: 'not-run', completedAt: null, runIds: [] } },
      'rollback-drill-not-passing',
    ],
    [
      { rollbackDrill: { result: 'fail', completedAt: NOW, runIds: ['1'] } },
      'rollback-drill-not-passing',
    ],
    [
      { rollbackDrill: { result: 'pass', completedAt: null, runIds: ['1'] } },
      'rollback-drill-missing',
    ],
    [
      { rollbackDrill: { result: 'pass', completedAt: '2026-08-01T00:00:00.000Z', runIds: ['1'] } },
      'rollback-drill-predates-soak',
    ],
    [
      { rollbackDrill: { result: 'pass', completedAt: '2026-09-20T00:00:00.000Z', runIds: [] } },
      'rollback-drill-unevidenced',
    ],
  ];
  for (const [overrides, blocker] of cases) {
    assert.deepEqual(
      decideLegacyDecommission({ state: readyState(overrides), now: NOW }).blockers,
      [blocker],
    );
  }
});

test('the bounded emergency bridge and final branch-protection contexts are required', () => {
  const cases = [
    [
      { emergencyBridge: { retained: false, boundedUntil: '2026-12-01T00:00:00.000Z' } },
      'emergency-bridge-not-retained',
    ],
    [
      { emergencyBridge: { retained: true, boundedUntil: null } },
      'emergency-bridge-window-undeclared',
    ],
    [
      { emergencyBridge: { retained: true, boundedUntil: '2026-08-01T00:00:00.000Z' } },
      'emergency-bridge-window-expired',
    ],
    [
      { branchProtection: { updatedToGoobersContexts: false, requiredChecks: ['ci'] } },
      'branch-protection-not-updated',
    ],
    [
      { branchProtection: { updatedToGoobersContexts: true, requiredChecks: [] } },
      'branch-protection-not-updated',
    ],
  ];
  for (const [overrides, blocker] of cases) {
    assert.deepEqual(
      decideLegacyDecommission({ state: readyState(overrides), now: NOW }).blockers,
      [blocker],
    );
  }
});

test('the committed evidence record is valid and is not yet ready', () => {
  // Phase 4 removal is data-gated. This asserts the record parses through the
  // real decision (never `invalid-state`) while honestly reporting the work
  // that has not happened yet.
  const decision = decideLegacyDecommission({ state: committedState, now: NOW });
  assert.equal(decision.ready, false);
  assert.ok(!decision.blockers.includes('invalid-state'));
  assert.ok(decision.blockers.includes('soak-not-started'));
});

test('every live legacy mutation path is gated on its own lane selector', () => {
  const result = evaluateLegacyMutationSurface({
    workflows: readWorkflows(),
    state: committedState,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
  // Each registered workflow must still carry at least one gated mutation step,
  // because no lane has migrated yet.
  for (const entry of result.entries) {
    assert.equal(entry.present, true, `${entry.workflow} missing`);
    assert.ok(entry.mutationSteps > 0, `${entry.workflow} has no legacy mutation step`);
  }
});

test('an ungated legacy mutation step is reported as a dual-writer risk', () => {
  const workflows = readWorkflows();
  const gate = legacyLaneGateExpression('LIFECYCLE_OWNER_MERGE_TRAIN');
  workflows['merge-train.yml'] = workflows['merge-train.yml'].replaceAll(
    `${gate} && steps.train-gate.outputs.enabled == 'true'`,
    "steps.train-gate.outputs.enabled == 'true'",
  );
  const result = evaluateLegacyMutationSurface({ workflows, state: committedState });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'ungated-legacy-mutation'));
});

test('deleting a legacy mutation path while its lane is legacy-owned is reported', () => {
  const workflows = readWorkflows();
  delete workflows['merge-train.yml'];
  const legacyOwned = evaluateLegacyMutationSurface({ workflows, state: committedState });
  assert.deepEqual(
    legacyOwned.findings.map((finding) => finding.kind),
    ['decommissioned-without-migration'],
  );

  // Once the lane genuinely belongs to Goobers, the same removal is expected.
  const migrated = evaluateLegacyMutationSurface({
    workflows,
    state: { ...committedState, lanes: { ...committedState.lanes, 'merge-train': 'goobers' } },
  });
  assert.deepEqual(migrated.findings, []);
  assert.equal(migrated.entries.find((entry) => entry.lane === 'merge-train').decommissioned, true);
});

test('an unparseable workflow is a finding, not a crash', () => {
  const result = evaluateLegacyMutationSurface({
    workflows: { 'merge-train.yml': 'jobs:\n  - : [' },
    state: committedState,
  });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.kind === 'unparseable-workflow'));
  // Unreadable is never evidence of removal, and entry shape stays consistent.
  const entry = result.entries.find((candidate) => candidate.workflow === 'merge-train.yml');
  assert.equal(entry.decommissioned, false);
  for (const candidate of result.entries) {
    assert.equal(typeof candidate.decommissioned, 'boolean');
  }
});

test('the CLI rejects flags passed without a usable value instead of coercing them', () => {
  const cli = path.join(repoRoot, '.github/scripts/lifecycle-decommission.mjs');
  const run = (...argv) => spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' });

  for (const argv of [
    ['--state'],
    ['--soak-days', 'abc'],
    ['--soak-days', '0'],
    ['--now', 'nope'],
    // `--flag=value` must validate identically, not be silently ignored.
    ['--soak-days=abc'],
    ['--state='],
  ]) {
    const result = run(...argv);
    assert.equal(result.status, 2, `${argv.join(' ')} must fail closed`);
    assert.match(result.stderr, /requires a valid value/);
  }

  const missingState = run('--state', 'does/not/exist.json');
  assert.equal(missingState.status, 2);
  assert.match(missingState.stderr, /unreadable decommission evidence/);

  const ok = run();
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /"ready": false/);

  // A valid `--flag=value` override is honored, not ignored.
  const override = run('--soak-days=30', '--now=2026-10-01T00:00:00.000Z');
  assert.equal(override.status, 0);
  assert.match(override.stdout, /"requiredDays": 30/);
});

test('equivalent lane gates are accepted; a missing clause is not', () => {
  const selector = 'LIFECYCLE_OWNER_MERGE_TRAIN';
  const accepted = [
    legacyLaneGateExpression(selector),
    `vars.${selector} != "goobers" && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == "true"`,
    `'goobers' != vars.${selector} && 'true' == vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED`,
    `always() && vars.${selector}   !=   'goobers'\n && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'`,
  ];
  for (const gate of accepted) {
    assert.ok(laneGateSatisfied(gate, selector), `should accept: ${gate}`);
  }

  const rejected = [
    '',
    undefined,
    `vars.${selector} != 'goobers'`,
    "vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'",
    `vars.${selector} == 'goobers' && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'`,
    // Another lane's selector must never satisfy this lane's gate.
    "vars.LIFECYCLE_OWNER_CI_RECOVERY != 'goobers' && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'",
    // The claim-lane selector is not a PR-lifecycle lane gate.
    "vars.LIFECYCLE_MUTATION_OWNER != 'goobers' && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'",
  ];
  for (const gate of rejected) {
    assert.equal(laneGateSatisfied(gate, selector), false, `should reject: ${gate}`);
  }
});

test('the branch-update entrypoint matches a real PUT, not a mention of the endpoint', () => {
  const workflows = readWorkflows();
  workflows['auto-rebase-prs.yml'] = [
    'jobs:',
    '  rebase:',
    '    steps:',
    '      - name: Talk about update-branch without calling it',
    '        run: echo "we used to call repos/o/r/pulls/1/update-branch here"',
  ].join('\n');
  const result = evaluateLegacyMutationSurface({
    workflows,
    state: { ...committedState, lanes: { ...committedState.lanes, 'branch-update': 'goobers' } },
  });
  const entry = result.entries.find((candidate) => candidate.lane === 'branch-update');
  assert.equal(entry.mutationSteps, 0);
  assert.deepEqual(result.findings, []);
});
