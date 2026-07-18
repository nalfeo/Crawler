import { execFileSync } from 'node:child_process';
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
const NOW = new Date('2026-07-17T18:00:00.000Z');
const FULL_COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
// Placeholder SHAs used in evidence entries – the working-tree git reader ignores
// the commit parameter and reads from disk, so these only need to be valid SHA-40s.
const HANDOFF_COMMIT = '461b8a334a018ebbf6e81aa7b31f81c74e08aa6b';
const LEDGER_COMMIT = '065591b1717588fd7acdb8e28936946e4a7e63e6';
const TEST_MERGE_COMMIT = HANDOFF_COMMIT;
// This test file is itself the immutable evidence target for A0, so any static hash
// embedded here would immediately drift when the file changes. Compute the current
// working-tree hash once and use it only for the in-test fixture normalization.
const CURRENT_TEST_FILE_HASH = createHash('sha256')
  .update(readFileSync(resolve(REPO_ROOT, 'tests', 'unit', 'agent', 'epic-status.test.ts'), 'utf8'))
  .digest('hex');

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

function cloneState(): EpicState {
  const state = structuredClone(STATE);
  state.nodes[0]!.reconciliation.drift = [];
  state.reconciliation.drift = [];
  const a0TestEvidence = state.nodes[0]!.evidence.find(
    (evidence) => evidence.kind === 'offline-validator-and-focused-tests',
  );
  if (a0TestEvidence) a0TestEvidence.sha256 = CURRENT_TEST_FILE_HASH;
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
  a0.evidence = [
    {
      kind: 'handoff',
      path_or_check: 'docs/knowledge/handoffs/2026-07-17-floor-2-equipment-epic-control.md',
      sha256: '9d3dfa5fb7214032f0ff73cbc64a9da62e8c584291257bfb154bbb950910bfeb',
      commit: HANDOFF_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
    {
      kind: 'review-ledger',
      path_or_check:
        'docs/knowledge/review-ledgers/2026-07-17-floor-2-epic-control.review-ledger.json',
      sha256: 'fa7d39e5a5e9dcc867ffdbc25ccf6b33c0f0ca86edc229cd8403b97df1316afa',
      commit: LEDGER_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
    {
      kind: 'offline-validator-and-focused-tests',
      path_or_check: 'tests/unit/agent/epic-status.test.ts',
      sha256: CURRENT_TEST_FILE_HASH,
      commit: LEDGER_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
  ];
}

describe('Floor 2 equipment epic status', () => {
  it('accepts the canonical 37-node graph and preserves the approved contract', () => {
    const result = validate(cloneState());
    const contract = extractPlanContract(PLAN).contract;
    const a0TestEvidence = STATE.nodes[0]!.evidence.find(
      (evidence) => evidence.kind === 'offline-validator-and-focused-tests',
    );

    expect(result.errors).toEqual([]);
    expect(a0TestEvidence?.sha256).toBe(CURRENT_TEST_FILE_HASH);
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

  it('rejects whitespace-only active ownership metadata', () => {
    const state = cloneState();
    state.nodes[0]!.status = 'claimed';
    state.nodes[0]!.ownership = {
      claimant: '   ',
      session: '\t',
      source: 'parent-issue-bootstrap',
      scope: '  ',
      claimed_at: '2026-07-17T17:00:00.000Z',
      lease_expires_at: '2026-07-18T17:00:00.000Z',
      heartbeat_at: '2026-07-17T17:00:00.000Z',
      base_commit: HANDOFF_COMMIT,
    };

    expect(validate(state).errors.map((error) => error.code)).toContain('state.schema');
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

    expect(
      messages.some((message) => message.includes('Issue URL trailing number must match')),
    ).toBe(true);
    expect(messages.some((message) => message.includes('PR URL trailing number must match'))).toBe(
      true,
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
    const treeObject = execFileSync('git', ['rev-parse', `${HANDOFF_COMMIT}^{tree}`], {
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

    expect(withoutParent).toHaveLength(EXPECTED_NODE_IDS.length - 1);
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

  it('treats a later trusted BLOCKED comment as revoking earlier live claims', () => {
    const state = cloneState();
    state.nodes[0]!.status = 'blocked';
    state.nodes[0]!.ownership = {
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
        if (path.includes('/comments?per_page=100&page=1')) {
          return [
            {
              body: [
                'CLAIMED',
                'node: slice:A0',
                'claimant: released-agent',
                'session: released-session',
                'expires_at: 2026-07-18T18:00:00.000Z',
                'claimed_at: 2026-07-17T17:00:00.000Z',
                `base_commit: ${HANDOFF_COMMIT}`,
                'scope: Slice A0 control plane only',
              ].join('\n'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-200',
            },
            {
              body: ['BLOCKED', 'node: slice:A0', 'reason: waiting on dependency'].join('\n'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-201',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((error) => error.code)).not.toContain('github.duplicate-live-claims');
    expect(
      audit.proposal.operator_actions.some((action) => action.includes('live CLAIMED comment')),
    ).toBe(false);
  });

  describe('Stacked-work protocol', () => {
    const DEP_HEAD = 'a'.repeat(40);
    const DEP_RESYNC_HEAD = 'b'.repeat(40);
    const DEPENDENT_HEAD = 'c'.repeat(40);

    /** Build a valid stacked_work object for A1, based on A0's PR. */
    function makeStackedWork(overrides?: Record<string, unknown>): Record<string, unknown> {
      return {
        status: 'stacked_in_progress',
        owner: {
          claimant: 'stacked-agent',
          session: 'stacked-session-1',
          branch: 'nalfeo-floor-2-stacked-work-protocol',
          claimed_at: '2026-07-17T10:00:00.000Z',
        },
        dependency: {
          node_id: 'slice:A0',
          pr_number: 1271,
          repository: 'nalfeo/Crawler',
          branch: 'nalfeo-floor-2-epic-control',
          head_sha: DEP_HEAD,
        },
        dependent: {
          head_sha: DEPENDENT_HEAD,
          pr_number: null,
        },
        resync: {
          head_sha: DEP_RESYNC_HEAD,
          at: '2026-07-17T17:00:00.000Z', // 1 hour before NOW — fresh
        },
        rebase_to_main: {
          state: 'pending',
          completed_at: null,
        },
        material_drift: null,
        block_reason: null,
        ...overrides,
      };
    }

    /** Set A1 up with a github.issue and stacked_work; A0 has a PR for cross-validation. */
    function setA1Stacked(state: EpicState, overrides?: Record<string, unknown>): void {
      const a0 = state.nodes.find((n) => n.node_id === 'slice:A0')!;
      a0.github.pr = {
        number: 1271,
        url: 'https://github.com/nalfeo/Crawler/pull/1271',
        head_sha: FULL_COMMIT,
      };
      const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
      a1.github.issue = {
        number: 1281,
        url: 'https://github.com/nalfeo/Crawler/issues/1281',
      };
      // cast through unknown to avoid strict typing on the test helper
      (a1 as unknown as Record<string, unknown>)['stacked_work'] = makeStackedWork(overrides);
    }

    it('accepts valid stacked_work on a blocked node', () => {
      const state = cloneState();
      setA1Stacked(state);

      const result = validate(state);

      expect(result.errors.filter((e) => e.code.startsWith('stacked.'))).toEqual([]);
    });

    it('rejects stacked_work when lifecycle status is not blocked', () => {
      const state = cloneState();
      setA1Stacked(state);
      const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
      a1.status = 'ready';
      a1.github.issue = {
        number: 1281,
        url: 'https://github.com/nalfeo/Crawler/issues/1281',
      };

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.non-blocked-status');
    });

    it('rejects stacked_work when node has no materialized issue', () => {
      const state = cloneState();
      setA1Stacked(state);
      const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
      a1.github.issue = null;

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.missing-issue');
    });

    it('rejects stacked_work with stale resync (exceeds 48 hours)', () => {
      // 49 hours before NOW = 2026-07-15T17:00:00Z (stale)
      const staleAt = new Date(NOW.getTime() - 49 * 3_600_000).toISOString();
      const state = cloneState();
      setA1Stacked(state, { resync: { head_sha: DEP_RESYNC_HEAD, at: staleAt } });

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.stale-resync');
    });

    it('rejects stacked_work on a verification-lane node (invalid lane)', () => {
      const state = cloneState();
      // Use slice:J which is the last node — we re-assign its lane temporarily
      const sliceJ = state.nodes.find((n) => n.node_id === 'slice:J')!;
      const originalLane = sliceJ.execution_lane;
      sliceJ.execution_lane = 'verification';
      // Give slice:J a github.issue and stacked_work pointing to one of its real deps
      sliceJ.github.issue = {
        number: 9100,
        url: 'https://github.com/nalfeo/Crawler/issues/9100',
      };
      const firstDep = sliceJ.dependencies[0]!;
      (sliceJ as unknown as Record<string, unknown>)['stacked_work'] = makeStackedWork({
        dependency: {
          node_id: firstDep,
          pr_number: 9999,
          repository: 'nalfeo/Crawler',
          branch: 'some-branch',
          head_sha: DEP_HEAD,
        },
      });

      const codes = validate(state).errors.map((e) => e.code);

      sliceJ.execution_lane = originalLane; // restore for other tests
      expect(codes).toContain('stacked.invalid-lane');
    });

    it('rejects stacked_pr_open without a dependent pr_number', () => {
      const state = cloneState();
      setA1Stacked(state, {
        status: 'stacked_pr_open',
        dependent: { head_sha: DEPENDENT_HEAD, pr_number: null },
      });

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.pr-open-missing-number');
    });

    it('rejects stacked_work when dependency.node_id is not in node.dependencies', () => {
      const state = cloneState();
      setA1Stacked(state, {
        dependency: {
          node_id: 'slice:B1', // A1 only depends on A0, not B1
          pr_number: 9998,
          repository: 'nalfeo/Crawler',
          branch: 'some-branch',
          head_sha: DEP_HEAD,
        },
      });

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.dependency-node-mismatch');
    });

    it('rejects stacked_work when dependency.pr_number mismatches the tracked dependency PR', () => {
      const state = cloneState();
      // A0 has PR 1271, but stacked_work says 9999 — should fail snapshot validation
      setA1Stacked(state, {
        dependency: {
          node_id: 'slice:A0',
          pr_number: 9999, // wrong
          repository: 'nalfeo/Crawler',
          branch: 'nalfeo-floor-2-epic-control',
          head_sha: DEP_HEAD,
        },
      });

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.dependency-pr-snapshot-mismatch');
    });

    it('rejects premature rebase_to_main completion when dependencies are not satisfied', () => {
      const state = cloneState();
      // A1's dependency (A0) is still blocked/in_progress, not validated
      setA1Stacked(state, {
        rebase_to_main: { state: 'complete', completed_at: '2026-07-17T17:00:00.000Z' },
      });

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.premature-rebase-complete');
    });

    it('rejects duplicate stacked-work ownership from the same claimant/session', () => {
      const state = cloneState();
      setA1Stacked(state);
      // Give slice:B1 its own stacked_work from the same session
      const b1 = state.nodes.find((n) => n.node_id === 'slice:B1')!;
      b1.github.issue = {
        number: 9200,
        url: 'https://github.com/nalfeo/Crawler/issues/9200',
      };
      const b1DepNode = b1.dependencies[0]!;
      (b1 as unknown as Record<string, unknown>)['stacked_work'] = makeStackedWork({
        dependency: {
          node_id: b1DepNode,
          pr_number: 8888,
          repository: 'nalfeo/Crawler',
          branch: 'some-other-branch',
          head_sha: DEP_HEAD,
        },
      });

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.duplicate-ownership');
    });

    it('allows rebase_to_main complete when all dependencies are validated', () => {
      const state = cloneState();
      // First validate A0
      validateA0(state);
      // Now set A1 with rebase_to_main complete
      setA1Stacked(state, {
        rebase_to_main: { state: 'complete', completed_at: '2026-07-17T17:30:00.000Z' },
      });
      // A1's dep (A0) is now validated so premature-rebase-complete should not fire
      const a1Errors = validate(state)
        .errors.filter((e) => e.node_id === 'slice:A1')
        .map((e) => e.code);

      expect(a1Errors).not.toContain('stacked.premature-rebase-complete');
    });

    it('allows rebase_to_main complete when dependency is merged (not yet validated)', () => {
      const state = cloneState();
      // Put A0 into merged status (PR landed but not yet validated)
      const a0 = state.nodes.find((n) => n.node_id === 'slice:A0')!;
      a0.status = 'merged';
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
      a0.merge = { commit: TEST_MERGE_COMMIT, merged_at: '2026-07-17T17:50:00.000Z' };
      a0.evidence = [
        {
          kind: 'handoff',
          path_or_check: 'docs/knowledge/handoffs/2026-07-17-floor-2-equipment-epic-control.md',
          sha256: '9d3dfa5fb7214032f0ff73cbc64a9da62e8c584291257bfb154bbb950910bfeb',
          commit: HANDOFF_COMMIT,
          recorded_at: '2026-07-17T17:55:00.000Z',
        },
        {
          kind: 'review-ledger',
          path_or_check:
            'docs/knowledge/review-ledgers/2026-07-17-floor-2-epic-control.review-ledger.json',
          sha256: 'fa7d39e5a5e9dcc867ffdbc25ccf6b33c0f0ca86edc229cd8403b97df1316afa',
          commit: LEDGER_COMMIT,
          recorded_at: '2026-07-17T17:55:00.000Z',
        },
        {
          kind: 'offline-validator-and-focused-tests',
          path_or_check: 'tests/unit/agent/epic-status.test.ts',
          sha256: CURRENT_TEST_FILE_HASH,
          commit: LEDGER_COMMIT,
          recorded_at: '2026-07-17T17:55:00.000Z',
        },
      ];
      // A1 with rebase_to_main complete — dependency is merged, not validated
      setA1Stacked(state, {
        rebase_to_main: { state: 'complete', completed_at: '2026-07-17T18:00:00.000Z' },
      });

      const a1Errors = validate(state)
        .errors.filter((e) => e.node_id === 'slice:A1')
        .map((e) => e.code);

      // merged status should satisfy the rebase gate; no premature error
      expect(a1Errors).not.toContain('stacked.premature-rebase-complete');
    });

    it('rejects rebase_to_main complete with null completed_at', () => {
      const state = cloneState();
      validateA0(state);
      setA1Stacked(state, {
        rebase_to_main: { state: 'complete', completed_at: null },
      });

      const codes = validate(state).errors.map((e) => e.code);

      expect(codes).toContain('stacked.rebase-complete-missing-timestamp');
    });

    it('GitHub audit proposes reconciliation for dependency head drift', () => {
      const state = cloneState();
      setA1Stacked(state);
      const a1Idx = state.nodes.findIndex((n) => n.node_id === 'slice:A1');
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
          // A0's main PR
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
          // stacked dependency PR (same PR 1271 audited via stacked_work path)
          throw new Error(`Unexpected GitHub path: ${path}`);
        },
      };

      // Manually trigger a drift scenario: change dep head in stacked_work
      const a1 = state.nodes[a1Idx]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a1 as any).stacked_work.dependency.head_sha = DEP_HEAD; // differs from FULL_COMMIT

      const audit = auditGithub(state, runner, NOW);

      // Should propose patch for the drifted dependency head
      expect(
        audit.proposal.repo_patch.some((p) =>
          p.path.includes(`/nodes/${a1Idx}/stacked_work/dependency/head_sha`),
        ),
      ).toBe(true);
    });

    it('GitHub audit reports error when stacked dependent PR is merged without lifecycle transition', () => {
      const state = cloneState();
      setA1Stacked(state, {
        status: 'stacked_pr_open',
        dependent: { head_sha: DEPENDENT_HEAD, pr_number: 1300 },
      });
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
          // stacked dependency PR
          if (path.endsWith('/pulls/1271')) {
            return {
              number: 1271,
              state: 'open',
              merged: false,
              merge_commit_sha: null,
              merged_at: null,
              html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
              head: { sha: DEP_HEAD },
            };
          }
          // stacked dependent PR — already merged
          if (path.endsWith('/pulls/1300')) {
            return {
              number: 1300,
              state: 'closed',
              merged: true,
              merge_commit_sha: 'e'.repeat(40),
              merged_at: '2026-07-17T19:00:00.000Z',
              html_url: 'https://github.com/nalfeo/Crawler/pull/1300',
              head: { sha: DEPENDENT_HEAD },
            };
          }
          throw new Error(`Unexpected GitHub path: ${path}`);
        },
      };

      const audit = auditGithub(state, runner, NOW);

      expect(audit.errors.map((e) => e.code)).toContain('stacked.dependent-pr-merged');
      expect(audit.proposal.operator_actions.some((a) => a.includes('STACKED-WORK-RECOVERY'))).toBe(
        true,
      );
    });

    it('GitHub audit reports error when stacked dependent PR is closed without merging', () => {
      const state = cloneState();
      setA1Stacked(state, {
        status: 'stacked_pr_open',
        dependent: { head_sha: DEPENDENT_HEAD, pr_number: 1301 },
      });
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
              head: { sha: DEP_HEAD },
            };
          }
          if (path.endsWith('/pulls/1301')) {
            return {
              number: 1301,
              state: 'closed',
              merged: false,
              merge_commit_sha: null,
              merged_at: null,
              html_url: 'https://github.com/nalfeo/Crawler/pull/1301',
              head: { sha: DEPENDENT_HEAD },
            };
          }
          throw new Error(`Unexpected GitHub path: ${path}`);
        },
      };

      const audit = auditGithub(state, runner, NOW);

      expect(audit.errors.map((e) => e.code)).toContain('stacked.dependent-pr-closed');
    });
  });
});
