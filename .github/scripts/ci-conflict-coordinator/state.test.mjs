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
  ciFilesFor,
  clusterPullRequests,
  dispatchKey,
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

test('CI scope covers workflows, scripts, actions, and agent automation', () => {
  assert.deepEqual(
    ciFilesFor([
      '.github/workflows/ci.yml',
      '.github/scripts/recover.mjs',
      '.github/actions/setup/action.yml',
      'scripts/agent/verify-fast.sh',
      'src/game/ignored.ts',
    ]),
    [
      '.github/actions/setup/action.yml',
      '.github/scripts/recover.mjs',
      '.github/workflows/ci.yml',
      'scripts/agent/verify-fast.sh',
    ],
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
    makePull(2, ['.github/workflows/ci.yml', 'scripts/agent/preflight.sh']),
    makePull(3, ['scripts/agent/preflight.sh']),
    makePull(4, ['.github/scripts/unrelated.mjs']),
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
