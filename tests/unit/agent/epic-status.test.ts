import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyGithubAudit,
  auditGithub,
  buildMaterializationPlan,
  createDefaultGitReader,
  EXPECTED_NODE_IDS,
  extractPlanContract,
  validateEpicState,
  type EpicState,
  type GitReader,
  type GithubRunner,
  type ValidationResult,
} from '../../../scripts/agent/epics/epic-status-lib';

const REPO_ROOT = process.cwd();
const EPIC_DIR = resolve(REPO_ROOT, 'docs', 'knowledge', 'epics', 'floor-2-equipment');
const PLAN = readFileSync(resolve(EPIC_DIR, 'PLAN.md'), 'utf8');
const SCHEMA = JSON.parse(
  readFileSync(resolve(EPIC_DIR, 'epic-state.schema.json'), 'utf8'),
) as unknown;
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

const CURRENT_TEST_FILE_HASH = sha256OfFile(REPO_ROOT, 'tests/unit/agent/epic-status.test.ts');

/**
 * A repository-independent GitReader for unit tests: reads evidence files
 * from the current working tree (content matches the recorded sha256 hashes)
 * and treats every commit SHA as present. This avoids any dependency on git
 * history depth, keeping the suite green in shallow CI checkouts.
 */
function makeWorkingTreeGitReader(repoRoot: string): GitReader {
  return {
    readContent(_commit: string, filePath: string) {
      try {
        return {
          content: readFileSync(resolve(repoRoot, filePath), 'utf8'),
          source: 'working-tree' as const,
        };
      } catch {
        return null;
      }
    },
    commitStatus(): 'commit' {
      return 'commit';
    },
  };
}

function cloneState(includeStackedWork = false): EpicState {
  const state = structuredClone(STATE);
  const a0 = state.nodes.find((node) => node.node_id === 'slice:A0');
  if (!a0?.github.pr) throw new Error('Canonical A0 fixture is incomplete');
  // Keep lifecycle-transition tests on a stable pre-merge fixture while the
  // committed manifest advances with authoritative GitHub facts.
  a0.status = 'pr_open';
  a0.status_changed_at = '2026-07-17T18:25:00.000Z';
  a0.github.pr.head_sha = '90b6350ac82c835cf11802042d81f5547c6a96eb';
  a0.ownership = {
    claimant: 'Producer',
    session: '7b4a2e77-4353-401c-ab6f-2b7e9b6e3abd',
    source: 'parent-issue-bootstrap',
    scope: 'Durable control plane only; no equipment gameplay',
    claimed_at: '2026-07-17T17:32:38.205Z',
    lease_expires_at: '2026-07-25T18:26:00.000Z',
    heartbeat_at: '2026-07-17T21:00:00.000Z',
    base_commit: '41c5f2aa',
  };
  a0.merge = { commit: null, merged_at: null };
  a0.reconciliation = {
    last_audited_at: '2026-07-17T23:37:36.885Z',
    observed_issue_state: 'open',
    observed_pr_state: 'OPEN',
    observed_head_sha: '90b6350ac82c835cf11802042d81f5547c6a96eb',
    observed_merge_commit: null,
    drift: [],
  };
  const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
  if (a1) {
    a1.github.issue = null;
    a1.reconciliation.last_audited_at = null;
    a1.reconciliation.observed_issue_state = 'open';
  }
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

function validate(state: EpicState, planMarkdown = PLAN, schemaDocument: unknown = SCHEMA) {
  return validateEpicState(state, {
    repoRoot: REPO_ROOT,
    now: NOW,
    planMarkdown,
    schemaDocument,
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
      heartbeat_at: '2026-07-17T21:00:00.000Z',
    },
    dependency_pull_requests: [
      {
        node_id: 'slice:A0',
        tracking_issue: null,
        repository: 'nalfeo/Crawler',
        branch: 'nalfeo-floor-2-epic-control',
        pull_request: {
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
        url: 'https://github.com/nalfeo/Crawler/pull/1276',
      },
      observed_pr_state: 'OPEN',
      observed_head_sha: 'edce21919c72ded228deeed8fe41bd44ac33813e',
      observed_head_branch: 'nalfeo-floor-2-equipment-contracts',
      observed_base_branch: 'nalfeo-floor-2-epic-control',
    },
    last_resynced_dependency_head_sha: dependencyHead,
    last_resynced_at: '2026-07-17T21:00:00.000Z',
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
    readonly issueComments?: ReadonlyArray<AuditComment> | Error;
    readonly dependencyPull?: Record<string, unknown> | Error;
    readonly dependentPull?: Record<string, unknown> | Error;
  } = {},
): GithubRunner {
  const dependency = stacked.dependency_pull_requests[0]!;
  const defaultDependencyPull = {
    number: Number(dependency.pull_request.url.split('/').at(-1)),
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    merged_at: null,
    html_url: dependency.pull_request.url,
    head: { sha: dependency.head_sha, ref: dependency.branch },
    base: { ref: dependency.base_branch },
  };
  const defaultDependentPull = {
    number: Number(stacked.dependent.pull_request?.url.split('/').at(-1) ?? 1276),
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
      if (path.includes('/issues/1279/comments?')) {
        if (issueComments instanceof Error) throw issueComments;
        return issueComments;
      }
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
    expect(contract.graph.dependencies['slice:F2']).toEqual(['slice:F1', 'slice:B2']);
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

    const futureResync = stackedFixture();
    futureResync.stacked.last_resynced_at = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(validate(futureResync.state).errors.map((error) => error.code)).toContain(
      'stacked.resync-future',
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
      // claimed_at must be far enough in the past so heartbeat_at can be both
      // after it and still more than 48 h before NOW.
      stacked.owner.claimed_at = new Date(NOW.getTime() - 60 * 3_600_000).toISOString();
      stacked.owner.heartbeat_at = new Date(NOW.getTime() - 49 * 3_600_000).toISOString();
    });
    expectStackedDiagnostic('stacked.owner-heartbeat-future', ({ stacked }) => {
      stacked.owner.heartbeat_at = new Date(NOW.getTime() + 3_600_000).toISOString();
    });
    // Thread 1 regression: claimed_at and heartbeat chronology enforcement
    expectStackedDiagnostic('stacked.owner-claimed-future', ({ stacked }) => {
      stacked.owner.claimed_at = new Date(NOW.getTime() + 3_600_000).toISOString();
    });
    expectStackedDiagnostic('stacked.owner-heartbeat-before-claim', ({ stacked }) => {
      stacked.owner.heartbeat_at = new Date(
        Date.parse(stacked.owner.claimed_at) - 1000,
      ).toISOString();
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
    // Thread 4 regression: MERGED must also be rejected offline
    expectStackedDiagnostic('stacked.dependent-pr-closed', ({ stacked }) => {
      stacked.dependent.observed_pr_state = 'MERGED';
    });
    expectStackedDiagnostic('stacked.dependent-branch-drift', ({ stacked }) => {
      stacked.dependent.observed_head_branch = 'wrong-dependent-branch';
    });
    expectStackedDiagnostic('stacked.dependent-base-drift', ({ stacked }) => {
      stacked.dependent.observed_base_branch = 'wrong-dependent-base';
    });
    // Thread 8 regression: non-null observations without a backing PR
    expectStackedDiagnostic('stacked.dependent-observations-without-pr', ({ stacked }) => {
      stacked.state = 'stacked_in_progress';
      stacked.dependent.pull_request = null;
      // observed_pr_state remains 'OPEN' — an unverifiable claim with no PR
    });
  });

  it('rejects wrong dependent base when stack base is observed merged', () => {
    // Thread 5 regression: after mergedStackBase, base must be the stack-base branch or main.
    const mergeCommit = 'f'.repeat(40);
    expectStackedDiagnostic('stacked.wrong-base-after-merge', ({ stacked }) => {
      const dep = stacked.dependency_pull_requests[0]!;
      dep.observed_pr_state = 'MERGED';
      dep.observed_merge_commit = mergeCommit;
      stacked.rebase_to_main = {
        pending: true,
        pre_rebase_dependent_head_sha: stacked.dependent.observed_head_sha,
        prerequisite_merge_commit: mergeCommit,
      };
      // Use a base that is neither the stack-base branch nor main
      stacked.dependent.base_branch = 'release/foo';
      stacked.dependent.observed_base_branch = 'release/foo';
    });
    // Sanity: main is allowed after merge (no error from wrong-base-after-merge)
    const cleanFixture = stackedFixture();
    const dep = cleanFixture.stacked.dependency_pull_requests[0]!;
    dep.observed_pr_state = 'MERGED';
    dep.observed_merge_commit = mergeCommit;
    cleanFixture.stacked.rebase_to_main = {
      pending: true,
      pre_rebase_dependent_head_sha: cleanFixture.stacked.dependent.observed_head_sha,
      prerequisite_merge_commit: mergeCommit,
    };
    cleanFixture.stacked.dependent.base_branch = 'main';
    cleanFixture.stacked.dependent.observed_base_branch = 'nalfeo-floor-2-epic-control'; // not yet main on GitHub
    expect(validate(cleanFixture.state).errors.map((e) => e.code)).not.toContain(
      'stacked.wrong-base-after-merge',
    );
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
    const liveStacked = structuredClone(stacked);
    liveStacked.owner.claimed_at = '2026-07-17T21:00:00.000Z';
    liveStacked.owner.heartbeat_at = '2026-07-17T21:30:00.000Z';
    liveStacked.owner.lease_expires_at = '2026-07-19T23:00:00.000Z';
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
        if (path.includes('/issues/1264/comments?')) return [];
        if (path.includes('/issues/1279/comments?')) {
          return [
            {
              body: stackedClaimBody(liveStacked),
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
    expect(audit.errors.map((error) => error.code)).not.toContain('github.stacked-owner-missing');
    expect(audit.errors.map((error) => error.code)).not.toContain('github.stacked-owner-drift');
    expect(audit.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining('/stacked_work/dependency_pull_requests/0/observed_head_sha'),
        value: dependencyHead,
      }),
    );
    expect(audit.proposal.repo_patch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('/stacked_work/owner/claimed_at'),
          value: liveStacked.owner.claimed_at,
        }),
        expect.objectContaining({
          path: expect.stringContaining('/stacked_work/owner/lease_expires_at'),
          value: liveStacked.owner.lease_expires_at,
        }),
        expect.objectContaining({
          path: expect.stringContaining('/stacked_work/owner/heartbeat_at'),
          value: liveStacked.owner.heartbeat_at,
        }),
      ]),
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
          number: Number(dependency.pull_request.url.split('/').at(-1)),
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

  it('does not repeat non-open transition errors after cached observations match GitHub', () => {
    const prerequisite = stackedFixture();
    const dependency = prerequisite.stacked.dependency_pull_requests[0]!;
    const mergeCommit = 'e'.repeat(40);
    dependency.observed_pr_state = 'MERGED';
    dependency.observed_merge_commit = mergeCommit;
    const prerequisiteAudit = auditGithub(
      prerequisite.state,
      makeStackedAuditRunner(prerequisite.stacked, {
        dependencyPull: {
          number: Number(dependency.pull_request.url.split('/').at(-1)),
          state: 'closed',
          merged: true,
          merge_commit_sha: mergeCommit,
          merged_at: '2026-07-17T22:30:00.000Z',
          html_url: dependency.pull_request.url,
          head: { sha: dependency.head_sha, ref: dependency.branch },
          base: { ref: dependency.base_branch },
        },
      }),
      NOW,
    );
    expect(prerequisiteAudit.errors.map((error) => error.code)).not.toContain(
      'github.stacked-dependency-merged',
    );

    const dependent = stackedFixture();
    dependent.stacked.dependent.observed_pr_state = 'CLOSED';
    const dependentAudit = auditGithub(
      dependent.state,
      makeStackedAuditRunner(dependent.stacked, {
        dependentPull: {
          number: 1276,
          state: 'closed',
          merged: false,
          merge_commit_sha: null,
          merged_at: null,
          html_url: 'https://github.com/nalfeo/Crawler/pull/1276',
          head: {
            sha: dependent.stacked.dependent.observed_head_sha,
            ref: dependent.stacked.dependent.branch,
          },
          base: { ref: dependent.stacked.dependent.base_branch },
        },
      }),
      NOW,
    );
    expect(dependentAudit.errors.map((error) => error.code)).not.toContain(
      'github.stacked-dependent-not-open',
    );
  });

  it('always raises dependent-not-open for a MERGED dependent even when the cache already shows MERGED', () => {
    // Thread 4 regression: MERGED is an active lifecycle problem requiring Producer
    // clearance and must not be suppressed by idempotency, unlike CLOSED.
    const fixture = stackedFixture();
    fixture.stacked.dependent.observed_pr_state = 'MERGED';
    const mergeCommit = '9'.repeat(40);
    const audit = auditGithub(
      fixture.state,
      makeStackedAuditRunner(fixture.stacked, {
        dependentPull: {
          number: 1276,
          state: 'closed',
          merged: true,
          merge_commit_sha: mergeCommit,
          merged_at: '2026-07-17T21:50:00.000Z',
          html_url: 'https://github.com/nalfeo/Crawler/pull/1276',
          head: {
            sha: fixture.stacked.dependent.observed_head_sha,
            ref: fixture.stacked.dependent.branch,
          },
          base: { ref: fixture.stacked.dependent.base_branch },
        },
      }),
      NOW,
    );
    expect(audit.errors.map((error) => error.code)).toContain('github.stacked-dependent-not-open');
  });

  it('proposes to null stale dependent observations when no dependent PR exists', () => {
    // Thread 8 regression: GitHub audit must propose nulling stale observation cache
    // when stacked_in_progress has no dependent PR.
    const fixture = stackedFixture();
    fixture.stacked.state = 'stacked_in_progress';
    fixture.stacked.dependent.pull_request = null;
    // Leave stale observations from a prior stacked_pr_open phase
    // (observed_pr_state = 'OPEN', observed_head_sha etc. all non-null)

    const audit = auditGithub(fixture.state, makeStackedAuditRunner(fixture.stacked, {}), NOW);

    const patchPaths = audit.proposal.repo_patch.map((p) => p.path);
    expect(patchPaths.some((p) => p.includes('/dependent/observed_pr_state'))).toBe(true);
    expect(patchPaths.some((p) => p.includes('/dependent/observed_head_sha'))).toBe(true);
    expect(patchPaths.some((p) => p.includes('/dependent/observed_head_branch'))).toBe(true);
    expect(patchPaths.some((p) => p.includes('/dependent/observed_base_branch'))).toBe(true);
    expect(
      audit.proposal.repo_patch.find((p) => p.path.includes('/dependent/observed_pr_state')),
    ).toMatchObject({ value: null });
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

  it('does not report missing stacked ownership when the owner issue audit fails', () => {
    const fixture = stackedFixture();
    const audit = auditGithub(
      fixture.state,
      makeStackedAuditRunner(fixture.stacked, {
        issueComments: new Error('comments unavailable'),
      }),
      NOW,
    );

    expect(audit.errors.map((error) => error.code)).toContain('github.issue-audit');
    expect(audit.errors.map((error) => error.code)).not.toContain('github.stacked-owner-missing');
  });

  it('rejects a future-dated stacked heartbeat and retains the valid older owner', () => {
    // Thread 2 regression: a claim with heartbeat_at > now must be filtered with
    // github.stacked-future-heartbeat before it can influence claim selection.
    // The chronologically valid older comment must survive and keep the owner active.
    const fixture = stackedFixture();
    const futureHeartbeat = structuredClone(fixture.stacked);
    futureHeartbeat.owner.heartbeat_at = '2026-07-17T22:30:00.000Z'; // 30 min future from NOW
    futureHeartbeat.owner.lease_expires_at = '2026-07-17T21:59:59.000Z'; // expired lease
    const audit = auditGithub(
      fixture.state,
      makeStackedAuditRunner(fixture.stacked, {
        issueComments: [
          {
            body: stackedClaimBody(fixture.stacked),
            author_association: 'OWNER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-valid',
          },
          {
            body: stackedClaimBody(futureHeartbeat),
            author_association: 'OWNER',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-future',
          },
        ],
      }),
      NOW,
    );

    // The future-dated heartbeat is diagnosed and excluded
    expect(audit.errors.map((error) => error.code)).toContain('github.stacked-future-heartbeat');
    // The valid older claim still makes the owner active — no missing-owner error
    expect(audit.errors.map((error) => error.code)).not.toContain('github.stacked-owner-missing');
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

  it('suppresses the ready queue when global validation errors exist', () => {
    const state = cloneState();
    validateA0(state);
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (a1) {
      a1.github.issue = {
        number: 9002,
        url: 'https://github.com/nalfeo/Crawler/issues/9002',
      };
    }
    state.plan.contract_sha256 = '0'.repeat(64);

    const result = validate(state);

    expect(result.errors.map((error) => error.code)).toContain('plan.contract-drift');
    expect(result.ready_queue).toEqual([]);
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

  it('rejects whitespace-only ownership metadata', () => {
    const state = cloneState();
    state.nodes[0]!.ownership.claimant = '   ';
    state.nodes[0]!.ownership.session = ' ';
    state.nodes[0]!.ownership.scope = '\t';

    const result = validate(state);

    expect(result.errors.map((error) => error.code)).toContain('state.schema');
    expect(result.errors.map((error) => error.message).join('\n')).toContain('ownership.claimant');
    expect(result.errors.map((error) => error.message).join('\n')).toContain('ownership.session');
    expect(result.errors.map((error) => error.message).join('\n')).toContain('ownership.scope');
  });

  it('rejects whitespace-only stacked owner identity fields', () => {
    // Thread 6 regression: stacked owner claimant/session/branch must use
    // nonEmptyTrimmedString to reject semantically empty values.
    expectStackedDiagnostic('state.schema', ({ stacked }) => {
      stacked.owner.claimant = '   ';
    });
    expectStackedDiagnostic('state.schema', ({ stacked }) => {
      stacked.owner.session = '   ';
    });
    expectStackedDiagnostic('state.schema', ({ stacked }) => {
      stacked.owner.branch = '   ';
    });
  });

  it('rejects mismatched issue and PR number/url pairs', () => {
    const state = cloneState();
    state.github.parent_issue = {
      number: 1264,
      url: 'https://github.com/nalfeo/Crawler/issues/9999',
    };
    state.nodes[0]!.github.pr = {
      number: 1271,
      url: 'https://github.com/nalfeo/Crawler/pull/8888',
      head_sha: FULL_COMMIT,
    };

    const messages = validate(state).errors.map((error) => error.message);

    expect(messages.some((message) => message.includes('Issue URL does not match number'))).toBe(
      true,
    );
    expect(messages.some((message) => message.includes('PR URL does not match number'))).toBe(true);
  });

  it('uses canonical URLs as the sole stacked PR identity in runtime and JSON Schema', () => {
    const fixture = stackedFixture();
    expect(validate(fixture.state).errors).toEqual([]);
    expect(fixture.stacked.dependency_pull_requests[0]!.pull_request).toEqual({
      url: 'https://github.com/nalfeo/Crawler/pull/1271',
    });

    const drifted = structuredClone(SCHEMA) as {
      $defs: {
        prIdentity: {
          required: string[];
          properties: Record<string, unknown>;
        };
      };
    };
    drifted.$defs.prIdentity.required.push('number');
    drifted.$defs.prIdentity.properties.number = { type: 'integer', minimum: 1 };

    expect(validate(cloneState(), PLAN, drifted).errors.map((error) => error.code)).toContain(
      'schema.contract-parity',
    );
  });

  it('rejects unverifiable required evidence paths for validated nodes', () => {
    const state = cloneState();
    validateA0(state);
    state.nodes[0]!.evidence[2] = {
      kind: 'offline-validator-and-focused-tests',
      path_or_check: 'tests/unit/agent/does-not-exist.test.ts',
      sha256: CURRENT_TEST_FILE_HASH,
      commit: LEDGER_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    };

    expect(validate(state).errors.map((error) => error.code)).toContain(
      'evidence.git-verification-failed',
    );
  });

  it('rejects merge facts that point at a non-commit git object', () => {
    const state = cloneState();
    validateA0(state);
    // Use HEAD^{tree} rather than a hardcoded commit SHA that may not be
    // present in shallow CI checkouts. We only need any tree object SHA to
    // verify the validator correctly rejects non-commit objects.
    const treeObject = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    state.nodes[0]!.status = 'merged';
    state.nodes[0]!.merge = {
      commit: treeObject,
      merged_at: '2026-07-17T17:50:00.000Z',
    };

    const result = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
    });

    expect(result.errors.map((error) => error.code)).toContain('merge.not-a-commit');
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

  it('rejects active cached ownership when no live trusted CLAIMED comment exists', () => {
    const state = cloneState();
    state.nodes[0]!.ownership.claimant = 'Producer';
    state.nodes[0]!.ownership.session = '7b4a2e77-4353-401c-ab6f-2b7e9b6e3abd';
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
          return {
            number: 1271,
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            merged_at: null,
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: { sha: FULL_COMMIT },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((error) => error.code)).toContain('github.missing-live-claim');
    expect(audit.proposal.operator_actions.some((action) => action.includes('slice:A0'))).toBe(
      true,
    );
  });

  it('flags advanced PR heads when head-bound evidence is still pinned to the older commit', () => {
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
        if (path.includes('/issues/1264/comments?per_page=100&page=1')) {
          return [
            {
              body: [
                'CLAIMED',
                'node: slice:A0',
                'claimant: Producer',
                'session: 7b4a2e77-4353-401c-ab6f-2b7e9b6e3abd',
                'expires_at: 2026-07-18T18:00:00.000Z',
                'claimed_at: 2026-07-17T17:32:38.205Z',
                `base_commit: ${HANDOFF_COMMIT}`,
                'scope: Slice A0 control plane only; no gameplay',
              ].join('\n'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-1',
            },
          ];
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

    expect(audit.errors.map((error) => error.code)).toContain('github.stale-pr-evidence');
    expect(audit.proposal.repo_patch).toContainEqual(
      expect.objectContaining({
        path: '/nodes/0/reconciliation/observed_head_sha',
        value: advancedHead,
      }),
    );
    expect(audit.proposal.repo_patch.map((patch) => patch.path)).not.toContain(
      '/nodes/0/github/pr/head_sha',
    );
  });

  it('does not treat post-merge source-branch head drift as stale review evidence', () => {
    const state = cloneState();
    const a0 = state.nodes[0]!;
    validateA0(state);
    a0.status = 'merged';
    a0.merge = {
      commit: TEST_MERGE_COMMIT,
      merged_at: '2026-07-17T17:50:00.000Z',
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
        if (path.includes('/issues/1264/comments?per_page=100&page=1')) {
          return [
            {
              body: [
                'CLAIMED',
                'node: slice:A0',
                'claimant: Producer',
                'session: 7b4a2e77-4353-401c-ab6f-2b7e9b6e3abd',
                'expires_at: 2026-07-18T18:00:00.000Z',
                'claimed_at: 2026-07-17T17:32:38.205Z',
                `base_commit: ${HANDOFF_COMMIT}`,
                'scope: Slice A0 control plane only; no gameplay',
              ].join('\n'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-1',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=1')) return [];
        if (path.endsWith('/pulls/1271')) {
          return {
            number: 1271,
            state: 'closed',
            merged: true,
            merge_commit_sha: TEST_MERGE_COMMIT,
            merged_at: '2026-07-17T17:50:00.000Z',
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: { sha: 'b'.repeat(40) },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((error) => error.code)).not.toContain('github.stale-pr-evidence');
  });

  it('rejects stale heartbeat (exceeds maximum_without_heartbeat_hours)', () => {
    const state = cloneState();
    // Set heartbeat_at 49 hours before NOW (exceeds 48-hour maximum)
    const staleHeartbeat = new Date(NOW.getTime() - 49 * 3_600_000).toISOString();
    state.nodes[0]!.ownership.heartbeat_at = staleHeartbeat;

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('ownership.stale-heartbeat');
  });

  it('rejects future heartbeat_at on ownership (bypasses staleness check)', () => {
    const state = cloneState();
    // Set heartbeat_at 1 hour in the future — must be rejected, not silently ignored
    state.nodes[0]!.ownership.heartbeat_at = new Date(NOW.getTime() + 3_600_000).toISOString();

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('ownership.heartbeat-future');
    expect(codes).not.toContain('ownership.stale-heartbeat');
  });

  it('rejects non-canonical evidence paths for handoff and review-ledger', () => {
    const state = cloneState();
    validateA0(state);
    // Replace handoff with a non-canonical path (not in docs/knowledge/handoffs/)
    state.nodes[0]!.evidence[0]!.path_or_check = 'docs/knowledge/epics/floor-2-equipment/PLAN.md';

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('evidence.non-canonical-path');
  });

  it('rejects path-traversal evidence paths', () => {
    const state = cloneState();
    validateA0(state);
    state.nodes[0]!.evidence[2]!.path_or_check = '../outside-repo.txt';

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('evidence.unsafe-path');
  });

  it('accepts valid check:run/<id> evidence references', () => {
    const state = cloneState();
    validateA0(state);
    // Replace the offline-validator evidence (index 2) with a check: reference
    state.nodes[0]!.evidence[2] = {
      ...state.nodes[0]!.evidence[2]!,
      path_or_check: 'check:run/12345678',
    };

    const codes = validate(state).errors.map((error) => error.code);

    // No evidence.unsafe-path — check:run/<id> is an allowlisted scheme
    expect(codes).not.toContain('evidence.unsafe-path');
  });

  it('accepts valid check:job/<id> evidence references', () => {
    const state = cloneState();
    validateA0(state);
    state.nodes[0]!.evidence[2] = {
      ...state.nodes[0]!.evidence[2]!,
      path_or_check: 'check:job/99999999',
    };

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).not.toContain('evidence.unsafe-path');
  });

  it('rejects arbitrary URI schemes as evidence references', () => {
    const state = cloneState();
    validateA0(state);
    // A non-check: scheme must be rejected even if syntactically URI-like
    state.nodes[0]!.evidence[2] = {
      ...state.nodes[0]!.evidence[2]!,
      path_or_check: 'fake:anything',
    };

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('evidence.unsafe-path');
  });

  it('rejects check: URI with unsupported resource type', () => {
    const state = cloneState();
    validateA0(state);
    // check:workflow/<id> is not an allowlisted resource type
    state.nodes[0]!.evidence[2] = {
      ...state.nodes[0]!.evidence[2]!,
      path_or_check: 'check:workflow/12345678',
    };

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('evidence.unsafe-path');
  });

  it('rejects javascript: URI scheme as evidence reference', () => {
    const state = cloneState();
    validateA0(state);
    state.nodes[0]!.evidence[2] = {
      ...state.nodes[0]!.evidence[2]!,
      path_or_check: 'javascript:alert(1)',
    };

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('evidence.unsafe-path');
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

  it('rejects canonical parent-slice drift', () => {
    const state = cloneState();
    const d2a = state.nodes.find((node) => node.node_id === 'packet:D2-A');
    expect(d2a).toBeDefined();
    if (d2a) d2a.parent_slice = 'slice:Z9';

    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).toContain('dag.parent-slice-contract-drift');
  });

  it('rejects duplicate node_id entries', () => {
    const state = cloneState();
    const a0 = state.nodes.find((node) => node.node_id === 'slice:A0');
    expect(a0).toBeDefined();
    if (a0) {
      // Duplicate the node to simulate a state where node_id uniqueness is violated.
      state.nodes.push({ ...a0 });
    }

    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).toContain('dag.duplicate-node-id');
  });

  it('detects committed JSON Schema parity drift when node constraints are loosened', () => {
    const loosened = structuredClone(SCHEMA) as {
      $defs: { node: { additionalProperties: boolean; required?: string[] } };
    };
    loosened.$defs.node.additionalProperties = true;
    delete loosened.$defs.node.required;

    const codes = validate(cloneState(), PLAN, loosened).errors.map((error) => error.code);

    expect(codes).toContain('schema.contract-parity');
  });

  it('detects committed JSON Schema drift in root consts and GitHub URL patterns', () => {
    const drifted = structuredClone(SCHEMA) as {
      properties: {
        schema_version: { const: string };
      };
      $defs: {
        issueRef: { properties: { url: { pattern: string } } };
      };
    };
    drifted.properties.schema_version.const = 'crawler-epic-state/v2';
    drifted.$defs.issueRef.properties.url.pattern = '^https://example.com/issues/[0-9]+$';

    const codes = validate(cloneState(), PLAN, drifted).errors.map((error) => error.code);

    expect(codes).toContain('schema.contract-parity');
  });

  it('detects committed JSON Schema drift in stacked PR identity contracts', () => {
    const drifted = structuredClone(SCHEMA) as {
      $defs: {
        prIdentity: { properties: { url: { pattern: string } } };
        nullablePrIdentity: { anyOf: Array<Record<string, unknown>> };
        stackedDependency: { properties: { pull_request: { $ref: string } } };
        stackedDependent: { properties: { pull_request: { $ref: string } } };
      };
    };
    drifted.$defs.prIdentity.properties.url.pattern = '^https://example.com/pull/[0-9]+$';
    drifted.$defs.nullablePrIdentity.anyOf[0] = { $ref: '#/$defs/prRef' };
    drifted.$defs.stackedDependency.properties.pull_request.$ref = '#/$defs/prRef';
    drifted.$defs.stackedDependent.properties.pull_request.$ref = '#/$defs/nullablePrRef';

    const codes = validate(cloneState(), PLAN, drifted).errors.map((error) => error.code);

    expect(codes).toContain('schema.contract-parity');
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
    expect(audit.errors.map((e) => e.code)).not.toContain('github.duplicate-live-claims');
    expect(
      audit.proposal.operator_actions.some((a) =>
        a.includes('Ownership of slice:A0 was revoked by a BLOCKED event'),
      ),
    ).toBe(true);
  });

  it('suppresses revoke actions when a later CLAIMED comment re-establishes ownership', () => {
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
              body: makeClaim('2026-07-17T16:00:00.000Z'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-20',
            },
            {
              body: ['BLOCKED', 'node: slice:A0', 'reason: dependency unresolved'].join('\n'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-21',
            },
            {
              body: makeClaim('2026-07-17T17:00:00.000Z'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-22',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(
      audit.proposal.operator_actions.some((a) =>
        a.includes('Ownership of slice:A0 was revoked by a BLOCKED event'),
      ),
    ).toBe(false);
  });

  it('does not emit revoke action when cache is already unclaimed after BLOCKED', () => {
    const state = cloneState();
    const a0 = state.nodes.find((node) => node.node_id === 'slice:A0');
    expect(a0).toBeDefined();
    if (a0) {
      a0.status = 'blocked';
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
    }
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
              body: ['BLOCKED', 'node: slice:A0', 'reason: dependency unresolved'].join('\n'),
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
    expect(
      audit.proposal.operator_actions.some((a) =>
        a.includes('Ownership of slice:A0 was revoked by a BLOCKED event'),
      ),
    ).toBe(false);
  });

  it('accepts trusted BLOCKED events without node field when expected node is known', () => {
    const state = cloneState();
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
              body: ['BLOCKED', 'reason: dependency unresolved'].join('\n'),
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
    expect(
      audit.proposal.operator_actions.some((a) =>
        a.includes('Ownership of slice:A0 was revoked by a BLOCKED event'),
      ),
    ).toBe(true);
  });

  it('does not collapse competing claimants that share a session id', () => {
    const state = cloneState();
    const makeClaim = (claimant: string): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        `claimant: ${claimant}`,
        'session: shared-session',
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
        if (path.includes('/comments?per_page=100&page=1')) {
          return [
            {
              body: makeClaim('agent-a'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-30',
            },
            {
              body: makeClaim('agent-b'),
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

    expect(audit.errors.map((e) => e.code)).toContain('github.duplicate-live-claims');
  });

  it('lets a later expired replacement revoke an earlier live claim for the same claimant/session', () => {
    const state = cloneState();
    const makeClaim = (claimedAt: string, expiresAt: string): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        'claimant: agent-a',
        'session: session-x',
        `expires_at: ${expiresAt}`,
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
          return [
            {
              body: makeClaim('2026-07-17T16:00:00.000Z', '2026-07-18T18:00:00.000Z'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-40',
            },
            {
              body: makeClaim('2026-07-17T17:00:00.000Z', '2026-07-17T17:30:00.000Z'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-41',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((e) => e.code)).not.toContain('github.duplicate-live-claims');
    expect(audit.proposal.operator_actions.filter((a) => a.includes('session-x'))).toHaveLength(0);
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
        if (path.includes('/issues/1264/comments?per_page=100&page=1')) {
          return [
            {
              body: [
                'CLAIMED',
                'node: slice:A0',
                'claimant: Producer',
                'session: 7b4a2e77-4353-401c-ab6f-2b7e9b6e3abd',
                'expires_at: 2026-07-18T18:00:00.000Z',
                'claimed_at: 2026-07-17T17:32:38.205Z',
                `base_commit: ${HANDOFF_COMMIT}`,
                'scope: Slice A0 control plane only; no gameplay',
              ].join('\n'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-1',
            },
          ];
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

  it('treats stacked_work: null as cleared metadata for readiness', () => {
    const state = cloneState();
    validateA0(state);
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (a1) {
      a1.github.issue = {
        number: 9002,
        url: 'https://github.com/nalfeo/Crawler/issues/9002',
      };
      a1.stacked_work = null;
    }

    const result = validate(state);

    expect(result.errors).toEqual([]);
    expect(result.ready_queue).toContain('slice:A1');
  });
});

describe('applyGithubAudit', () => {
  it('keeps release_ready false when GitHub audit adds errors', () => {
    // Build a mock offline result with release_ready: true so that
    // only the audit errors can flip the release gate.
    const offlineReady: ValidationResult = {
      state: null,
      errors: [],
      warnings: [],
      blockers: [],
      ready_queue: ['slice:A1'],
      release_ready: true,
      proposal: { repo_patch: [], operator_actions: [] },
    };
    const combined = applyGithubAudit(offlineReady, {
      errors: [{ code: 'github.synthetic-error', message: 'synthetic audit failure' }],
      warnings: [],
      proposal: { repo_patch: [], operator_actions: [] },
    });

    expect(combined.release_ready).toBe(false);
    expect(combined.errors.map((error) => error.code)).toContain('github.synthetic-error');
    // ready_queue must be suppressed when audit has errors (GitHub facts are stronger authority)
    expect(combined.ready_queue).toEqual([]);
  });

  it('merges warnings and reconciliation proposals when the audit is clean', () => {
    const offline = validate(cloneState());
    const combined = applyGithubAudit(offline, {
      errors: [],
      warnings: [{ code: 'github.synthetic-warning', message: 'synthetic audit warning' }],
      proposal: {
        repo_patch: [{ op: 'replace', path: '/plan/contract_sha256', value: 'x', reason: 'test' }],
        operator_actions: ['follow up'],
      },
    });

    expect(combined.warnings.map((warning) => warning.code)).toContain('github.synthetic-warning');
    expect(combined.proposal.repo_patch).toContainEqual(
      expect.objectContaining({ path: '/plan/contract_sha256' }),
    );
    expect(combined.proposal.operator_actions).toContain('follow up');
  });

  it('preserves release_ready true when offline is ready and audit is clean', () => {
    const offlineReady: ValidationResult = {
      state: null,
      errors: [],
      warnings: [],
      blockers: [],
      ready_queue: [],
      release_ready: true,
      proposal: { repo_patch: [], operator_actions: [] },
    };
    const combined = applyGithubAudit(offlineReady, {
      errors: [],
      warnings: [],
      proposal: { repo_patch: [], operator_actions: [] },
    });

    expect(combined.release_ready).toBe(true);
    expect(combined.errors).toEqual([]);
  });
});

describe('validateEvidenceRequirements', () => {
  it('supports legacy GitReader shape (showContent + commitExists + not-a-commit status)', () => {
    const state = cloneState();
    const node = state.nodes[0]!;
    node.status = 'validated';
    node.merge = {
      commit: TEST_MERGE_COMMIT,
      merged_at: '2026-07-17T20:00:00.000Z',
    };
    node.evidence = [
      {
        kind: 'offline-validator-and-focused-tests',
        path_or_check: 'tests/unit/agent/epic-status.test.ts',
        sha256: sha256OfFile(REPO_ROOT, 'tests/unit/agent/epic-status.test.ts'),
        commit: HANDOFF_COMMIT,
        recorded_at: '2026-07-17T20:01:00.000Z',
      },
    ];
    const legacyReader: GitReader = {
      commitStatus(sha) {
        if (sha === TEST_MERGE_COMMIT) return 'not-a-commit';
        return 'commit';
      },
      commitExists: () => true,
      showContent(_commit, filePath) {
        return readFileSync(resolve(REPO_ROOT, filePath), 'utf8');
      },
    };

    const result = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      schemaDocument: SCHEMA,
      gitReader: legacyReader,
    });

    expect(result.errors.map((error) => error.code)).toContain('merge.not-a-commit');
  });

  it('accepts current not-commit status from commitStatus', () => {
    const state = cloneState();
    const node = state.nodes[0]!;
    node.status = 'validated';
    node.merge = {
      commit: TEST_MERGE_COMMIT,
      merged_at: '2026-07-17T20:00:00.000Z',
    };
    node.evidence = [
      {
        kind: 'offline-validator-and-focused-tests',
        path_or_check: 'tests/unit/agent/epic-status.test.ts',
        sha256: sha256OfFile(REPO_ROOT, 'tests/unit/agent/epic-status.test.ts'),
        commit: HANDOFF_COMMIT,
        recorded_at: '2026-07-17T20:01:00.000Z',
      },
    ];
    const reader: GitReader = {
      commitStatus(sha) {
        if (sha === TEST_MERGE_COMMIT) return 'not-commit';
        return 'commit';
      },
      readContent(commit, filePath) {
        return {
          content: readFileSync(resolve(REPO_ROOT, filePath), 'utf8'),
          source: commit === HANDOFF_COMMIT ? 'working-tree' : 'git',
        };
      },
    };

    const result = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      schemaDocument: SCHEMA,
      gitReader: reader,
    });

    expect(result.errors.map((error) => error.code)).toContain('merge.not-a-commit');
  });

  it('maps legacy commitExists=false to missing commit status', () => {
    const legacyReader: GitReader = {
      commitExists: () => false,
      showContent: () => null,
    };
    const state = cloneState();
    const node = state.nodes[0]!;
    node.status = 'validated';
    node.merge = {
      commit: TEST_MERGE_COMMIT,
      merged_at: '2026-07-17T20:00:00.000Z',
    };

    const result = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      schemaDocument: SCHEMA,
      gitReader: legacyReader,
    });

    expect(result.errors.map((error) => error.code)).toContain('merge.commit-not-found');
  });

  it('production git reader rejects non-commit git objects', () => {
    let commitSha: string;
    let blobSha: string;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      blobSha = execFileSync('git', ['rev-parse', 'HEAD:package.json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
    } catch {
      // Skip when git is unavailable or not in a repository.
      return;
    }

    const reader = createDefaultGitReader(REPO_ROOT);
    expect(reader.commitStatus(commitSha)).toBe('commit');
    expect(reader.commitStatus(blobSha)).toBe('not-commit');
  });

  it('rejects a validated node with a fabricated commit in file-backed evidence', () => {
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
          // Use the offline-validator test file as the path (file-backed evidence kind)
          path_or_check: 'tests/unit/agent/epic-status.test.ts',
        };
      }
      return e;
    });

    // Use a reader that only recognises the known commits, not the fabricated one.
    const knownCommits = new Set([HANDOFF_COMMIT, LEDGER_COMMIT]);
    const strictReader: GitReader = {
      commitStatus(sha) {
        return knownCommits.has(sha) ? 'commit' : 'missing';
      },
      readContent(commit, filePath) {
        if (!knownCommits.has(commit)) return null;
        try {
          return {
            content: readFileSync(resolve(REPO_ROOT, filePath), 'utf8'),
            source: 'working-tree' as const,
          };
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
