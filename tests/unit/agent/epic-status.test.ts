import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditGithub,
  buildMaterializationPlan,
  EXPECTED_NODE_IDS,
  extractPlanContract,
  validateEpicState,
  type EpicState,
  type GitReader,
  type GithubRunner,
} from '../../../scripts/agent/epics/epic-status-lib';

const REPO_ROOT = process.cwd();
const EPIC_DIR = resolve(REPO_ROOT, 'docs', 'knowledge', 'epics', 'floor-2-equipment');
const PLAN = readFileSync(resolve(EPIC_DIR, 'PLAN.md'), 'utf8');
const STATE = JSON.parse(readFileSync(resolve(EPIC_DIR, 'epic-state.json'), 'utf8')) as EpicState;
const NOW = new Date('2026-07-17T22:00:00.000Z');
const FULL_COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
// Placeholder SHAs used in evidence entries – the working-tree git reader ignores
// the commit parameter and reads from disk, so these only need to be valid SHA-40s.
const HANDOFF_COMMIT = '461b8a334a018ebbf6e81aa7b31f81c74e08aa6b';
const LEDGER_COMMIT = '065591b1717588fd7acdb8e28936946e4a7e63e6';
const TEST_MERGE_COMMIT = HANDOFF_COMMIT;

function sha256OfFile(repoRoot: string, repoRelPath: string): string {
  const content = readFileSync(resolve(repoRoot, repoRelPath), 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A repository-independent GitReader for unit tests: reads evidence files
 * from the current working tree (content matches the recorded sha256 hashes)
 * and treats every commit SHA as present. This avoids any dependency on git
 * history depth, keeping the suite green in shallow CI checkouts.
 */
function makeWorkingTreeGitReader(repoRoot: string): GitReader {
  return {
    showContent(_commit: string, filePath: string): string | null {
      try {
        return readFileSync(resolve(repoRoot, filePath), 'utf8');
      } catch {
        return null;
      }
    },
    commitExists(_commit: string): boolean {
      return true;
    },
  };
}

function cloneState(includeStackedWork = false): EpicState {
  const state = structuredClone(STATE);
  state.nodes[0]!.reconciliation.drift = [];
  state.reconciliation.drift = [];
  if (!includeStackedWork) {
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    if (a1) {
      delete a1.stacked_work;
      a1.github.issue = null;
    }
  }
  return state;
}

function validate(state: EpicState, planMarkdown = PLAN) {
  return validateEpicState(state, {
    repoRoot: REPO_ROOT,
    now: NOW,
    planMarkdown,
    gitReader: makeWorkingTreeGitReader(REPO_ROOT),
  });
}

function validateA0(state: EpicState): void {
  const a0 = state.nodes.find((node) => node.node_id === 'slice:A0');
  expect(a0).toBeDefined();
  if (!a0) return;
  a0.status = 'validated';
  a0.github.pr = {
    number: 1271,
    url: 'https://github.com/nalfeo/Crawler/pull/1271',
    head_sha: FULL_COMMIT,
  };
  a0.ownership = {
    claimant: null,
    session: null,
    source: 'none',
    scope: null,
    claimed_at: null,
    lease_expires_at: null,
    heartbeat_at: null,
    base_commit: null,
  };
  a0.merge = {
    commit: TEST_MERGE_COMMIT,
    merged_at: '2026-07-17T17:50:00.000Z',
  };
  const HANDOFF_PATH = 'docs/knowledge/handoffs/2026-07-17-floor-2-equipment-epic-control.md';
  const LEDGER_PATH =
    'docs/knowledge/review-ledgers/2026-07-17-floor-2-epic-control.review-ledger.json';
  a0.evidence = [
    {
      kind: 'handoff',
      path_or_check: HANDOFF_PATH,
      sha256: sha256OfFile(REPO_ROOT, HANDOFF_PATH),
      commit: HANDOFF_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
    {
      kind: 'review-ledger',
      path_or_check: LEDGER_PATH,
      sha256: sha256OfFile(REPO_ROOT, LEDGER_PATH),
      commit: LEDGER_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
    {
      // Use the handoff file as a stable stand-in for the offline-validator evidence
      // (avoids circular sha256 bootstrap when the test file itself changes).
      kind: 'offline-validator-and-focused-tests',
      path_or_check: HANDOFF_PATH,
      sha256: sha256OfFile(REPO_ROOT, HANDOFF_PATH),
      commit: HANDOFF_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
  ];
}

function stackedFixture(): {
  state: EpicState;
  a0: EpicState['nodes'][number];
  a1: EpicState['nodes'][number];
  stacked: NonNullable<EpicState['nodes'][number]['stacked_work']>;
} {
  const state = cloneState();
  const a0 = state.nodes.find((node) => node.node_id === 'slice:A0');
  const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
  expect(a0).toBeDefined();
  expect(a1).toBeDefined();
  const dependencyHead = a0?.github.pr?.head_sha;
  if (!a0 || !a1 || !dependencyHead) {
    throw new Error('Canonical stacked fixture is incomplete');
  }
  a1.github.issue = {
    number: 1279,
    url: 'https://github.com/nalfeo/Crawler/issues/1279',
  };
  a1.stacked_work = {
    state: 'stacked_pr_open',
    owner: {
      node_id: 'slice:A1',
      issue: a1.github.issue,
      claimant: 'Producer / Systems Engineer',
      session: '6f852b99-3c14-4037-b6b2-7ec3947fe4fc',
      branch: 'nalfeo-floor-2-equipment-contracts',
      claimed_at: '2026-07-17T20:48:43.643Z',
      lease_expires_at: '2026-07-18T22:20:26.015Z',
      heartbeat_at: '2026-07-17T22:20:26.015Z',
    },
    dependency_pull_requests: [
      {
        node_id: 'slice:A0',
        tracking_issue: null,
        repository: 'nalfeo/Crawler',
        branch: 'nalfeo-floor-2-epic-control',
        pull_request: {
          number: 1271,
          url: 'https://github.com/nalfeo/Crawler/pull/1271',
        },
        head_sha: dependencyHead,
        base_branch: 'main',
        is_stack_base: true,
        observed_pr_state: 'OPEN',
        observed_head_sha: dependencyHead,
        observed_head_branch: 'nalfeo-floor-2-epic-control',
        observed_base_branch: 'main',
        observed_merge_commit: null,
      },
    ],
    dependent: {
      branch: 'nalfeo-floor-2-equipment-contracts',
      base_branch: 'nalfeo-floor-2-epic-control',
      pull_request: {
        number: 1276,
        url: 'https://github.com/nalfeo/Crawler/pull/1276',
      },
      observed_pr_state: 'OPEN',
      observed_head_sha: 'edce21919c72ded228deeed8fe41bd44ac33813e',
      observed_head_branch: 'nalfeo-floor-2-equipment-contracts',
      observed_base_branch: 'nalfeo-floor-2-epic-control',
    },
    last_resynced_dependency_head_sha: dependencyHead,
    last_resynced_at: '2026-07-17T22:20:26.015Z',
    rebase_to_main: {
      pending: false,
      pre_rebase_dependent_head_sha: null,
      prerequisite_merge_commit: null,
    },
    material_contract_drift: null,
    blocked_reason: null,
  };
  return { state, a0, a1, stacked: a1.stacked_work };
}

function stackedClaimBody(
  stacked: NonNullable<EpicState['nodes'][number]['stacked_work']>,
): string {
  return [
    'STACKED-WORK',
    `node: ${stacked.owner.node_id}`,
    `claimant: ${stacked.owner.claimant}`,
    `session: ${stacked.owner.session}`,
    `branch: ${stacked.owner.branch}`,
    `dependency_head: ${stacked.last_resynced_dependency_head_sha}`,
    `claimed_at: ${stacked.owner.claimed_at}`,
    `expires_at: ${stacked.owner.lease_expires_at}`,
    `heartbeat_at: ${stacked.owner.heartbeat_at}`,
  ].join('\n');
}

type StackedFixture = ReturnType<typeof stackedFixture>;
type AuditComment = {
  readonly body: string;
  readonly author_association: 'OWNER' | 'MEMBER' | 'COLLABORATOR';
  readonly html_url: string;
};

function expectStackedDiagnostic(
  code: string,
  mutate: (fixture: StackedFixture) => void,
  source: 'errors' | 'blockers' = 'errors',
): void {
  const fixture = stackedFixture();
  mutate(fixture);
  expect(validate(fixture.state)[source].map((diagnostic) => diagnostic.code)).toContain(code);
}

function makeStackedAuditRunner(
  stacked: StackedFixture['stacked'],
  options: {
    readonly issueComments?: ReadonlyArray<AuditComment>;
    readonly dependencyPull?: Record<string, unknown> | Error;
    readonly dependentPull?: Record<string, unknown> | Error;
  } = {},
): GithubRunner {
  const dependency = stacked.dependency_pull_requests[0]!;
  const defaultDependencyPull = {
    number: dependency.pull_request.number,
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    merged_at: null,
    html_url: dependency.pull_request.url,
    head: { sha: dependency.head_sha, ref: dependency.branch },
    base: { ref: dependency.base_branch },
  };
  const defaultDependentPull = {
    number: stacked.dependent.pull_request?.number ?? 1276,
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    merged_at: null,
    html_url: stacked.dependent.pull_request?.url ?? 'https://github.com/nalfeo/Crawler/pull/1276',
    head: {
      sha: stacked.dependent.observed_head_sha ?? 'edce21919c72ded228deeed8fe41bd44ac33813e',
      ref: stacked.dependent.branch,
    },
    base: { ref: stacked.dependent.base_branch },
  };
  const issueComments =
    options.issueComments ??
    ([
      {
        body: stackedClaimBody(stacked),
        author_association: 'OWNER',
        html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-stack',
      },
    ] satisfies ReadonlyArray<AuditComment>);

  return {
    get(path) {
      if (path.endsWith('/issues/1264')) {
        return {
          number: 1264,
          state: 'open',
          html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
          url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
        };
      }
      if (path.endsWith('/issues/1279')) {
        return {
          number: 1279,
          state: 'open',
          html_url: 'https://github.com/nalfeo/Crawler/issues/1279',
          url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1279',
        };
      }
      if (path.includes('/issues/1264/comments?')) return [];
      if (path.includes('/issues/1279/comments?')) return issueComments;
      if (path.endsWith('/pulls/1271')) {
        if (options.dependencyPull instanceof Error) throw options.dependencyPull;
        return options.dependencyPull ?? defaultDependencyPull;
      }
      if (path.endsWith('/pulls/1276')) {
        if (options.dependentPull instanceof Error) throw options.dependentPull;
        return options.dependentPull ?? defaultDependentPull;
      }
      throw new Error(`Unexpected GitHub path ${path}`);
    },
  };
}

describe('Floor 2 equipment epic status', () => {
  it('accepts the canonical 37-node graph and preserves the approved contract', () => {
    const result = validate(cloneState());
    const contract = extractPlanContract(PLAN).contract;

    expect(result.errors).toEqual([]);
    expect(result.state?.nodes).toHaveLength(EXPECTED_NODE_IDS.length);
    expect(result.release_ready).toBe(false);
    expect(contract.catalog.sprite_ids).toHaveLength(70);
    expect(contract.catalog.sprite_ids.filter((id) => id.startsWith('weapon.'))).toHaveLength(50);
    expect(contract.hard_gate).toMatchObject({ minimum: 1.7, maximum: 2.3 });
    expect(contract.economy.boss_chest_rarity_percent).toEqual({
      uncommon: 85,
      rare: 15,
    });
  });

  it('tracks speculative A1 work while lifecycle and downstream readiness remain blocked', () => {
    const { state, a1 } = stackedFixture();

    const result = validate(state);

    expect(result.errors).toEqual([]);
    expect(a1.status).toBe('blocked');
    expect(a1.stacked_work?.state).toBe('stacked_pr_open');
    expect(result.ready_queue).not.toContain('slice:A1');
    expect(result.ready_queue).not.toContain('slice:B1');
    expect(result.state?.nodes).toHaveLength(37);
  });

  it('permits a tracked auxiliary control-plane PR as the immediate stack base', () => {
    const { state, stacked } = stackedFixture();
    stacked.dependency_pull_requests[0]!.is_stack_base = false;
    const auxiliaryHead = '9'.repeat(40);
    stacked.dependency_pull_requests.push({
      node_id: null,
      tracking_issue: {
        number: 1282,
        url: 'https://github.com/nalfeo/Crawler/issues/1282',
      },
      repository: 'nalfeo/Crawler',
      branch: 'nalfeo-floor-2-stacked-work-protocol',
      pull_request: {
        number: 1290,
        url: 'https://github.com/nalfeo/Crawler/pull/1290',
      },
      head_sha: auxiliaryHead,
      base_branch: 'nalfeo-floor-2-epic-control',
      is_stack_base: true,
      observed_pr_state: 'OPEN',
      observed_head_sha: auxiliaryHead,
      observed_head_branch: 'nalfeo-floor-2-stacked-work-protocol',
      observed_base_branch: 'nalfeo-floor-2-epic-control',
      observed_merge_commit: null,
    });
    stacked.dependent.base_branch = 'nalfeo-floor-2-stacked-work-protocol';
    stacked.dependent.observed_base_branch = 'nalfeo-floor-2-stacked-work-protocol';
    stacked.last_resynced_dependency_head_sha = auxiliaryHead;

    expect(validate(state).errors).toEqual([]);
  });

  it('rejects stacked work outside blocked control-lane nodes with a dedicated owner issue', () => {
    const active = stackedFixture();
    active.a1.status = 'ready';
    expect(validate(active.state).errors.map((error) => error.code)).toContain(
      'stacked.lifecycle-not-blocked',
    );

    const wrongLane = stackedFixture();
    wrongLane.a1.execution_lane = 'registry';
    expect(validate(wrongLane.state).errors.map((error) => error.code)).toContain(
      'stacked.lane-not-allowed',
    );

    const missingIssue = stackedFixture();
    missingIssue.a1.github.issue = null;
    expect(validate(missingIssue.state).errors.map((error) => error.code)).toContain(
      'stacked.missing-issue-owner',
    );
  });

  it('rejects stale dependency snapshots, closed prerequisites, wrong bases, and stale resyncs', () => {
    const staleHead = stackedFixture();
    staleHead.stacked.dependency_pull_requests[0]!.observed_head_sha = 'a'.repeat(40);
    expect(validate(staleHead.state).errors.map((error) => error.code)).toContain(
      'stacked.dependency-head-stale',
    );

    const closed = stackedFixture();
    closed.stacked.dependency_pull_requests[0]!.observed_pr_state = 'CLOSED';
    expect(validate(closed.state).errors.map((error) => error.code)).toContain(
      'stacked.dependency-pr-closed',
    );

    const wrongBase = stackedFixture();
    wrongBase.stacked.dependent.base_branch = 'main';
    wrongBase.stacked.dependent.observed_base_branch = 'main';
    expect(validate(wrongBase.state).errors.map((error) => error.code)).toContain(
      'stacked.wrong-base-branch',
    );

    const staleResync = stackedFixture();
    staleResync.stacked.last_resynced_at = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
    expect(validate(staleResync.state).errors.map((error) => error.code)).toContain(
      'stacked.resync-stale',
    );
  });

  it('rejects missing prerequisite coverage and conflicting stacked ownership', () => {
    const missingDependency = stackedFixture();
    const auxiliaryOnly = missingDependency.stacked.dependency_pull_requests[0]!;
    auxiliaryOnly.node_id = null;
    auxiliaryOnly.tracking_issue = {
      number: 1282,
      url: 'https://github.com/nalfeo/Crawler/issues/1282',
    };
    expect(validate(missingDependency.state).errors.map((error) => error.code)).toContain(
      'stacked.dependency-coverage',
    );

    const conflict = stackedFixture();
    conflict.a0.ownership.claimant = conflict.stacked.owner.claimant;
    conflict.a0.ownership.session = conflict.stacked.owner.session;
    expect(validate(conflict.state).errors.map((error) => error.code)).toContain(
      'stacked.duplicate-owner',
    );

    const duplicateBranch = stackedFixture();
    const b1 = duplicateBranch.state.nodes.find((node) => node.node_id === 'slice:B1');
    expect(b1).toBeDefined();
    if (b1) {
      b1.github.issue = {
        number: 1283,
        url: 'https://github.com/nalfeo/Crawler/issues/1283',
      };
      b1.stacked_work = structuredClone(duplicateBranch.stacked);
      b1.stacked_work.owner.node_id = b1.node_id;
      b1.stacked_work.owner.issue = b1.github.issue;
    }
    const duplicateCodes = validate(duplicateBranch.state).errors.map((error) => error.code);
    expect(duplicateCodes).toContain('stacked.duplicate-owner');
    expect(duplicateCodes).toContain('stacked.duplicate-branch');
  });

  it('requires rebase-to-main after prerequisite merge and proves the rebased head changed', () => {
    const merged = stackedFixture();
    const dependency = merged.stacked.dependency_pull_requests[0]!;
    const mergeCommit = 'b'.repeat(40);
    dependency.observed_pr_state = 'MERGED';
    dependency.observed_merge_commit = mergeCommit;
    expect(validate(merged.state).errors.map((error) => error.code)).toContain(
      'stacked.rebase-to-main-required',
    );

    const preRebaseHead = merged.stacked.dependent.observed_head_sha;
    expect(preRebaseHead).not.toBeNull();
    merged.stacked.rebase_to_main = {
      pending: true,
      pre_rebase_dependent_head_sha: preRebaseHead,
      prerequisite_merge_commit: mergeCommit,
    };
    expect(validate(merged.state).errors).toEqual([]);

    merged.stacked.dependent.base_branch = 'main';
    merged.stacked.dependent.observed_base_branch = null;
    const rebasedHead = 'c'.repeat(40);
    merged.stacked.dependent.observed_head_sha = rebasedHead;
    expect(validate(merged.state).errors.map((error) => error.code)).toContain(
      'stacked.rebase-base-not-observed',
    );

    merged.stacked.dependent.observed_base_branch = 'main';
    merged.stacked.dependent.observed_head_sha = preRebaseHead;
    expect(validate(merged.state).errors.map((error) => error.code)).toContain(
      'stacked.rebase-not-pushed',
    );

    merged.stacked.dependent.observed_head_sha = rebasedHead;
    expect(validate(merged.state).errors).toEqual([]);
  });

  it('rejects inconsistent stacked owner and dependent PR snapshots', () => {
    expectStackedDiagnostic('stacked.owner-mismatch', ({ stacked }) => {
      stacked.owner.branch = 'wrong-owner-branch';
    });
    expectStackedDiagnostic('stacked.owner-expired', ({ stacked }) => {
      stacked.owner.lease_expires_at = '2026-07-17T21:59:59.000Z';
    });
    expectStackedDiagnostic('stacked.owner-heartbeat-stale', ({ stacked }) => {
      stacked.owner.heartbeat_at = new Date(NOW.getTime() - 49 * 3_600_000).toISOString();
    });
    expectStackedDiagnostic('stacked.dependent-pr-missing', ({ stacked }) => {
      stacked.dependent.pull_request = null;
    });
    expectStackedDiagnostic('stacked.dependent-pr-premature', ({ stacked }) => {
      stacked.state = 'stacked_in_progress';
    });
    expectStackedDiagnostic('stacked.dependent-pr-closed', ({ stacked }) => {
      stacked.dependent.observed_pr_state = 'CLOSED';
    });
    expectStackedDiagnostic('stacked.dependent-branch-drift', ({ stacked }) => {
      stacked.dependent.observed_head_branch = 'wrong-dependent-branch';
    });
    expectStackedDiagnostic('stacked.dependent-base-drift', ({ stacked }) => {
      stacked.dependent.observed_base_branch = 'wrong-dependent-base';
    });
  });

  it('treats the dependent head as a nullable observation cache, not an exact invariant', () => {
    const { state, stacked } = stackedFixture();
    stacked.dependent.observed_head_sha = null;
    expect(validate(state).errors).toEqual([]);

    const observedHead = '1'.repeat(40);
    const audit = auditGithub(
      state,
      makeStackedAuditRunner(stacked, {
        dependentPull: {
          number: 1276,
          state: 'open',
          merged: false,
          merge_commit_sha: null,
          merged_at: null,
          html_url: 'https://github.com/nalfeo/Crawler/pull/1276',
          head: { sha: observedHead, ref: stacked.dependent.branch },
          base: { ref: stacked.dependent.base_branch },
        },
      }),
      NOW,
    );

    expect(audit.errors.map((error) => error.code)).not.toContain('github.stacked-dependent-drift');
    expect(audit.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining('/stacked_work/dependent/observed_head_sha'),
        value: observedHead,
      }),
    );
  });

  it('rejects incomplete or internally stale stacked prerequisite snapshots', () => {
    expectStackedDiagnostic('stacked.stack-base-count', ({ stacked }) => {
      stacked.dependency_pull_requests[0]!.is_stack_base = false;
    });
    expectStackedDiagnostic('stacked.auxiliary-base-authority', ({ stacked }) => {
      const dependency = stacked.dependency_pull_requests[0]!;
      dependency.node_id = null;
      dependency.tracking_issue = null;
    });
    expectStackedDiagnostic('stacked.dependency-pr-missing', ({ a0 }) => {
      a0.github.pr = null;
    });
    expectStackedDiagnostic('stacked.dependency-snapshot-stale', ({ stacked }) => {
      stacked.dependency_pull_requests[0]!.head_sha = '2'.repeat(40);
    });
    expectStackedDiagnostic('stacked.dependency-not-open', ({ a0 }) => {
      a0.status = 'blocked';
    });
    expectStackedDiagnostic('stacked.dependency-branch-drift', ({ stacked }) => {
      stacked.dependency_pull_requests[0]!.observed_head_branch = 'wrong-prerequisite-branch';
    });
    expectStackedDiagnostic('stacked.dependency-base-drift', ({ stacked }) => {
      stacked.dependency_pull_requests[0]!.observed_base_branch = 'wrong-prerequisite-base';
    });
    expectStackedDiagnostic('stacked.dependency-merge-facts', ({ stacked }) => {
      stacked.dependency_pull_requests[0]!.observed_pr_state = 'MERGED';
      stacked.dependency_pull_requests[0]!.observed_merge_commit = null;
    });
    expectStackedDiagnostic('stacked.resync-head-stale', ({ stacked }) => {
      stacked.last_resynced_dependency_head_sha = '3'.repeat(40);
    });
  });

  it('rejects premature rebase state and surfaces material stacked blockers', () => {
    expectStackedDiagnostic('stacked.unexpected-rebase-to-main', ({ stacked }) => {
      stacked.rebase_to_main.pending = true;
      stacked.rebase_to_main.pre_rebase_dependent_head_sha = stacked.dependent.observed_head_sha;
      stacked.rebase_to_main.prerequisite_merge_commit = '4'.repeat(40);
    });
    expectStackedDiagnostic(
      'stacked.material-block',
      ({ stacked }) => {
        stacked.material_contract_drift = 'A1 contracts no longer match A0';
      },
      'blockers',
    );
  });

  it('audits stacked owner and PR facts read-only and proposes observed drift', () => {
    const { state, stacked } = stackedFixture();
    const dependencyHead = 'd'.repeat(40);
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.endsWith('/issues/1279')) {
          return {
            number: 1279,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279',
          };
        }
        if (path.includes('/issues/1264/comments?')) return [];
        if (path.includes('/issues/1279/comments?')) {
          return [
            {
              body: stackedClaimBody(stacked),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-1',
            },
          ];
        }
        if (path.endsWith('/pulls/1271')) {
          return {
            number: 1271,
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            merged_at: null,
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: { sha: dependencyHead, ref: 'nalfeo-floor-2-epic-control' },
            base: { ref: 'main' },
          };
        }
        if (path.endsWith('/pulls/1276')) {
          return {
            number: 1276,
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            merged_at: null,
            html_url: 'https://github.com/nalfeo/Crawler/pull/1276',
            head: {
              sha:
                stacked.dependent.observed_head_sha ?? 'edce21919c72ded228deeed8fe41bd44ac33813e',
              ref: stacked.dependent.branch,
            },
            base: { ref: stacked.dependent.base_branch },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((error) => error.code)).toContain('github.stacked-dependency-drift');
    expect(audit.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining('/stacked_work/dependency_pull_requests/0/observed_head_sha'),
        value: dependencyHead,
      }),
    );
    expect(audit.proposal.repo_patch.map((patch) => patch.path)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\/status$/)]),
    );
  });

  it('detects merged prerequisite and wrong dependent base from GitHub without mutating lifecycle', () => {
    const { state, stacked } = stackedFixture();
    const mergeCommit = 'e'.repeat(40);
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.endsWith('/issues/1279')) {
          return {
            number: 1279,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279',
          };
        }
        if (path.includes('/issues/1264/comments?')) return [];
        if (path.includes('/issues/1279/comments?')) {
          return [
            {
              body: stackedClaimBody(stacked),
              author_association: 'MEMBER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-2',
            },
          ];
        }
        if (path.endsWith('/pulls/1271')) {
          return {
            number: 1271,
            state: 'closed',
            merged: true,
            merge_commit_sha: mergeCommit,
            merged_at: '2026-07-17T22:30:00.000Z',
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: {
              sha: stacked.last_resynced_dependency_head_sha,
              ref: 'nalfeo-floor-2-epic-control',
            },
            base: { ref: 'main' },
          };
        }
        if (path.endsWith('/pulls/1276')) {
          return {
            number: 1276,
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            merged_at: null,
            html_url: 'https://github.com/nalfeo/Crawler/pull/1276',
            head: {
              sha:
                stacked.dependent.observed_head_sha ?? 'edce21919c72ded228deeed8fe41bd44ac33813e',
              ref: stacked.dependent.branch,
            },
            base: { ref: 'nalfeo-floor-2-epic-control' },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((error) => error.code)).toContain('github.stacked-dependency-merged');
    expect(
      audit.proposal.operator_actions.some((action) => action.includes('rebase_to_main')),
    ).toBe(true);
    expect(audit.proposal.repo_patch.map((patch) => patch.path)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\/status$/)]),
    );
  });

  it('detects a prerequisite PR closed without merge and proposes stopping stacked work', () => {
    const { state, stacked } = stackedFixture();
    const dependency = stacked.dependency_pull_requests[0]!;
    const audit = auditGithub(
      state,
      makeStackedAuditRunner(stacked, {
        dependencyPull: {
          number: dependency.pull_request.number,
          state: 'closed',
          merged: false,
          merge_commit_sha: null,
          merged_at: null,
          html_url: dependency.pull_request.url,
          head: { sha: dependency.head_sha, ref: dependency.branch },
          base: { ref: dependency.base_branch },
        },
      }),
      NOW,
    );

    expect(audit.errors.map((error) => error.code)).toContain('github.stacked-dependency-closed');
    expect(
      audit.proposal.operator_actions.some(
        (action) => action.includes('Stop stacked work') && action.includes('closed without merge'),
      ),
    ).toBe(true);
  });

  it('audits dependent PR drift and closure without mutating lifecycle', () => {
    const { state, stacked } = stackedFixture();
    const advancedHead = '5'.repeat(40);
    const audit = auditGithub(
      state,
      makeStackedAuditRunner(stacked, {
        dependentPull: {
          number: 1276,
          state: 'closed',
          merged: false,
          merge_commit_sha: null,
          merged_at: null,
          html_url: 'https://github.com/nalfeo/Crawler/pull/1276',
          head: { sha: advancedHead, ref: 'drifted-dependent-branch' },
          base: { ref: 'main' },
        },
      }),
      NOW,
    );

    expect(audit.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'github.stacked-dependent-drift',
        'github.stacked-dependent-not-open',
      ]),
    );
    expect(audit.proposal.repo_patch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('/stacked_work/dependent/observed_head_sha'),
          value: advancedHead,
        }),
        expect.objectContaining({
          path: expect.stringContaining('/stacked_work/dependent/observed_base_branch'),
          value: 'main',
        }),
      ]),
    );
    expect(state.nodes.find((node) => node.node_id === 'slice:A1')?.status).toBe('blocked');
  });

  it('surfaces prerequisite and dependent PR audit failures separately', () => {
    const prerequisite = stackedFixture();
    const prerequisiteAudit = auditGithub(
      prerequisite.state,
      makeStackedAuditRunner(prerequisite.stacked, {
        dependencyPull: new Error('prerequisite unavailable'),
      }),
      NOW,
    );
    expect(prerequisiteAudit.errors.map((error) => error.code)).toContain(
      'github.stacked-dependency-audit',
    );

    const dependent = stackedFixture();
    const dependentAudit = auditGithub(
      dependent.state,
      makeStackedAuditRunner(dependent.stacked, {
        dependentPull: new Error('dependent unavailable'),
      }),
      NOW,
    );
    expect(dependentAudit.errors.map((error) => error.code)).toContain(
      'github.stacked-dependent-audit',
    );
  });

  it('reconciles missing, duplicate, drifted, conflicting, and unexpected live stack owners', () => {
    const missing = stackedFixture();
    const missingAudit = auditGithub(
      missing.state,
      makeStackedAuditRunner(missing.stacked, { issueComments: [] }),
      NOW,
    );
    expect(missingAudit.errors.map((error) => error.code)).toContain(
      'github.stacked-owner-missing',
    );

    const duplicate = stackedFixture();
    const duplicateBody = stackedClaimBody(duplicate.stacked)
      .replace(`claimant: ${duplicate.stacked.owner.claimant}`, 'claimant: competing-owner')
      .replace(`session: ${duplicate.stacked.owner.session}`, 'session: competing-session');
    const duplicateAudit = auditGithub(
      duplicate.state,
      makeStackedAuditRunner(duplicate.stacked, {
        issueComments: [
          {
            body: stackedClaimBody(duplicate.stacked),
            author_association: 'OWNER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-owner',
          },
          {
            body: duplicateBody,
            author_association: 'MEMBER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-competitor',
          },
        ],
      }),
      NOW,
    );
    expect(duplicateAudit.errors.map((error) => error.code)).toContain(
      'github.stacked-owner-duplicate',
    );

    const drifted = stackedFixture();
    const driftedAudit = auditGithub(
      drifted.state,
      makeStackedAuditRunner(drifted.stacked, {
        issueComments: [
          {
            body: stackedClaimBody(drifted.stacked).replace(
              `branch: ${drifted.stacked.owner.branch}`,
              'branch: stale-owner-branch',
            ),
            author_association: 'COLLABORATOR',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-drift',
          },
        ],
      }),
      NOW,
    );
    expect(driftedAudit.errors.map((error) => error.code)).toContain('github.stacked-owner-drift');

    const conflict = stackedFixture();
    const normalClaim = [
      'CLAIMED',
      'node: slice:A1',
      'claimant: normal-owner',
      'session: normal-session',
      'expires_at: 2026-07-18T22:00:00.000Z',
      'claimed_at: 2026-07-17T21:00:00.000Z',
      `base_commit: ${HANDOFF_COMMIT}`,
      'scope: A1 normal lifecycle',
    ].join('\n');
    const conflictAudit = auditGithub(
      conflict.state,
      makeStackedAuditRunner(conflict.stacked, {
        issueComments: [
          {
            body: stackedClaimBody(conflict.stacked),
            author_association: 'OWNER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-stack',
          },
          {
            body: normalClaim,
            author_association: 'MEMBER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-normal',
          },
        ],
      }),
      NOW,
    );
    expect(conflictAudit.errors.map((error) => error.code)).toContain(
      'github.stacked-normal-claim-conflict',
    );

    const unexpected = stackedFixture();
    const recordedStack = structuredClone(unexpected.stacked);
    delete unexpected.a1.stacked_work;
    const unexpectedAudit = auditGithub(
      unexpected.state,
      makeStackedAuditRunner(recordedStack),
      NOW,
    );
    expect(unexpectedAudit.errors.map((error) => error.code)).toContain(
      'github.unexpected-stacked-owner',
    );
  });

  it('lets a trusted BLOCKED event revoke live stacked ownership before metadata clears', () => {
    const fixture = stackedFixture();
    const recordedStack = structuredClone(fixture.stacked);
    delete fixture.a1.stacked_work;
    const audit = auditGithub(
      fixture.state,
      makeStackedAuditRunner(recordedStack, {
        issueComments: [
          {
            body: stackedClaimBody(recordedStack),
            author_association: 'OWNER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-stack',
          },
          {
            body: ['BLOCKED', 'node: slice:A1', 'lease_disposition: revoked'].join('\n'),
            author_association: 'OWNER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-blocked',
          },
        ],
      }),
      NOW,
    );

    expect(audit.errors.map((error) => error.code)).not.toContain(
      'github.unexpected-stacked-owner',
    );
  });

  it('rejects missing nodes, dependencies, and cycles', () => {
    const state = cloneState();
    state.nodes = state.nodes.filter((node) => node.node_id !== 'slice:J');
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (a1) a1.dependencies = ['slice:B1'];
    const b1 = state.nodes.find((node) => node.node_id === 'slice:B1');
    expect(b1).toBeDefined();
    if (b1) b1.dependencies = ['slice:A1', 'slice:DOES-NOT-EXIST'];

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('dag.missing-node');
    expect(codes).toContain('dag.missing-dependency');
    expect(codes).toContain('dag.cycle');
  });

  it('rejects false readiness and detects a computed ready queue', () => {
    const falseReady = cloneState();
    const a1 = falseReady.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (a1) {
      a1.status = 'ready';
      a1.github.issue = {
        number: 9001,
        url: 'https://github.com/nalfeo/Crawler/issues/9001',
      };
    }
    expect(validate(falseReady).errors.map((error) => error.code)).toContain(
      'readiness.false-ready',
    );

    const computed = cloneState();
    validateA0(computed);
    const computedA1 = computed.nodes.find((node) => node.node_id === 'slice:A1');
    expect(computedA1).toBeDefined();
    if (computedA1) {
      computedA1.github.issue = {
        number: 9002,
        url: 'https://github.com/nalfeo/Crawler/issues/9002',
      };
    }
    const result = validate(computed);
    expect(result.errors).toEqual([]);
    expect(result.ready_queue).toContain('slice:A1');
    expect(result.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: expect.stringMatching(/\/status$/),
        value: 'ready',
      }),
    );
  });

  it('rejects stale and duplicate active ownership', () => {
    const stale = cloneState();
    stale.nodes[0]!.ownership.lease_expires_at = '2026-07-17T17:59:59.000Z';
    expect(validate(stale).errors.map((error) => error.code)).toContain('ownership.stale-claim');

    const duplicate = cloneState();
    const a1 = duplicate.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (a1) {
      a1.status = 'claimed';
      a1.github.issue = {
        number: 9003,
        url: 'https://github.com/nalfeo/Crawler/issues/9003',
      };
      a1.ownership = structuredClone(duplicate.nodes[0]!.ownership);
      a1.dependencies = [];
    }
    expect(validate(duplicate).errors.map((error) => error.code)).toContain('ownership.duplicate');
  });

  it('detects plan contract drift without proposing an automatic write', () => {
    const state = cloneState();
    state.plan.contract_sha256 = '0'.repeat(64);

    const result = validate(state);

    expect(result.errors.map((error) => error.code)).toContain('plan.contract-drift');
    expect(result.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: '/plan/contract_sha256',
        reason: expect.stringContaining('plan-change protocol'),
      }),
    );
  });

  it('requires immutable handoff, review, PR, and merge evidence', () => {
    const state = cloneState();
    const a0 = state.nodes[0]!;
    a0.status = 'merged';
    a0.github.pr = null;
    a0.merge = { commit: null, merged_at: null };
    a0.evidence = [];

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('github.pr-open-refs');
    expect(codes).toContain('merge.missing-facts');
    expect(codes).toContain('evidence.missing-handoff');
    expect(codes).toContain('evidence.missing-review-ledger');
  });

  it('rejects content-hash drift in commit-addressed evidence', () => {
    const state = cloneState();
    validateA0(state);
    state.nodes[0]!.evidence[0]!.sha256 = 'a'.repeat(64);

    expect(validate(state).errors.map((error) => error.code)).toContain('evidence.hash-drift');
  });

  it('renders stable child issue packets with late-bound parent substitution', () => {
    const state = structuredClone(STATE);
    state.github.parent_issue = null;
    const withoutParent = buildMaterializationPlan(state);
    state.github.parent_issue = {
      number: 1259,
      url: 'https://github.com/nalfeo/Crawler/issues/1259',
    };
    const withParent = buildMaterializationPlan(state);

    // A0 (bootstrap) and A1 (already has issue #1279) are both excluded.
    expect(withoutParent).toHaveLength(EXPECTED_NODE_IDS.length - 2);
    expect(withoutParent[0]?.body).toContain('#<parent-issue-number>');
    expect(withParent.map((packet) => packet.node_id)).toEqual(
      withoutParent.map((packet) => packet.node_id),
    );
    expect(withParent[0]?.body).toContain('#1259');
  });

  it('audits GitHub read-only and reports duplicate trusted live claims', () => {
    const state = cloneState();
    state.nodes[0]!.reconciliation.observed_issue_state = null;
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) {
          return Array.from({ length: 100 }, (_, index) => ({
            body: `progress update ${index}`,
            author_association: 'OWNER',
            html_url: `https://github.com/nalfeo/Crawler/issues/1264#issuecomment-${index}`,
          }));
        }
        if (path.includes('/comments?per_page=100&page=2')) {
          const makeCompleteClaim = (session: string): string =>
            [
              'CLAIMED',
              'node: slice:A0',
              'claimant: test-agent',
              `session: ${session}`,
              'expires_at: 2026-07-18T18:00:00.000Z',
              'claimed_at: 2026-07-17T17:00:00.000Z',
              `base_commit: ${HANDOFF_COMMIT}`,
              'scope: Slice A0 control plane only',
            ].join('\n');
          return [
            {
              body: makeCompleteClaim('session-1'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-1',
            },
            {
              body: makeCompleteClaim('session-2'),
              author_association: 'MEMBER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-2',
            },
          ];
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((error) => error.code)).toContain('github.duplicate-live-claims');
    expect(audit.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: '/nodes/0/reconciliation/observed_issue_state',
        value: 'open',
      }),
    );
    expect(audit.proposal.operator_actions).toHaveLength(1);
  });

  it('reconciles an advanced PR head without invalidating the state cache', () => {
    const state = cloneState();
    const a0 = state.nodes[0]!;
    a0.github.pr = {
      number: 1271,
      url: 'https://github.com/nalfeo/Crawler/pull/1271',
      head_sha: FULL_COMMIT,
    };
    const advancedHead = 'b'.repeat(40);
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.endsWith('/issues/1279')) {
          return {
            number: 1279,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1279',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) return [];
        if (path.endsWith('/pulls/1271')) {
          return {
            number: 1271,
            state: 'open',
            merged: false,
            merge_commit_sha: 'c'.repeat(40),
            merged_at: null,
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: { sha: advancedHead },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors).toEqual([]);
    expect(audit.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: '/nodes/0/github/pr/head_sha',
        value: advancedHead,
      }),
    );
    expect(audit.proposal.repo_patch.map((patch) => patch.path)).not.toContain(
      '/nodes/0/reconciliation/observed_merge_commit',
    );
  });

  it('rejects stale heartbeat (exceeds maximum_without_heartbeat_hours)', () => {
    const state = cloneState();
    // Set heartbeat_at 49 hours before NOW (exceeds 48-hour maximum)
    const staleHeartbeat = new Date(NOW.getTime() - 49 * 3_600_000).toISOString();
    state.nodes[0]!.ownership.heartbeat_at = staleHeartbeat;

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('ownership.stale-heartbeat');
  });

  it('rejects non-canonical evidence paths for handoff and review-ledger', () => {
    const state = cloneState();
    validateA0(state);
    // Replace handoff with a non-canonical path (not in docs/knowledge/handoffs/)
    state.nodes[0]!.evidence[0]!.path_or_check = 'docs/knowledge/epics/floor-2-equipment/PLAN.md';

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('evidence.non-canonical-path');
  });

  it('rejects issue URL that does not match the issue number', () => {
    const state = cloneState();
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (a1) {
      // URL says 9999 but number says 9001 — should fail schema validation.
      a1.github.issue = {
        number: 9001,
        url: 'https://github.com/nalfeo/Crawler/issues/9999',
      };
    }
    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).toContain('state.schema');
  });

  it('rejects canonical dependency drift', () => {
    const state = cloneState();
    // Change slice:I2 to depend on slice:A0 instead of the canonical slice:I1
    const i2 = state.nodes.find((node) => node.node_id === 'slice:I2');
    expect(i2).toBeDefined();
    if (i2) i2.dependencies = ['slice:A0'];

    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).toContain('dag.dependency-contract-drift');
  });

  it('includes required terminal nodes in release blockers', () => {
    const state = cloneState();
    // Mark a required node as cancelled — it should still appear in blockers
    const b1 = state.nodes.find((node) => node.node_id === 'slice:B1');
    expect(b1).toBeDefined();
    if (b1) {
      b1.status = 'cancelled';
      b1.ownership = {
        claimant: null,
        session: null,
        source: 'none',
        scope: null,
        claimed_at: null,
        lease_expires_at: null,
        heartbeat_at: null,
        base_commit: null,
      };
    }
    const result = validate(state);
    expect(result.blockers.map((b) => b.node_id)).toContain('slice:B1');
  });

  it('rejects parent-issue-bootstrap source on non-bootstrap node', () => {
    const state = cloneState();
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (a1) {
      a1.status = 'claimed';
      a1.github.issue = {
        number: 9003,
        url: 'https://github.com/nalfeo/Crawler/issues/9003',
      };
      a1.dependencies = []; // Satisfy dependency check
      a1.ownership = {
        claimant: 'agent',
        session: 'sess',
        source: 'parent-issue-bootstrap',
        scope: 'A1 only',
        claimed_at: '2026-07-17T17:00:00.000Z',
        lease_expires_at: '2026-07-18T18:00:00.000Z',
        heartbeat_at: '2026-07-17T17:00:00.000Z',
        base_commit: HANDOFF_COMMIT,
      };
    }
    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).toContain('ownership.invalid-bootstrap-source');
  });

  it('revokes a live claim when a trusted BLOCKED event follows', () => {
    const state = cloneState();
    const makeClaim = (claimedAt: string): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        'claimant: agent-b',
        'session: session-z',
        'expires_at: 2026-07-18T18:00:00.000Z',
        `claimed_at: ${claimedAt}`,
        `base_commit: ${HANDOFF_COMMIT}`,
        'scope: Slice A0 control plane only',
      ].join('\n');
    const makeBlocked = (): string =>
      ['BLOCKED', 'node: slice:A0', 'reason: dependency unresolved'].join('\n');
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) {
          return [
            // CLAIMED first, then BLOCKED — the claim should be revoked.
            {
              body: makeClaim('2026-07-17T16:00:00.000Z'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-20',
            },
            {
              body: makeBlocked(),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-21',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };
    const audit = auditGithub(state, runner, NOW);
    // No duplicate-live-claims and no operator action for the revoked claim.
    expect(audit.errors.map((e) => e.code)).not.toContain('github.duplicate-live-claims');
    expect(audit.proposal.operator_actions.filter((a) => a.includes('session-z'))).toHaveLength(0);
  });

  it('keeps release_ready false when GitHub audit adds errors', () => {
    const state = cloneState();
    const a0 = state.nodes[0]!;
    // Set up a merged node where the GitHub merge facts will disagree
    a0.status = 'merged';
    a0.merge = { commit: TEST_MERGE_COMMIT, merged_at: '2026-07-17T17:50:00.000Z' };
    a0.github.pr = {
      number: 1271,
      url: 'https://github.com/nalfeo/Crawler/pull/1271',
      head_sha: FULL_COMMIT,
    };
    a0.ownership = {
      claimant: null,
      session: null,
      source: 'none',
      scope: null,
      claimed_at: null,
      lease_expires_at: null,
      heartbeat_at: null,
      base_commit: null,
    };
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) return [];
        if (path.endsWith('/pulls/1271')) {
          // Disagree on merge commit — triggers github.merge-drift
          return {
            number: 1271,
            state: 'closed',
            merged: true,
            merge_commit_sha: 'd'.repeat(40), // different from TEST_MERGE_COMMIT
            merged_at: '2026-07-17T17:50:00.000Z',
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: { sha: FULL_COMMIT },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };
    const audit = auditGithub(state, runner, NOW);
    expect(audit.errors.map((e) => e.code)).toContain('github.merge-drift');
  });

  it('emits operator action when pr_open node has merged PR on GitHub', () => {
    const state = cloneState();
    const a0 = state.nodes[0]!;
    a0.github.pr = {
      number: 1271,
      url: 'https://github.com/nalfeo/Crawler/pull/1271',
      head_sha: FULL_COMMIT,
    };
    const mergeCommit = TEST_MERGE_COMMIT;
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.endsWith('/issues/1279')) {
          return {
            number: 1279,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1279',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) return [];
        if (path.endsWith('/pulls/1271')) {
          return {
            number: 1271,
            state: 'closed',
            merged: true,
            merge_commit_sha: mergeCommit,
            merged_at: '2026-07-17T20:00:00.000Z',
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: { sha: FULL_COMMIT },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors).toEqual([]);
    expect(audit.proposal.operator_actions.some((a) => a.includes('merged on GitHub'))).toBe(true);
    expect(audit.proposal.operator_actions.some((a) => a.includes(mergeCommit))).toBe(true);
  });

  it('collapses replacement heartbeats for same node/claimant/session and detects competing claimants', () => {
    const state = cloneState();
    const makeCompleteClaim = (session: string, claimedAt: string): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        'claimant: agent-a',
        `session: ${session}`,
        'expires_at: 2026-07-18T18:00:00.000Z',
        `claimed_at: ${claimedAt}`,
        `base_commit: ${HANDOFF_COMMIT}`,
        'scope: Slice A0 control plane only',
      ].join('\n');
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) {
          // Two claims from same session (heartbeat replacement) + one from competing session.
          return [
            {
              body: makeCompleteClaim('session-x', '2026-07-17T16:00:00.000Z'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-10',
            },
            {
              body: makeCompleteClaim('session-x', '2026-07-17T17:00:00.000Z'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-11',
            },
            {
              body: makeCompleteClaim('session-y', '2026-07-17T17:30:00.000Z'),
              author_association: 'MEMBER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-12',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    // The two same-session claims collapse to one (newest heartbeat); session-y is a
    // competing claimant → duplicate-live-claims error.
    expect(audit.errors.map((e) => e.code)).toContain('github.duplicate-live-claims');
  });

  it('proposes ownership reconciliation when live claim differs from cached', () => {
    const state = cloneState();
    // Change A0 to in_progress with a cached owner that differs from the live claim.
    state.nodes[0]!.status = 'in_progress';
    state.nodes[0]!.github.pr = null;
    state.nodes[0]!.ownership.claimant = 'old-agent';
    state.nodes[0]!.ownership.session = 'old-session';
    const makeCompleteClaim = (): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        'claimant: new-agent',
        'session: new-session',
        'expires_at: 2026-07-18T18:00:00.000Z',
        'claimed_at: 2026-07-17T17:00:00.000Z',
        `base_commit: ${HANDOFF_COMMIT}`,
        'scope: Slice A0 control plane only',
      ].join('\n');
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.endsWith('/issues/1279')) {
          return {
            number: 1279,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1279',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) {
          return [
            {
              body: makeCompleteClaim(),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-99',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors).toEqual([]);
    expect(
      audit.proposal.operator_actions.some(
        (a) => a.includes('new-agent') && a.includes('old-agent'),
      ),
    ).toBe(true);
  });

  it('emits duplicate-live-claims when two competing claimants share the same session string', () => {
    const state = cloneState();
    // Same session string, different claimants — must NOT collapse into one entry.
    // Use an explicit 40-char hex string; the test is about dedup behavior, not commit validation.
    const DUMMY_SHA = 'a'.repeat(40);
    const makeClaim = (claimant: string): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        `claimant: ${claimant}`,
        'session: shared-session',
        'expires_at: 2026-07-18T18:00:00.000Z',
        'claimed_at: 2026-07-17T17:00:00.000Z',
        `base_commit: ${DUMMY_SHA}`,
        'scope: Slice A0 control plane only',
      ].join('\n');
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) {
          return [
            {
              body: makeClaim('agent-alpha'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-30',
            },
            {
              body: makeClaim('agent-beta'),
              author_association: 'MEMBER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-31',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    // Two distinct claimants with the same session must each be a separate entry;
    // dedup must fire because there are two live claims for the same node.
    expect(audit.errors.map((e) => e.code)).toContain('github.duplicate-live-claims');
  });

  it('ignores a trusted claim whose base_commit is not a valid SHA', () => {
    const state = cloneState();
    // Test several invalid base_commit formats: a literal word, too-short hex, and
    // uppercase hex (SHA_PATTERN requires lowercase [0-9a-f]{7,64}).
    const invalidBaseCommits = ['pending', 'abc123', 'ABCDEF01234567890ABCDEF01234567890ABCDEF'];
    for (const badCommit of invalidBaseCommits) {
      const makeInvalidClaim = (): string =>
        [
          'CLAIMED',
          'node: slice:A0',
          'claimant: agent-c',
          'session: session-q',
          'expires_at: 2026-07-18T18:00:00.000Z',
          'claimed_at: 2026-07-17T17:00:00.000Z',
          `base_commit: ${badCommit}`,
          'scope: Slice A0 control plane only',
        ].join('\n');
      const runner: GithubRunner = {
        get(path) {
          if (path.endsWith('/issues/1264')) {
            return {
              number: 1264,
              state: 'open',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
              url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
            };
          }
          if (path.includes('/comments?per_page=100&page=1')) {
            return [
              {
                body: makeInvalidClaim(),
                author_association: 'OWNER',
                html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-40',
              },
            ];
          }
          if (path.includes('/comments?per_page=100&page=2')) return [];
          throw new Error(`Unexpected GitHub path ${path}`);
        },
      };

      const audit = auditGithub(state, runner, NOW);

      // The malformed claim must be silently dropped — no live claims means no duplicate error
      // and no owner reconciliation for the invalid claim.
      expect(audit.errors.map((e) => e.code)).not.toContain('github.duplicate-live-claims');
      expect(audit.proposal.operator_actions.filter((a) => a.includes('agent-c'))).toHaveLength(0);
    }
  });
});

describe('validateEvidenceRequirements', () => {
  it('rejects a validated node with a fabricated commit for handoff evidence', () => {
    const state = cloneState();
    const node = state.nodes[0]!;
    node.status = 'validated';
    node.merge.commit = HANDOFF_COMMIT;
    node.merge.merged_at = '2026-07-17T20:00:00.000Z';
    const FABRICATED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    node.evidence = node.evidence.map((e) => {
      if (e.kind === 'handoff') {
        return {
          ...e,
          commit: FABRICATED_COMMIT,
        };
      }
      return e;
    });

    const knownCommits = new Set([HANDOFF_COMMIT, LEDGER_COMMIT]);
    const strictReader: GitReader = {
      commitExists(sha) {
        return knownCommits.has(sha);
      },
      showContent(_commit, filePath) {
        try {
          return readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
        } catch {
          return null;
        }
      },
    };

    const errors = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      gitReader: strictReader,
    }).errors;
    expect(errors.map((e) => e.code)).toContain('evidence.git-verification-failed');
  });

  it('rejects a validated node with a fabricated commit for non-handoff evidence', () => {
    const state = cloneState();
    const node = state.nodes[0]!;
    node.status = 'validated';
    node.merge.commit = HANDOFF_COMMIT;
    node.merge.merged_at = '2026-07-17T20:00:00.000Z';
    const FABRICATED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    // Replace the offline-validator evidence with a fabricated commit that does not exist.
    node.evidence = node.evidence.map((e) => {
      if (e.kind === 'offline-validator-and-focused-tests') {
        return {
          ...e,
          commit: FABRICATED_COMMIT,
          path_or_check: 'docs/knowledge/epics/floor-2-equipment/PLAN.md',
        };
      }
      return e;
    });

    // Use a reader that only recognises the known commits, not the fabricated one.
    const knownCommits = new Set([HANDOFF_COMMIT, LEDGER_COMMIT]);
    const strictReader: GitReader = {
      commitExists(sha) {
        return knownCommits.has(sha);
      },
      showContent(_commit, filePath) {
        try {
          return readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
        } catch {
          return null;
        }
      },
    };

    const errors = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      gitReader: strictReader,
    }).errors;
    expect(errors.map((e) => e.code)).toContain('evidence.git-verification-failed');
  });
});
