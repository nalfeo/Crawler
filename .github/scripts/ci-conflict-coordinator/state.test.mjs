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
  SYNTHESIS_LABEL,
  SYNTHESIS_LEASE_MS,
  changeStatsFromFiles,
  ciFilesFor,
  clusterPullRequests,
  computeSynthesisKey,
  discoverCoordinationClusters,
  dispatchKey,
  hasHealthyRecoveryOwner,
  isAllEscalated,
  isCoordinatorStateSemanticallyEqual,
  makeCoordinatorState,
  mergeCoordinationGroups,
  parseCoordinatorComment,
  rankPullRequests,
  renderCoordinatorComment,
  selectCoordination,
  shouldDispatchActiveSlot,
  shouldDispatchSynthesis,
  validateCoordinatorState,
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

test('managed groups continue after open membership falls below three', () => {
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
  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupId, 'ci-conflict-existing');
  assert.deepEqual(
    groups[0].pulls.map((pull) => pull.number),
    [1, 2],
  );
  assert.deepEqual(groups[0].originalMembers, [1, 2, 3]);
});

test('persisted groups drop members that no longer touch coordination paths', () => {
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

  assert.deepEqual(
    groups[0].pulls.map((pull) => pull.number),
    [1],
  );
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

test('managed group can absorb a new two-PR overlap after shrinking below threshold', () => {
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
  assert.deepEqual(
    discoverCoordinationClusters(pulls, [state]).map((cluster) =>
      cluster.map((pull) => pull.number),
    ),
    [[3, 4]],
  );
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

test('workflow is event-driven and has a five-minute scheduling backstop', () => {
  const workflow = readFileSync(
    path.resolve('.github/workflows/ci-conflict-coordinator.yml'),
    'utf8',
  );
  assert.match(workflow, /types:\s*\[opened, reopened, synchronize, ready_for_review, closed\]/);
  assert.match(workflow, /workflow_run:\s*\r?\n\s+workflows:\s*\['CI'\]/);
  assert.match(workflow, /cron:\s*'\*\/5 \* \* \* \*'/);
  assert.match(workflow, /group:\s*crawler-ci-conflict-coordinator/);
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

// ---------------------------------------------------------------------------
// isAllEscalated
// ---------------------------------------------------------------------------

test('isAllEscalated returns false for empty proof array', () => {
  assert.equal(isAllEscalated([]), false);
});

test('isAllEscalated returns false when any proof is applied', () => {
  assert.equal(
    isAllEscalated([
      { status: 'ambiguous' },
      { status: 'applied' },
    ]),
    false,
  );
});

test('isAllEscalated returns false when any proof is superseded', () => {
  assert.equal(
    isAllEscalated([
      { status: 'ambiguous' },
      { status: 'superseded' },
    ]),
    false,
  );
});

test('isAllEscalated returns true when every proof is ambiguous', () => {
  assert.equal(
    isAllEscalated([
      { status: 'ambiguous' },
      { status: 'ambiguous' },
      { status: 'ambiguous' },
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// computeSynthesisKey
// ---------------------------------------------------------------------------

test('computeSynthesisKey is stable for the same inputs', () => {
  const key1 = computeSynthesisKey({
    groupId: 'ci-conflict-abc',
    ambiguousEntries: [
      { number: 10, headSha: 'aaa' },
      { number: 11, headSha: 'bbb' },
    ],
  });
  const key2 = computeSynthesisKey({
    groupId: 'ci-conflict-abc',
    ambiguousEntries: [
      { number: 11, headSha: 'bbb' },
      { number: 10, headSha: 'aaa' },
    ],
  });
  assert.equal(key1, key2, 'entry order must not affect the key');
});

test('computeSynthesisKey changes when a head SHA changes', () => {
  const key1 = computeSynthesisKey({
    groupId: 'ci-conflict-abc',
    ambiguousEntries: [{ number: 10, headSha: 'aaa' }],
  });
  const key2 = computeSynthesisKey({
    groupId: 'ci-conflict-abc',
    ambiguousEntries: [{ number: 10, headSha: 'bbb' }],
  });
  assert.notEqual(key1, key2, 'changed head SHA must produce a different key');
});

test('computeSynthesisKey changes when the group ID changes', () => {
  const entry = [{ number: 10, headSha: 'aaa' }];
  assert.notEqual(
    computeSynthesisKey({ groupId: 'ci-conflict-abc', ambiguousEntries: entry }),
    computeSynthesisKey({ groupId: 'ci-conflict-xyz', ambiguousEntries: entry }),
  );
});

// ---------------------------------------------------------------------------
// shouldDispatchSynthesis
// ---------------------------------------------------------------------------

test('shouldDispatchSynthesis returns false when nextSynthesisKey is null', () => {
  assert.equal(
    shouldDispatchSynthesis({
      priorSynthesisKey: null,
      nextSynthesisKey: null,
      synthesisDispatchAt: null,
      now: new Date('2026-01-01T00:00:00Z'),
    }),
    false,
  );
});

test('shouldDispatchSynthesis returns true on first dispatch (no prior key)', () => {
  assert.equal(
    shouldDispatchSynthesis({
      priorSynthesisKey: null,
      nextSynthesisKey: 'newkey',
      synthesisDispatchAt: null,
      now: new Date('2026-01-01T00:00:00Z'),
    }),
    true,
  );
});

test('shouldDispatchSynthesis returns true when key changed (cluster membership drift)', () => {
  assert.equal(
    shouldDispatchSynthesis({
      priorSynthesisKey: 'oldkey',
      nextSynthesisKey: 'newkey',
      synthesisDispatchAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      now: new Date('2026-01-01T00:01:00Z'),
    }),
    true,
  );
});

test('shouldDispatchSynthesis returns false when key matches and lease is active', () => {
  const dispatched = new Date('2026-01-01T00:00:00Z');
  const now = new Date(dispatched.getTime() + SYNTHESIS_LEASE_MS - 1);
  assert.equal(
    shouldDispatchSynthesis({
      priorSynthesisKey: 'samekey',
      nextSynthesisKey: 'samekey',
      synthesisDispatchAt: dispatched.toISOString(),
      now,
    }),
    false,
  );
});

test('shouldDispatchSynthesis returns true when key matches but lease has expired', () => {
  const dispatched = new Date('2026-01-01T00:00:00Z');
  const now = new Date(dispatched.getTime() + SYNTHESIS_LEASE_MS);
  assert.equal(
    shouldDispatchSynthesis({
      priorSynthesisKey: 'samekey',
      nextSynthesisKey: 'samekey',
      synthesisDispatchAt: dispatched.toISOString(),
      now,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// makeCoordinatorState / validateCoordinatorState with synthesis fields
// ---------------------------------------------------------------------------

test('makeCoordinatorState accepts and round-trips synthesis fields', () => {
  const pull = makePull(1, ['.github/workflows/ci.yml']);
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-synth-test',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: null,
    order: [],
    proofs: [
      { number: 1, status: 'ambiguous', fingerprint: 'a'.repeat(64), representedBy: [], reason: 'conflict' },
      { number: 2, status: 'ambiguous', fingerprint: 'b'.repeat(64), representedBy: [], reason: 'conflict' },
      { number: 3, status: 'ambiguous', fingerprint: 'c'.repeat(64), representedBy: [], reason: 'conflict' },
    ],
    overlapFiles: ['.github/workflows/ci.yml'],
    synthesisDispatchKey: 'testkey',
    synthesisDispatchAt: '2026-07-27T00:00:00Z',
    synthesisIssueNumber: 9999,
    synthesisSupersededPrs: [1, 2, 3],
    updatedAt: '2026-07-27T00:00:00Z',
  });
  assert.equal(state.synthesisDispatchKey, 'testkey');
  assert.equal(state.synthesisDispatchAt, '2026-07-27T00:00:00Z');
  assert.equal(state.synthesisIssueNumber, 9999);
  assert.deepEqual(state.synthesisSupersededPrs, [1, 2, 3]);

  const body = renderCoordinatorComment(state);
  const parsed = parseCoordinatorComment(body);
  assert.equal(parsed.synthesisDispatchKey, 'testkey');
  assert.equal(parsed.synthesisIssueNumber, 9999);
  assert.deepEqual(parsed.synthesisSupersededPrs, [1, 2, 3]);
});

test('makeCoordinatorState defaults synthesis fields to null', () => {
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-no-synth',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: [makePull(1, ['.github/workflows/ci.yml'])],
    proofs: [{ number: 1, status: 'applied', fingerprint: 'a'.repeat(64), representedBy: [] }],
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-27T00:00:00Z',
  });
  assert.equal(state.synthesisDispatchKey, null);
  assert.equal(state.synthesisDispatchAt, null);
  assert.equal(state.synthesisIssueNumber, null);
  assert.equal(state.synthesisSupersededPrs, null);
});

test('validateCoordinatorState rejects invalid synthesisIssueNumber', () => {
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-bad-synth',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: null,
    order: [],
    proofs: [],
    overlapFiles: [],
    updatedAt: '2026-07-27T00:00:00Z',
  });
  // Bypass factory normalisation to inject an invalid value.
  state.synthesisIssueNumber = -1;
  assert.throws(() => validateCoordinatorState(state), /invalid synthesisIssueNumber/);
});

test('renderCoordinatorComment includes synthesis section when synthesisDispatchKey is set', () => {
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-synth-render',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: null,
    order: [],
    proofs: [
      { number: 1, status: 'ambiguous', fingerprint: 'a'.repeat(64), representedBy: [], reason: 'conflict' },
    ],
    overlapFiles: ['.github/workflows/ci.yml'],
    synthesisDispatchKey: 'renderkey123',
    synthesisDispatchAt: '2026-07-27T00:00:00Z',
    synthesisIssueNumber: 42,
    synthesisSupersededPrs: [1, 2, 3],
    updatedAt: '2026-07-27T00:00:00Z',
  });
  const body = renderCoordinatorComment(state);
  assert.ok(body.includes('### Clean-room synthesis'), 'must include synthesis heading');
  assert.ok(body.includes('#42'), 'must include synthesis issue number');
  assert.ok(body.includes('#1, #2, #3'), 'must list superseded PRs');
  assert.ok(body.includes('renderkey123'.slice(0, 12)), 'must include truncated key');
});

test('renderCoordinatorComment omits synthesis section when synthesisDispatchKey is null', () => {
  const state = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-no-synth-render',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: [makePull(1, ['.github/workflows/ci.yml'])],
    proofs: [{ number: 1, status: 'applied', fingerprint: 'a'.repeat(64), representedBy: [] }],
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-27T00:00:00Z',
  });
  const body = renderCoordinatorComment(state);
  assert.ok(!body.includes('Clean-room synthesis'), 'must not include synthesis section');
});

test('SYNTHESIS_LABEL is a non-empty string', () => {
  assert.ok(typeof SYNTHESIS_LABEL === 'string' && SYNTHESIS_LABEL.length > 0);
});

test('SYNTHESIS_LEASE_MS is greater than DISPATCH_LEASE_MS', () => {
  assert.ok(SYNTHESIS_LEASE_MS > DISPATCH_LEASE_MS, 'synthesis lease must outlast the active-slot dispatch lease');
});
