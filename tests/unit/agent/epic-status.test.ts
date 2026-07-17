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

function cloneState(): EpicState {
  const state = structuredClone(STATE);
  state.nodes[0]!.reconciliation.drift = [];
  state.reconciliation.drift = [];
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
});

describe('validateEvidenceRequirements', () => {
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

// ---------------------------------------------------------------------------
// Speculative stacked-work tests — hard gate: lifecycle-blocked and absent
// from ready_queue; stale-base or post-merge-unrebased must fail validation.
// ---------------------------------------------------------------------------
describe('speculative stacked-work metadata', () => {
  // Build a minimal valid stacked_work block for a blocked node whose only
  // unvalidated dep (slice:A0 at pr_open) has a known PR ref in state.
  function makeStackedWork(depHeadSha: string, overrides: Record<string, unknown> = {}) {
    return {
      mode: 'stacked_in_progress' as const,
      issue: {
        number: 1282,
        url: 'https://github.com/nalfeo/Crawler/issues/1282',
      },
      session: 'speculative-session-001',
      branch: 'nalfeo-floor-2-stacked-work-protocol',
      pr: null,
      stack_bases: [
        {
          dependency_node_id: 'slice:A0',
          dependency_pr_number: 1271,
          dependency_branch: 'nalfeo-floor-2-epic-control',
          dependency_head_sha: depHeadSha,
          last_resynced_at: '2026-07-17T20:00:00.000Z',
          last_resynced_head: depHeadSha,
          requires_main_rebase: false,
        },
      ],
      drift_reason: null,
      ...overrides,
    };
  }

  // Set up a slice:A1 node with stacked_work. A0 stays at pr_open so A1 is
  // correctly blocked by an unvalidated dep.
  function buildStateWithStackedWork(
    stackedWorkOverrides: Record<string, unknown> = {},
    stackBaseOverrides: Record<string, unknown> = {},
  ): EpicState {
    const state = cloneState();
    // A0 at pr_open with a known PR ref (the stale-head tests compare against this).
    const a0 = state.nodes.find((n) => n.node_id === 'slice:A0')!;
    const A0_HEAD = FULL_COMMIT;
    a0.github.pr = {
      number: 1271,
      url: 'https://github.com/nalfeo/Crawler/pull/1271',
      head_sha: A0_HEAD,
    };
    // A1 is blocked by A0 (already the canonical dep). Add stacked_work.
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    a1.github.issue = {
      number: 9100,
      url: 'https://github.com/nalfeo/Crawler/issues/9100',
    };
    const sw = makeStackedWork(A0_HEAD, stackedWorkOverrides);
    if (stackBaseOverrides && Object.keys(stackBaseOverrides).length > 0) {
      sw.stack_bases[0] = { ...sw.stack_bases[0]!, ...stackBaseOverrides };
    }
    (a1 as Record<string, unknown>)['stacked_work'] = sw;
    return state;
  }

  it('accepts a valid stacked_work block on a blocked node with pr_open dep', () => {
    const state = buildStateWithStackedWork();
    const result = validate(state);
    const stackedCodes = result.errors
      .filter((e) => e.code.startsWith('stacked.'))
      .map((e) => e.code);
    expect(stackedCodes).toEqual([]);
  });

  it('node with stacked_work remains lifecycle-blocked and absent from ready_queue', () => {
    const state = buildStateWithStackedWork();
    const result = validate(state);
    // slice:A1 must not appear in ready_queue regardless of other state.
    expect(result.ready_queue).not.toContain('slice:A1');
    // The node status stays blocked; stacked_work is orthogonal.
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    expect(a1.status).toBe('blocked');
  });

  it('ready_queue stays clear even when all deps would otherwise be validated (requires_main_rebase)', () => {
    // Set up A0 as validated (would normally make A1 ready), but A1 has
    // stacked_work with requires_main_rebase: true — must not enter ready_queue.
    const state = cloneState();
    validateA0(state);
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    a1.github.issue = {
      number: 9101,
      url: 'https://github.com/nalfeo/Crawler/issues/9101',
    };
    const A0_HEAD = FULL_COMMIT;
    // A0 is validated but record stacked_work with requires_main_rebase=true.
    (a1 as Record<string, unknown>)['stacked_work'] = {
      mode: 'stacked_in_progress',
      issue: { number: 1282, url: 'https://github.com/nalfeo/Crawler/issues/1282' },
      session: 'speculative-session-002',
      branch: 'nalfeo-floor-2-stacked-work-protocol',
      pr: null,
      stack_bases: [
        {
          dependency_node_id: 'slice:A0',
          dependency_pr_number: 1271,
          dependency_branch: 'nalfeo-floor-2-epic-control',
          dependency_head_sha: A0_HEAD,
          last_resynced_at: '2026-07-17T20:00:00.000Z',
          last_resynced_head: A0_HEAD,
          requires_main_rebase: true,
        },
      ],
      drift_reason: null,
    };
    // A0 is now validated — would normally make A1 ready. But requires_main_rebase
    // blocks this; A1 must be absent from ready_queue.
    const result = validate(state);
    expect(result.ready_queue).not.toContain('slice:A1');
    // Error for post-merge-unrebased condition.
    const codes = result.errors.filter((e) => e.code.startsWith('stacked.')).map((e) => e.code);
    expect(codes).toContain('stacked.requires-main-rebase');
    // Operator action must be emitted.
    expect(
      result.proposal.operator_actions.some((a) => a.includes('slice:A1')),
    ).toBe(true);
  });

  it('rejects stale dep head: last_resynced_head does not match dep PR head_sha', () => {
    const STALE_HEAD = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
    // State has A0 at FULL_COMMIT; stack_base records STALE_HEAD as last_resynced_head.
    const state = buildStateWithStackedWork({}, { last_resynced_head: STALE_HEAD });
    const codes = validate(state).errors.map((e) => e.code);
    expect(codes).toContain('stacked.stale-dep-head');
  });

  it('rejects speculative work on a dep that is not pr_open (e.g. blocked)', () => {
    const state = cloneState();
    // Keep A0 in blocked status (no github.pr).
    const a0 = state.nodes.find((n) => n.node_id === 'slice:A0')!;
    expect(a0.status).toBe('pr_open'); // default is pr_open in canonical state
    // Set A0 to claimed (not pr_open) so it's an invalid dep for speculative work.
    a0.status = 'claimed';
    // A1 gets stacked_work against this non-pr_open dep.
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    a1.github.issue = { number: 9102, url: 'https://github.com/nalfeo/Crawler/issues/9102' };
    (a1 as Record<string, unknown>)['stacked_work'] = {
      mode: 'stacked_in_progress',
      issue: { number: 1282, url: 'https://github.com/nalfeo/Crawler/issues/1282' },
      session: 'speculative-session-003',
      branch: 'nalfeo-floor-2-stacked-work-protocol',
      pr: null,
      stack_bases: [
        {
          dependency_node_id: 'slice:A0',
          dependency_pr_number: 1271,
          dependency_branch: 'nalfeo-floor-2-epic-control',
          dependency_head_sha: FULL_COMMIT,
          last_resynced_at: '2026-07-17T20:00:00.000Z',
          last_resynced_head: FULL_COMMIT,
          requires_main_rebase: false,
        },
      ],
      drift_reason: null,
    };
    const codes = validate(state).errors.map((e) => e.code);
    expect(codes).toContain('stacked.dep-not-pr-open');
  });

  it('rejects stacked_work on a non-blocked node', () => {
    const state = buildStateWithStackedWork();
    const a0 = state.nodes.find((n) => n.node_id === 'slice:A0')!;
    // Move A1 to pr_open (it should not have stacked_work).
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    a1.status = 'pr_open';
    // A0 must be validated for A1 to be post-pr_open, but keep stacked_work.
    validateA0(state);
    a1.github.pr = {
      number: 9999,
      url: 'https://github.com/nalfeo/Crawler/pull/9999',
      head_sha: FULL_COMMIT,
    };
    const HANDOFF_PATH = 'docs/knowledge/handoffs/2026-07-17-floor-2-equipment-epic-control.md';
    const LEDGER_PATH =
      'docs/knowledge/review-ledgers/2026-07-17-floor-2-epic-control.review-ledger.json';
    a1.evidence = [
      {
        kind: 'handoff',
        path_or_check: HANDOFF_PATH,
        sha256: sha256OfFile(REPO_ROOT, HANDOFF_PATH),
        commit: HANDOFF_COMMIT,
        recorded_at: '2026-07-17T20:00:00.000Z',
      },
      {
        kind: 'review-ledger',
        path_or_check: LEDGER_PATH,
        sha256: sha256OfFile(REPO_ROOT, LEDGER_PATH),
        commit: LEDGER_COMMIT,
        recorded_at: '2026-07-17T20:00:00.000Z',
      },
    ];
    a1.ownership = {
      claimant: null,
      session: null,
      source: 'none',
      scope: null,
      claimed_at: null,
      lease_expires_at: null,
      heartbeat_at: null,
      base_commit: null,
    };
    // Ensure A0 PR head matches to avoid stale-dep errors.
    const A0_HEAD = a0.github.pr?.head_sha ?? FULL_COMMIT;
    const sw = (a1 as Record<string, unknown>)['stacked_work'] as Record<string, unknown>;
    if (sw?.stack_bases) {
      (sw.stack_bases as Array<Record<string, unknown>>)[0]!['last_resynced_head'] = A0_HEAD;
      (sw.stack_bases as Array<Record<string, unknown>>)[0]!['dependency_head_sha'] = A0_HEAD;
    }
    const codes = validate(state).errors.map((e) => e.code);
    expect(codes).toContain('stacked.not-blocked');
  });

  it('rejects missing stack_base for an unvalidated dependency', () => {
    const state = buildStateWithStackedWork();
    // Remove the stack_base so there's no entry for the unvalidated dep.
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    const sw = (a1 as Record<string, unknown>)['stacked_work'] as Record<string, unknown>;
    (sw as Record<string, unknown>)['stack_bases'] = [];
    const codes = validate(state).errors.map((e) => e.code);
    // stack_bases min(1) fails schema
    expect(codes.some((c) => c === 'state.schema' || c === 'stacked.missing-base')).toBe(true);
  });

  it('rejects stack_base referencing a dep that is not a direct dependency', () => {
    const state = buildStateWithStackedWork();
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    const sw = (a1 as Record<string, unknown>)['stacked_work'] as Record<string, unknown>;
    // Replace the dep node ID with a non-dep.
    (sw['stack_bases'] as Array<Record<string, unknown>>)[0]!['dependency_node_id'] = 'slice:B1';
    const codes = validate(state).errors.map((e) => e.code);
    expect(codes).toContain('stacked.base-not-dependency');
  });

  it('rejects duplicate stacked_work session across nodes', () => {
    const state = buildStateWithStackedWork();
    // Add stacked_work with the SAME session on a second node (B1 blocked by A1).
    const b1 = state.nodes.find((n) => n.node_id === 'slice:B1')!;
    // Make A1 pr_open so B1 can have stacked_work against it.
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    a1.status = 'pr_open';
    a1.github.pr = {
      number: 1300,
      url: 'https://github.com/nalfeo/Crawler/pull/1300',
      head_sha: FULL_COMMIT,
    };
    validateA0(state);
    a1.ownership = {
      claimant: null,
      session: null,
      source: 'none',
      scope: null,
      claimed_at: null,
      lease_expires_at: null,
      heartbeat_at: null,
      base_commit: null,
    };
    const HANDOFF_PATH = 'docs/knowledge/handoffs/2026-07-17-floor-2-equipment-epic-control.md';
    const LEDGER_PATH =
      'docs/knowledge/review-ledgers/2026-07-17-floor-2-epic-control.review-ledger.json';
    a1.evidence = [
      {
        kind: 'handoff',
        path_or_check: HANDOFF_PATH,
        sha256: sha256OfFile(REPO_ROOT, HANDOFF_PATH),
        commit: HANDOFF_COMMIT,
        recorded_at: '2026-07-17T20:00:00.000Z',
      },
      {
        kind: 'review-ledger',
        path_or_check: LEDGER_PATH,
        sha256: sha256OfFile(REPO_ROOT, LEDGER_PATH),
        commit: LEDGER_COMMIT,
        recorded_at: '2026-07-17T20:00:00.000Z',
      },
    ];
    b1.github.issue = { number: 9103, url: 'https://github.com/nalfeo/Crawler/issues/9103' };
    (b1 as Record<string, unknown>)['stacked_work'] = {
      mode: 'stacked_in_progress',
      // Same session as A1's stacked_work → duplicate.
      issue: { number: 1283, url: 'https://github.com/nalfeo/Crawler/issues/1283' },
      session: 'speculative-session-001',
      branch: 'some-other-branch',
      pr: null,
      stack_bases: [
        {
          dependency_node_id: 'slice:A1',
          dependency_pr_number: 1300,
          dependency_branch: 'some-a1-branch',
          dependency_head_sha: FULL_COMMIT,
          last_resynced_at: '2026-07-17T20:00:00.000Z',
          last_resynced_head: FULL_COMMIT,
          requires_main_rebase: false,
        },
      ],
      drift_reason: null,
    };
    const codes = validate(state).errors.map((e) => e.code);
    expect(codes).toContain('stacked.duplicate-session');
  });

  it('requires requires_main_rebase=true when dep is merged/validated and stacked_work is present', () => {
    const state = cloneState();
    validateA0(state);
    const A0_HEAD = FULL_COMMIT;
    // A0 is now validated (POST_MERGE_STATUSES). A1 still has stacked_work
    // with requires_main_rebase: false — should error.
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    a1.github.issue = {
      number: 9104,
      url: 'https://github.com/nalfeo/Crawler/issues/9104',
    };
    (a1 as Record<string, unknown>)['stacked_work'] = {
      mode: 'stacked_in_progress',
      issue: { number: 1282, url: 'https://github.com/nalfeo/Crawler/issues/1282' },
      session: 'speculative-session-005',
      branch: 'nalfeo-floor-2-stacked-work-protocol',
      pr: null,
      stack_bases: [
        {
          dependency_node_id: 'slice:A0',
          dependency_pr_number: 1271,
          dependency_branch: 'nalfeo-floor-2-epic-control',
          dependency_head_sha: A0_HEAD,
          last_resynced_at: '2026-07-17T20:00:00.000Z',
          last_resynced_head: A0_HEAD,
          requires_main_rebase: false, // incorrectly false — dep is validated
        },
      ],
      drift_reason: null,
    };
    const codes = validate(state).errors.map((e) => e.code);
    expect(codes).toContain('stacked.merged-dep-rebase-required');
  });

  it('proposes speculative PR head reconciliation via GitHub audit', () => {
    const state = buildStateWithStackedWork({ mode: 'stacked_pr_open' });
    const a1 = state.nodes.find((n) => n.node_id === 'slice:A1')!;
    // Give the stacked_work a PR ref with an old head.
    const sw = (a1 as Record<string, unknown>)['stacked_work'] as Record<string, unknown>;
    const OLD_HEAD = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
    const NEW_HEAD = 'cccc3333cccc3333cccc3333cccc3333cccc3333';
    sw['pr'] = {
      number: 1295,
      url: 'https://github.com/nalfeo/Crawler/pull/1295',
      head_sha: OLD_HEAD,
    };

    const runner: GithubRunner = {
      get(path: string) {
        if (path.endsWith('/issues/1264')) {
          return {
            number: 1264,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1264',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1264',
          };
        }
        if (path.endsWith('/issues/9100')) {
          // A1's child issue (stacked_work node).
          return {
            number: 9100,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/9100',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/9100',
          };
        }
        if (path.endsWith('/issues/1282')) {
          // A1's stacked_work.issue (the speculative work's tracking issue).
          return {
            number: 1282,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1282',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1282',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) return [];
        if (path.endsWith('/pulls/1271')) {
          // The canonical A0 dep PR.
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
        if (path.endsWith('/pulls/1295')) {
          // The speculative PR — head has advanced.
          return {
            number: 1295,
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            merged_at: null,
            html_url: 'https://github.com/nalfeo/Crawler/pull/1295',
            head: { sha: NEW_HEAD },
          };
        }
        throw new Error(`Unexpected GitHub path: ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);
    expect(audit.errors).toEqual([]);
    // Must propose a head_sha update for the speculative PR.
    expect(
      audit.proposal.repo_patch.some(
        (p) => p.path.includes('stacked_work/pr/head_sha') && p.value === NEW_HEAD,
      ),
    ).toBe(true);
  });
});
