import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeState as makeRecoveryState } from '../ci-recovery/state.mjs';
import {
  CI_CONFLICT_ORDER_WAIT_LABEL,
  queueEntries,
  shouldWaitForCiConflictOrder,
} from '../merge-train/state.mjs';
import {
  bindProofToLeader,
  buildSupersessionProofs,
  duplicateProofStillMatches,
} from './proof.mjs';
import {
  COORDINATOR_MARKER,
  DISPATCH_LEASE_MS,
  MAX_OVERLAP_FILES,
  changeStatsFromFiles,
  ciFilesFor,
  clusterPullRequests,
  coordinationEnforcementEnabled,
  discoverCoordinationClusters,
  dispatchKey,
  hasHealthyRecoveryOwner,
  hasHealthyShepherdLease,
  isCoordinatorStateSemanticallyEqual,
  makeCoordinatorState,
  mergeCoordinationGroups,
  parseCoordinatorComment,
  rankPullRequests,
  renderCoordinatorComment,
  selectCoordination,
  shouldDispatchActiveSlot,
} from './state.mjs';

const repository = 'nalfeo/Crawler';

function makePull(number, files, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    draft: false,
    createdAt: `2026-07-${String(number).padStart(2, '0')}T00:00:00Z`,
    additions: 10,
    deletions: 2,
    changedFiles: files.length,
    headSha: String(number).padStart(40, '0'),
    ciFiles: ciFilesFor(files),
    green: false,
    ...overrides,
  };
}

test('CI scope is limited to workflows and ci-prefixed script directories', () => {
  assert.deepEqual(
    ciFilesFor([
      '.github/workflows/ci.yml',
      '.github/scripts/ci-recovery/reconcile.mjs',
      '.github/scripts/ci-conflict-coordinator/state.mjs',
      '.github/scripts/ci-recovery.mjs',
      '.github/scripts/merge-train/reconcile.mjs',
      '.github/actions/setup/action.yml',
      'scripts/agent/verify-fast.sh',
      'src/game/ignored.ts',
    ]),
    [
      '.github/scripts/ci-conflict-coordinator/state.mjs',
      '.github/scripts/ci-recovery/reconcile.mjs',
      '.github/workflows/ci.yml',
    ],
  );
});

test('change stats derive from per-file inventory', () => {
  assert.deepEqual(
    changeStatsFromFiles([
      { filename: '.github/workflows/ci.yml', additions: 7, deletions: 2 },
      { filename: '.github/scripts/reconcile.mjs', additions: 3, deletions: 5 },
      { filename: '.github/actions/setup/action.yml' },
    ]),
    { additions: 10, deletions: 7, changedFiles: 3 },
  );
});

test('cluster threshold excludes two PRs and includes three', () => {
  const two = [
    makePull(1, ['.github/workflows/ci.yml']),
    makePull(2, ['.github/workflows/ci.yml']),
  ];
  assert.deepEqual(clusterPullRequests(two), []);
  const clusters = clusterPullRequests([...two, makePull(3, ['.github/workflows/ci.yml'])]);
  assert.deepEqual(
    clusters.map((cluster) => cluster.map((pull) => pull.number)),
    [[1, 2, 3]],
  );
});

test('overlap clusters are transitive across different CI files', () => {
  const clusters = clusterPullRequests([
    makePull(1, ['.github/workflows/ci.yml']),
    makePull(2, ['.github/workflows/ci.yml', '.github/scripts/ci-recovery/reconcile.mjs']),
    makePull(3, ['.github/scripts/ci-recovery/reconcile.mjs']),
    makePull(4, ['.github/scripts/merge-train/reconcile.mjs']),
  ]);
  assert.deepEqual(
    clusters.map((cluster) => cluster.map((pull) => pull.number)),
    [[1, 2, 3]],
  );
});

test('leader ranking prefers green, then completeness, then oldest', () => {
  const ranked = rankPullRequests([
    makePull(1, ['.github/workflows/ci.yml'], { green: false, createdAt: '2026-07-01T00:00:00Z' }),
    makePull(2, ['.github/workflows/ci.yml'], { green: true, createdAt: '2026-07-03T00:00:00Z' }),
    makePull(3, ['.github/workflows/ci.yml', '.github/scripts/a.mjs'], {
      green: true,
      createdAt: '2026-07-04T00:00:00Z',
    }),
    makePull(4, ['.github/workflows/ci.yml', '.github/scripts/a.mjs'], {
      green: true,
      createdAt: '2026-07-02T00:00:00Z',
    }),
  ]);
  assert.deepEqual(
    ranked.map((pull) => pull.number),
    [4, 3, 2, 1],
  );
});

test('managed groups dissolve after open membership falls below three', () => {
  const pulls = [
    makePull(1, ['.github/workflows/ci.yml']),
    makePull(2, ['.github/workflows/ci.yml']),
  ];
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-existing',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: pulls,
    proofs: pulls.map((pull) => ({
      number: pull.number,
      status: 'applied',
      fingerprint: pull.headSha,
      representedBy: [],
    })),
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-20T00:00:00Z',
  });

  const groups = mergeCoordinationGroups({
    discoveredClusters: [],
    existingStates: [state],
    openPulls: pulls,
  });
  assert.deepEqual(groups, []);
});

test('persisted groups dissolve when surviving open members fall below threshold', () => {
  const eligible = makePull(1, ['.github/workflows/ci.yml']);
  const outOfScope = makePull(2, ['src/game/ignored.ts']);
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-existing',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: [eligible, outOfScope],
    proofs: [],
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-20T00:00:00Z',
  });
  const groups = mergeCoordinationGroups({
    discoveredClusters: [],
    existingStates: [state],
    openPulls: [eligible, outOfScope],
  });

  assert.deepEqual(groups, []);
});

test('persisted groups disappear when every open member becomes out of scope', () => {
  const pulls = [makePull(1, ['src/game/one.ts']), makePull(2, ['scripts/agent/two.mjs'])];
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-existing',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: pulls,
    proofs: [],
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-20T00:00:00Z',
  });

  assert.deepEqual(
    mergeCoordinationGroups({
      discoveredClusters: [],
      existingStates: [state],
      openPulls: pulls,
    }),
    [],
  );
});

test('fresh two-PR overlap stays below threshold without persisted managed state', () => {
  const pulls = [
    makePull(3, ['.github/workflows/ci.yml']),
    makePull(4, ['.github/workflows/ci.yml']),
  ];
  assert.deepEqual(discoverCoordinationClusters(pulls, []), []);
});

test('stale managed history does not re-promote a fresh two-PR overlap', () => {
  const pulls = [
    makePull(3, ['.github/workflows/ci.yml']),
    makePull(4, ['.github/workflows/ci.yml']),
  ];
  const state = makeCoordinatorState({
    prNumber: 3,
    groupId: 'ci-conflict-existing',
    originalMembers: [1, 2, 3],
    leaderNumber: 3,
    activeNumber: 3,
    order: [pulls[0]],
    proofs: [
      {
        number: 3,
        status: 'applied',
        fingerprint: pulls[0].headSha,
        representedBy: [],
      },
    ],
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-20T00:00:00Z',
  });
  assert.deepEqual(discoverCoordinationClusters(pulls, [state]), []);
});

test('coordinator state comment is parseable and semantic updates are idempotent', () => {
  const pulls = [makePull(1, ['.github/workflows/ci.yml'])];
  const base = {
    prNumber: 1,
    groupId: 'ci-conflict-idempotent',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: pulls,
    proofs: [{ number: 1, status: 'applied', fingerprint: 'a'.repeat(64), representedBy: [] }],
    overlapFiles: ['.github/workflows/ci.yml'],
    escalations: [],
  };
  const left = makeCoordinatorState({ ...base, updatedAt: '2026-07-20T00:00:00Z' });
  const right = makeCoordinatorState({ ...base, updatedAt: '2026-07-20T00:05:00Z' });
  const body = renderCoordinatorComment(left);
  assert.match(body, new RegExp(COORDINATOR_MARKER));
  assert.deepEqual(parseCoordinatorComment(body), left);
  assert.equal(isCoordinatorStateSemanticallyEqual(left, right), true);
});

test('renderCoordinatorComment labels unenforced coordination as advisory without ordering claims', () => {
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-advisory',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: [makePull(1, ['.github/workflows/ci.yml'])],
    proofs: [],
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-20T00:00:00Z',
  });

  const body = renderCoordinatorComment(state, { enforcementEnabled: false });

  assert.match(body, /Advisory CI-overlap analysis; enforcement disabled/);
  assert.doesNotMatch(body, /Canonical leader/);
  assert.doesNotMatch(body, /Active merge-train slot/);
  assert.doesNotMatch(body, /Explicit merge order/);
});

test('healthy shepherd lease suppresses ordered recovery dispatch', () => {
  const active = makePull(7, ['.github/workflows/ci.yml']);
  const key = dispatchKey({
    groupId: 'ci-conflict-lease',
    active,
    baseSha: 'a'.repeat(40),
    order: [active],
  });
  const recoveryState = makeRecoveryState({
    prNumber: 7,
    headSha: active.headSha,
    fingerprint: 'f'.repeat(64),
    owner: 'shepherd',
    status: 'active',
    leaseId: 'lease-7',
    updatedAt: '2026-07-20T00:00:00Z',
  });
  assert.equal(
    shouldDispatchActiveSlot({
      recoveryState,
      prNumber: 7,
      priorDispatchKey: null,
      nextKey: key,
      now: new Date('2026-07-20T00:10:00Z'),
    }),
    false,
  );
});

// Regression: 2026-07-27 merge-train outage. The coordinator's active-slot fence
// used hasHealthyRecoveryOwner, which is true for ordinary automation ownership.
// Since the coordinator dispatches that automation itself, the active slot became
// permanently unsafe, activeNumber stuck at null, and a 12-PR cluster with a clean
// leader could never promote. Only a live shepherd lease may fence the slot. #2095
test('routine automation ownership does not count as a shepherd lease (active-slot fence)', () => {
  const active = makePull(7, ['.github/workflows/ci.yml']);
  const recoveryState = makeRecoveryState({
    prNumber: 7,
    headSha: active.headSha,
    fingerprint: 'f'.repeat(64),
    owner: 'automation',
    status: 'dispatched',
    updatedAt: '2026-07-20T00:00:00Z',
  });
  const now = new Date('2026-07-20T00:05:00Z');
  // Still a healthy owner for dispatch-suppression purposes...
  assert.equal(
    hasHealthyRecoveryOwner({ prNumber: 7, recoveryState, headSha: active.headSha, now }),
    true,
  );
  // ...but it must NOT fence the active slot.
  assert.equal(hasHealthyShepherdLease({ prNumber: 7, recoveryState, now }), false);
});

test('live shepherd lease still fences the active slot', () => {
  const active = makePull(7, ['.github/workflows/ci.yml']);
  const recoveryState = makeRecoveryState({
    prNumber: 7,
    headSha: active.headSha,
    fingerprint: 'f'.repeat(64),
    owner: 'shepherd',
    status: 'active',
    leaseId: 'lease-7',
    updatedAt: '2026-07-20T00:00:00Z',
  });
  assert.equal(
    hasHealthyShepherdLease({
      prNumber: 7,
      recoveryState,
      now: new Date('2026-07-20T00:10:00Z'),
    }),
    true,
  );
});

test('stale-head automation owner does not suppress ordered recovery dispatch', () => {
  const active = makePull(7, ['.github/workflows/ci.yml']);
  const key = dispatchKey({
    groupId: 'ci-conflict-automation-head',
    active,
    baseSha: 'a'.repeat(40),
    order: [active],
  });
  const recoveryState = makeRecoveryState({
    prNumber: 7,
    headSha: 'f'.repeat(40),
    fingerprint: 'f'.repeat(64),
    owner: 'automation',
    status: 'active',
    blockers: [],
    progressAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
  });
  assert.equal(
    hasHealthyRecoveryOwner({
      prNumber: 7,
      recoveryState,
      headSha: active.headSha,
      now: new Date('2026-07-20T00:10:00Z'),
    }),
    false,
  );
  assert.equal(
    shouldDispatchActiveSlot({
      recoveryState,
      headSha: active.headSha,
      prNumber: 7,
      priorDispatchKey: null,
      nextKey: key,
      now: new Date('2026-07-20T00:10:00Z'),
    }),
    true,
  );
});

test('expired dispatch lease allows retry when no healthy owner (lost-run regression)', () => {
  const active = makePull(7, ['.github/workflows/ci.yml']);
  const key = dispatchKey({
    groupId: 'ci-conflict-lost-run',
    active,
    baseSha: 'a'.repeat(40),
    order: [active],
  });
  // No recovery state written: run was cancelled before ci-recovery could record anything
  const dispatchedAt = '2026-07-20T00:00:00Z';
  // Within lease window: suppressed even with same key and no recovery state
  assert.equal(
    shouldDispatchActiveSlot({
      recoveryState: null,
      headSha: active.headSha,
      prNumber: 7,
      priorDispatchKey: key,
      nextKey: key,
      lastDispatchAt: dispatchedAt,
      now: new Date('2026-07-20T00:15:00Z'), // 15 min — within 30 min lease
    }),
    false,
  );
  // After lease expires: retry is allowed
  assert.equal(
    shouldDispatchActiveSlot({
      recoveryState: null,
      headSha: active.headSha,
      prNumber: 7,
      priorDispatchKey: key,
      nextKey: key,
      lastDispatchAt: dispatchedAt,
      now: new Date('2026-07-20T00:31:00Z'), // 31 min — lease expired
    }),
    true,
  );
  // Verify DISPATCH_LEASE_MS is 30 minutes
  assert.equal(DISPATCH_LEASE_MS, 30 * 60 * 1000);
});

test('same dispatch key without lastDispatchAt does not retry (legacy state)', () => {
  const active = makePull(8, ['.github/workflows/ci.yml']);
  const key = dispatchKey({
    groupId: 'ci-conflict-legacy',
    active,
    baseSha: 'b'.repeat(40),
    order: [active],
  });
  // Legacy state has no lastDispatchAt — same key suppresses without a lease check
  assert.equal(
    shouldDispatchActiveSlot({
      recoveryState: null,
      headSha: active.headSha,
      prNumber: 8,
      priorDispatchKey: key,
      nextKey: key,
      lastDispatchAt: null,
      now: new Date('2026-07-20T02:00:00Z'), // 2 hours later — would be expired if lastDispatchAt were set
    }),
    false,
  );
});

test('merge train excludes order-wait PRs', () => {
  const pull = {
    number: 1,
    state: 'open',
    draft: false,
    created_at: '2026-07-01T00:00:00Z',
    base: { ref: 'main' },
    head: { repo: { full_name: repository } },
    labels: [{ name: 'merge-train' }, { name: CI_CONFLICT_ORDER_WAIT_LABEL }],
  };
  assert.equal(shouldWaitForCiConflictOrder(pull.labels), true);
  assert.deepEqual(queueEntries([pull], repository), []);
});

test('CI recovery is wired to stop at the conflict order fence', () => {
  const source = readFileSync(path.resolve('.github/scripts/ci-recovery/reconcile.mjs'), 'utf8');
  assert.match(source, /shouldWaitForCiConflictOrder\(pr\.labels\)/);
  assert.match(source, /reason=ci-conflict-order-wait/);
  assert.ok(
    source.indexOf("release('expired-shepherd-lease')") <
      source.indexOf('shouldWaitForCiConflictOrder(pr.labels)'),
  );
  assert.match(
    source,
    /mergeTrainEnabled\s*&&\s*!pendingHumanApproval\s*&&\s*shouldWaitForCiConflictOrder\(pr\.labels\)/,
  );
});

test('coordinator inventories rename previous_filename paths for overlap clustering', () => {
  const source = readFileSync(
    path.resolve('.github/scripts/ci-conflict-coordinator/reconcile.mjs'),
    'utf8',
  );
  assert.match(source, /previous_filename/);
});

test('coordinator validates automation ownership against the live PR head', () => {
  const source = readFileSync(
    path.resolve('.github/scripts/ci-conflict-coordinator/reconcile.mjs'),
    'utf8',
  );
  assert.match(source, /headSha:\s*pull\.headSha/);
});

test('grouping-derived labels are drained, not published, while enforcement is off', () => {
  const source = readFileSync(
    path.resolve('.github/scripts/ci-conflict-coordinator/reconcile.mjs'),
    'utf8',
  );
  // The unenforced branch must REMOVE (not merely omit) every grouping-derived
  // label, so labels stranded by an earlier enforcing run drain without a manual
  // cleanup pass. The grouping predicate keys on CI-filename identity rather than
  // any real conflict test (issue #2180), so publishing them marks PRs that do not
  // conflict as conflict-managed.
  const unenforced = source.slice(source.indexOf('Unenforced (the default)'));
  assert.match(unenforced, /removeLabel\(pull, ORDER_WAIT_LABEL\)/);
  assert.match(unenforced, /removeLabel\(pull, COORDINATED_LABEL\)/);
  assert.match(unenforced, /removeLabel\(pull, LEADER_LABEL\)/);

  // Selection-binding drift is group-derived. Escalating on it while unenforced
  // would re-apply the label the member loop just drained and would withhold
  // CI-recovery dispatch from PRs that are not actually blocked, so that
  // escalation must stay gated behind enforcement.
  const driftBlock = source.slice(
    source.indexOf('selectionBindingDrift = bindingCheck.reason'),
    source.indexOf('const priorStates'),
  );
  assert.match(driftBlock, /if \(enforceCoordination\) \{/);
  assert.ok(
    driftBlock.indexOf('if (enforceCoordination) {') <
      driftBlock.indexOf('addLabel(pull, ESCALATION_LABEL)'),
    'binding-drift escalation must be gated behind enforcement',
  );

  // Groups whose members are all non-blocking return early, before the member
  // loop, and stay in groupedNumbers, so the orphan drain never sees them. They
  // must reconcile their own labels or those labels strand forever.
  const nonBlockingBlock = source.slice(
    source.indexOf('reason=all-pulls-non-blocking') - 900,
    source.indexOf('reason=all-pulls-non-blocking'),
  );
  assert.match(nonBlockingBlock, /removeLabel\(pull, ORDER_WAIT_LABEL\)/);
  assert.match(nonBlockingBlock, /removeLabel\(pull, COORDINATED_LABEL\)/);
  assert.match(nonBlockingBlock, /removeLabel\(pull, LEADER_LABEL\)/);
});
test('coordinator only trusts recovery state comments from trusted authors', () => {
  const source = readFileSync(
    path.resolve('.github/scripts/ci-conflict-coordinator/reconcile.mjs'),
    'utf8',
  );
  assert.match(source, /TRUSTED_ASSOCIATIONS/);
  assert.match(source, /TRUSTED_BOT_LOGINS/);
  assert.match(source, /requireTrustedAuthor:\s*true/);
});

test('coordinator claims owner fence and disables auto-merge for every grouped member', () => {
  const source = readFileSync(
    path.resolve('.github/scripts/ci-conflict-coordinator/reconcile.mjs'),
    'utf8',
  );
  assert.match(source, /claimOwnerFence\(proof\.number\)/);
  assert.match(source, /released orphaned coordinator labels/);
  assert.match(source, /await disableAutoMerge\(pull\);/);
  assert.ok(
    !source.includes('if (pull.number !== selection.active?.number) await disableAutoMerge(pull);'),
  );
});

test('post-close proof guard revalidates the duplicate PR head before leaving it closed', () => {
  const source = readFileSync(
    path.resolve('.github/scripts/ci-conflict-coordinator/reconcile.mjs'),
    'utf8',
  );
  assert.match(source, /fetchLivePull\(proof\.number\)/);
  assert.match(source, /postTarget\?\.head\?\.sha !== proof\.targetHead/);
  assert.match(source, /postTarget\?\.base\?\.ref !== BASE_REF/);
});

test('coordinator remains event-driven while liveness cadence moves to ci-liveness-sweep', () => {
  const coordinatorWorkflow = readFileSync(
    path.resolve('.github/workflows/ci-conflict-coordinator.yml'),
    'utf8',
  );
  const livenessWorkflow = readFileSync(
    path.resolve('.github/workflows/ci-liveness-sweep.yml'),
    'utf8',
  );
  assert.match(
    coordinatorWorkflow,
    /types:\s*\[opened, reopened, synchronize, ready_for_review, closed\]/,
  );
  assert.match(coordinatorWorkflow, /workflow_run:\s*\r?\n\s+workflows:\s*\['CI'\]/);
  assert.doesNotMatch(coordinatorWorkflow, /cron:/);
  assert.match(coordinatorWorkflow, /group:\s*crawler-ci-conflict-coordinator/);
  assert.match(livenessWorkflow, /cron:\s*'\*\/10 \* \* \* \*'/);
  assert.match(livenessWorkflow, /workflow_id:\s*'ci-conflict-coordinator\.yml'/);
  assert.match(livenessWorkflow, /workflow_id:\s*'ci-recovery-router\.yml'/);
});

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(options.env || {}) },
  }).trim();
}

function commit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

test('main-alone supersession has empty predecessorHeads (safe to close)', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'crawler-ci-conflict-'));
  try {
    git(cwd, ['init', '--initial-branch=main']);
    mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: base\n');
    const baseSha = commit(cwd, 'base');

    // Advance main with the same change the PR will propose
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: new\n');
    const mainSha = commit(cwd, 'main-advance');

    // PR branch that proposes the same change (already in main)
    git(cwd, ['checkout', '-b', 'pr-branch', baseSha]);
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: new\n');
    const prSha = commit(cwd, 'pr');

    const gitRunner = (args, options) => git(cwd, args, options);
    const proofs = buildSupersessionProofs({
      baseSha: mainSha,
      entries: [{ number: 1, headSha: prSha, ref: prSha }],
      git: gitRunner,
    });

    assert.equal(proofs[0].status, 'superseded');
    // No predecessor dependency — this PR is a no-op against main alone and is safe to close.
    assert.equal(proofs[0].predecessorHeads.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('predecessor-dependent supersession has non-empty predecessorHeads (retain until predecessor lands)', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'crawler-ci-conflict-'));
  try {
    git(cwd, ['init', '--initial-branch=main']);
    mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: base\n');
    const baseSha = commit(cwd, 'base');

    // Leader PR
    git(cwd, ['checkout', '-b', 'leader', baseSha]);
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: leader\n');
    const leaderSha = commit(cwd, 'leader');

    // Duplicate PR that proposes the same change as leader (but leader is still open, not in main)
    git(cwd, ['checkout', '-b', 'duplicate', baseSha]);
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: leader\n');
    const duplicateSha = commit(cwd, 'duplicate');

    const gitRunner = (args, options) => git(cwd, args, options);
    const proofs = buildSupersessionProofs({
      baseSha,
      entries: [
        { number: 1, headSha: leaderSha, ref: leaderSha },
        { number: 2, headSha: duplicateSha, ref: duplicateSha },
      ],
      git: gitRunner,
    });

    assert.equal(proofs[1].status, 'superseded');
    // Has predecessor dependency — closing now would risk permanent change loss if leader is
    // force-pushed or closed without merging. Must retain until predecessor lands on main.
    assert.equal(proofs[1].predecessorHeads.length, 1);
    assert.equal(proofs[1].predecessorHeads[0].number, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('full-tree proof preserves unique changes, closes only no-ops, and escalates conflicts', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'crawler-ci-conflict-'));
  try {
    git(cwd, ['init', '--initial-branch=main']);
    mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: base\n');
    const baseSha = commit(cwd, 'base');

    git(cwd, ['checkout', '-b', 'leader', baseSha]);
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: leader\n');
    const leaderSha = commit(cwd, 'leader');

    git(cwd, ['checkout', '-b', 'duplicate', baseSha]);
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: leader\n');
    const duplicateSha = commit(cwd, 'duplicate');

    git(cwd, ['checkout', '-b', 'unique', baseSha]);
    mkdirSync(path.join(cwd, '.github', 'scripts'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.github', 'scripts', 'unique.mjs'),
      'export const unique = true;\n',
    );
    const uniqueSha = commit(cwd, 'unique');

    git(cwd, ['checkout', '-b', 'ambiguous', baseSha]);
    writeFileSync(path.join(cwd, '.github', 'workflows', 'ci.yml'), 'value: ambiguous\n');
    const ambiguousSha = commit(cwd, 'ambiguous');

    const gitRunner = (args, options) => git(cwd, args, options);
    const entries = [
      { number: 1, headSha: leaderSha, ref: leaderSha },
      { number: 2, headSha: duplicateSha, ref: duplicateSha },
      { number: 3, headSha: uniqueSha, ref: uniqueSha },
      { number: 4, headSha: ambiguousSha, ref: ambiguousSha },
    ];
    const initial = buildSupersessionProofs({ baseSha, entries, git: gitRunner });
    const leader = { number: 1, headSha: leaderSha };
    const proofs = initial.map((proof) => bindProofToLeader(proof, leader));
    assert.deepEqual(
      proofs.map((proof) => proof.status),
      ['applied', 'superseded', 'applied', 'ambiguous'],
    );
    assert.deepEqual(proofs[1].representedBy, [1]);
    const ranked = entries.map((entry) =>
      makePull(entry.number, ['.github/workflows/ci.yml'], { headSha: entry.headSha }),
    );
    const selection = selectCoordination({ rankedPulls: ranked, proofs });
    assert.deepEqual(
      selection.ordered.map((pull) => pull.number),
      [1, 3, 4],
    );
    assert.deepEqual(
      selection.duplicates.map((pull) => pull.number),
      [2],
    );
    assert.deepEqual(
      selection.ambiguous.map((pull) => pull.number),
      [4],
    );

    const livePulls = new Map(
      entries.map((entry) => [
        entry.number,
        {
          number: entry.number,
          state: 'open',
          draft: false,
          base: { ref: 'main' },
          head: { sha: entry.headSha, repo: { full_name: repository } },
        },
      ]),
    );
    assert.equal(
      duplicateProofStillMatches({
        proof: proofs[1],
        mainSha: baseSha,
        livePulls,
        repository,
      }),
      true,
    );
    livePulls.get(1).head.sha = 'f'.repeat(40);
    assert.equal(
      duplicateProofStillMatches({
        proof: proofs[1],
        mainSha: baseSha,
        livePulls,
        repository,
      }),
      false,
    );
    assert.equal(
      duplicateProofStillMatches({
        proof: proofs[3],
        mainSha: baseSha,
        livePulls,
        repository,
      }),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('renderCoordinatorComment stays below GitHub comment limit with many overlap files', () => {
  // Build 200 distinct CI paths — well above the MAX_OVERLAP_FILES cap of 20.
  const manyFiles = Array.from(
    { length: 200 },
    (_, index) => `.github/workflows/workflow-${String(index).padStart(3, '0')}.yml`,
  );
  const pull = makePull(1, manyFiles);
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-size-test',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: [pull],
    proofs: [{ number: 1, status: 'applied', fingerprint: 'a'.repeat(64), representedBy: [] }],
    overlapFiles: manyFiles,
    updatedAt: '2026-07-20T00:00:00Z',
  });

  // makeCoordinatorState must truncate to MAX_OVERLAP_FILES.
  assert.equal(state.overlapFiles.length, MAX_OVERLAP_FILES);
  assert.equal(state.overlapFilesCount, 200);

  const body = renderCoordinatorComment(state);

  // Must stay below the GitHub 65 536-character comment cap.
  assert.ok(
    body.length < 65_536,
    `expected comment below GitHub limit, got ${body.length} characters`,
  );
  // The "…and N more" note must be present because files were truncated.
  const hiddenCount = 200 - MAX_OVERLAP_FILES;
  assert.ok(
    body.includes(`…and ${hiddenCount} more`),
    `expected "…and ${hiddenCount} more" in rendered comment`,
  );
  // Only MAX_OVERLAP_FILES file lines should appear (no raw overflow).
  const fileLines = body.split('\n').filter((line) => line.match(/^- `\.github\/workflows\//));
  assert.equal(fileLines.length, MAX_OVERLAP_FILES);
});

test('renderCoordinatorComment round-trips overlapFilesCount through parse', () => {
  const manyFiles = Array.from(
    { length: 50 },
    (_, index) => `.github/workflows/w-${String(index).padStart(2, '0')}.yml`,
  );
  const state = makeCoordinatorState({
    prNumber: 2,
    groupId: 'ci-conflict-roundtrip',
    originalMembers: [2, 3, 4],
    leaderNumber: 2,
    activeNumber: 2,
    order: [makePull(2, manyFiles)],
    proofs: [{ number: 2, status: 'applied', fingerprint: 'b'.repeat(64), representedBy: [] }],
    overlapFiles: manyFiles,
    updatedAt: '2026-07-20T00:01:00Z',
  });
  const body = renderCoordinatorComment(state);
  const parsed = parseCoordinatorComment(body);
  assert.equal(parsed.overlapFilesCount, 50);
  assert.equal(parsed.overlapFiles.length, MAX_OVERLAP_FILES);
  // "…and N more" must be rendered for the truncated portion.
  const hiddenCount = 50 - MAX_OVERLAP_FILES;
  assert.ok(body.includes(`…and ${hiddenCount} more`));
});

test('coordination enforcement defaults to OFF (discovery-only)', () => {
  // The fence is a pessimistic lock with ~100:1 asymmetric cost, so absence of
  // the flag must mean "do not serialize" rather than "serialize".
  assert.equal(coordinationEnforcementEnabled({}), false);
  assert.equal(
    coordinationEnforcementEnabled({ CI_CONFLICT_COORDINATION_ENFORCE: undefined }),
    false,
  );
  assert.equal(coordinationEnforcementEnabled({ CI_CONFLICT_COORDINATION_ENFORCE: '' }), false);
  assert.equal(coordinationEnforcementEnabled(null), false);
  assert.equal(coordinationEnforcementEnabled(undefined), false);
});

test('coordination enforcement is enabled only by an exact "1"', () => {
  assert.equal(coordinationEnforcementEnabled({ CI_CONFLICT_COORDINATION_ENFORCE: '1' }), true);
  // Surrounding whitespace from workflow YAML interpolation must still enable it.
  assert.equal(coordinationEnforcementEnabled({ CI_CONFLICT_COORDINATION_ENFORCE: ' 1 ' }), true);
});

test('coordination enforcement rejects truthy-looking non-"1" values', () => {
  // Fail OPEN: anything ambiguous must NOT re-arm the fence, because a false
  // positive stalls an entire overlap group for hours while a false negative
  // costs one rebase plus one parallel CI re-run.
  for (const value of ['true', 'yes', 'on', 'enabled', '0', 'false', '2', '01']) {
    assert.equal(
      coordinationEnforcementEnabled({ CI_CONFLICT_COORDINATION_ENFORCE: value }),
      false,
      `expected ${JSON.stringify(value)} to leave enforcement disabled`,
    );
  }
});
