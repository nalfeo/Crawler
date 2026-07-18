import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditGithub,
  buildMaterializationPlan,
  createDefaultGitReader,
  EXPECTED_NODE_IDS,
  extractPlanContract,
  validateEpicState,
  type EpicNode,
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
const HANDOFF_COMMIT = '461b8a334a018ebbf6e81aa7b31f81c74e08aa6b';
const LEDGER_COMMIT = '065591b1717588fd7acdb8e28936946e4a7e63e6';
const TEST_MERGE_COMMIT = HANDOFF_COMMIT;
let TREE_OBJECT_SHA: string | null = null;
try {
  TREE_OBJECT_SHA = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
} catch {
  TREE_OBJECT_SHA = null;
}
const TEST_GIT_READER = createDefaultGitReader(REPO_ROOT);

function sha256OfFile(repoRoot: string, repoRelPath: string): string {
  const content = readFileSync(resolve(repoRoot, repoRelPath), 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

function sha256OfGitFile(repoRoot: string, commit: string, repoRelPath: string): string {
  try {
    const content = execFileSync('git', ['show', `${commit}:${repoRelPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return createHash('sha256').update(content).digest('hex');
  } catch {
    // Fall back to working-tree content when the commit is not locally available
    // (e.g. shallow CI checkouts). Mirrors the production GitReader fallback.
    const content = readFileSync(resolve(repoRoot, repoRelPath), 'utf8');
    return createHash('sha256').update(content).digest('hex');
  }
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
    gitReader: TEST_GIT_READER,
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
      sha256: sha256OfGitFile(REPO_ROOT, HANDOFF_COMMIT, HANDOFF_PATH),
      commit: HANDOFF_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
    {
      kind: 'review-ledger',
      path_or_check: LEDGER_PATH,
      sha256: sha256OfGitFile(REPO_ROOT, LEDGER_COMMIT, LEDGER_PATH),
      commit: LEDGER_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
    {
      kind: 'offline-validator-and-focused-tests',
      path_or_check: 'tests/unit/agent/epic-status.test.ts',
      sha256: sha256OfGitFile(REPO_ROOT, LEDGER_COMMIT, 'tests/unit/agent/epic-status.test.ts'),
      commit: LEDGER_COMMIT,
      recorded_at: '2026-07-17T17:55:00.000Z',
    },
  ];
}

function makeStackedWork(
  overrides: Partial<NonNullable<EpicNode['stacked_work']>> = {},
): NonNullable<EpicNode['stacked_work']> {
  return {
    status: 'stacked_in_progress',
    owner: {
      claimant: 'agent-stack',
      session: 'session-stack',
      branch: 'agent-stack/slice-A1',
      claimed_at: '2026-07-17T16:00:00.000Z',
    },
    dependency: {
      node_id: 'slice:A0',
      pr_number: 1271,
      repository: 'nalfeo/Crawler',
      branch: 'nalfeo-floor-2-epic-control',
      head_sha: FULL_COMMIT,
    },
    dependent: {
      head_sha: HANDOFF_COMMIT,
      pr_number: null,
    },
    resync: {
      head_sha: FULL_COMMIT,
      at: '2026-07-17T17:00:00.000Z',
    },
    rebase_to_main: {
      state: 'pending',
      completed_at: null,
    },
    material_drift: null,
    block_reason: null,
    ...(overrides as object),
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

  it.skipIf(!TREE_OBJECT_SHA)('rejects a merge fact that points at a non-commit git object', () => {
    const state = cloneState();
    validateA0(state);
    state.nodes[0]!.merge.commit = TREE_OBJECT_SHA!;

    expect(validate(state).errors.map((error) => error.code)).toContain('merge.not-a-commit');
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

  it('rejects path-traversal and invalid non-file evidence paths', () => {
    const state = cloneState();
    validateA0(state);
    // Replace the non-file-scheme evidence entry with a path-traversal reference.
    // This should be rejected as evidence.unsafe-path rather than silently passing.
    state.nodes[0]!.evidence[2]!.path_or_check = '../outside-repo.txt';

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
    // packet:D2-A must have parent_slice 'slice:D2'; point it to a wrong slice.
    const d2a = state.nodes.find((node) => node.node_id === 'packet:D2-A');
    expect(d2a).toBeDefined();
    if (d2a) d2a.parent_slice = 'slice:A0';

    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).toContain('dag.parent-slice-contract-drift');
  });

  it('rejects a node not in the canonical plan graph', () => {
    const state = cloneState();
    // Inject a node whose ID is not part of the canonical 37-node graph.
    state.nodes.push({
      ...structuredClone(state.nodes[0]!),
      node_id: 'slice:UNKNOWN',
      display_id: 'Unknown',
      dependencies: [],
      parent_slice: null,
    });

    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).toContain('dag.unknown-node');
  });

  it('rejects missing canonical nodes even when node count is preserved via duplicates', () => {
    const state = cloneState();
    state.nodes = state.nodes.filter((node) => node.node_id !== 'slice:H2');
    state.nodes.push(structuredClone(state.nodes[0]!));

    const codes = validate(state).errors.map((error) => error.code);

    expect(codes).toContain('dag.duplicate-node');
    expect(codes).toContain('dag.missing-canonical-node');
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
      [
        'BLOCKED',
        'node: slice:A0',
        'reason: dependency unresolved',
        'lease_disposition: revoke',
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

  it('does not revoke a live claim when BLOCKED lacks explicit revoke lease disposition', () => {
    const state = cloneState();
    const makeClaim = (): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        'claimant: agent-b',
        'session: session-z',
        'expires_at: 2026-07-18T18:00:00.000Z',
        'claimed_at: 2026-07-17T16:00:00.000Z',
        `base_commit: ${HANDOFF_COMMIT}`,
        'scope: Slice A0 control plane only',
      ].join('\n');
    const makeBlockedWithoutRevoke = (): string =>
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
            {
              body: makeClaim(),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-22',
            },
            {
              body: makeBlockedWithoutRevoke(),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-23',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };
    const audit = auditGithub(state, runner, NOW);
    expect(
      audit.proposal.operator_actions.filter((a) => a.includes('session-z')).length,
    ).toBeGreaterThan(0);
  });

  it('revokes a child-issue live claim when BLOCKED omits node but lease disposition requests revoke', () => {
    const state = cloneState();
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (!a1) return;
    a1.status = 'claimed';
    a1.dependencies = [];
    a1.github.issue = {
      number: 1279,
      url: 'https://github.com/nalfeo/Crawler/issues/1279',
    };
    a1.ownership = {
      claimant: 'agent-b',
      session: 'session-child',
      source: 'child-issue-comment',
      scope: 'Slice A1 only',
      claimed_at: '2026-07-17T16:00:00.000Z',
      lease_expires_at: '2026-07-18T18:00:00.000Z',
      heartbeat_at: '2026-07-17T16:00:00.000Z',
      base_commit: HANDOFF_COMMIT,
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
        if (path.endsWith('/issues/1279')) {
          return {
            number: 1279,
            state: 'open',
            html_url: 'https://github.com/nalfeo/Crawler/issues/1279',
            url: 'https://api.github.com/repos/nalfeo/Crawler/issues/1279',
          };
        }
        if (path.includes('/issues/1264/comments?per_page=100&page=1')) return [];
        if (path.includes('/issues/1279/comments?per_page=100&page=1')) {
          return [
            {
              body: [
                'CLAIMED',
                'node: slice:A1',
                'claimant: agent-b',
                'session: session-child',
                'expires_at: 2026-07-18T18:00:00.000Z',
                'claimed_at: 2026-07-17T16:00:00.000Z',
                `base_commit: ${HANDOFF_COMMIT}`,
                'scope: Slice A1 only',
              ].join('\n'),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-24',
            },
            {
              body: ['BLOCKED', 'reason: dependency unresolved', 'lease_disposition: revoke'].join(
                '\n',
              ),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1279#issuecomment-25',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors.map((e) => e.code)).not.toContain('github.duplicate-live-claims');
    expect(audit.proposal.operator_actions.filter((a) => a.includes('session-child'))).toHaveLength(
      0,
    );
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

  it('accepts valid stacked_work on a blocked node with an issue', () => {
    const state = cloneState();
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (!a1) return;
    a1.status = 'blocked';
    a1.github.issue = {
      number: 1279,
      url: 'https://github.com/nalfeo/Crawler/issues/1279',
    };
    a1.stacked_work = makeStackedWork();

    const codes = validate(state).errors.map((error) => error.code);
    expect(codes).not.toContain('stacked.non-blocked-status');
    expect(codes).not.toContain('stacked.missing-issue');
    expect(codes).not.toContain('stacked.stale-resync');
  });

  it('rejects stacked_work when node status is not blocked', () => {
    const state = cloneState();
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (!a1) return;
    a1.status = 'in_progress';
    a1.github.issue = {
      number: 1279,
      url: 'https://github.com/nalfeo/Crawler/issues/1279',
    };
    a1.stacked_work = makeStackedWork();

    expect(validate(state).errors.map((error) => error.code)).toContain(
      'stacked.non-blocked-status',
    );
  });

  it('proposes stacked dependency head resync when dependency PR advances', () => {
    const state = cloneState();
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    expect(a1).toBeDefined();
    if (!a1) return;
    a1.status = 'blocked';
    a1.github.issue = {
      number: 1279,
      url: 'https://github.com/nalfeo/Crawler/issues/1279',
    };
    a1.stacked_work = makeStackedWork();
    const runner: GithubRunner = {
      get(path) {
        if (path.endsWith('/issues/1264') || path.endsWith('/issues/1279')) {
          return {
            number: path.endsWith('/issues/1264') ? 1264 : 1279,
            state: 'open',
            html_url: path.endsWith('/issues/1264')
              ? 'https://github.com/nalfeo/Crawler/issues/1264'
              : 'https://github.com/nalfeo/Crawler/issues/1279',
            url: path.endsWith('/issues/1264')
              ? 'https://api.github.com/repos/nalfeo/Crawler/issues/1264'
              : 'https://api.github.com/repos/nalfeo/Crawler/issues/1279',
          };
        }
        if (path.includes('/comments?per_page=100&page=1')) return [];
        if (path.endsWith('/repos/nalfeo/Crawler/pulls/1271')) {
          return {
            number: 1271,
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            merged_at: null,
            html_url: 'https://github.com/nalfeo/Crawler/pull/1271',
            head: { sha: 'f'.repeat(40) },
          };
        }
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);
    expect(audit.proposal.repo_patch.map((op) => op.path)).toContain(
      '/nodes/1/stacked_work/dependency/head_sha',
    );
  });
});

describe('validateEvidenceRequirements', () => {
  it('rejects a validated node with a fabricated commit for non-file check evidence', () => {
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
          path_or_check: 'check:offline-validator-and-focused-tests',
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
      readContent(_commit, filePath) {
        if (filePath.startsWith('check:')) {
          throw new Error('scheme-based check evidence must not be treated as a repository file');
        }
        try {
          return {
            content: readFileSync(resolve(REPO_ROOT, filePath), 'utf8'),
            source: 'git' as const,
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

  it('accepts file-backed required evidence when commit is unavailable but content hash matches', () => {
    const state = cloneState();
    const node = state.nodes[0]!;
    node.status = 'validated';
    node.merge.commit = HANDOFF_COMMIT;
    node.merge.merged_at = '2026-07-17T20:00:00.000Z';
    const FABRICATED_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    node.evidence = node.evidence.map((e) => {
      if (e.kind === 'offline-validator-and-focused-tests') {
        const filePath = 'tests/unit/agent/epic-status.test.ts';
        return {
          ...e,
          commit: FABRICATED_COMMIT,
          path_or_check: filePath,
          sha256: sha256OfFile(REPO_ROOT, filePath),
        };
      }
      return e;
    });

    const readerWithUnavailableCommit: GitReader = {
      commitStatus() {
        return 'missing';
      },
      readContent(_commit, filePath) {
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

    const validation = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      gitReader: readerWithUnavailableCommit,
    });
    expect(validation.errors.map((e) => e.code)).not.toContain('evidence.git-verification-failed');
    expect(validation.errors.map((e) => e.code)).not.toContain('evidence.hash-drift');
    expect(validation.warnings.map((e) => e.code)).toContain('evidence.commit-unavailable');
  });

  it('warns when canonical evidence is verified via working-tree fallback', () => {
    const state = cloneState();
    const node = state.nodes[0]!;
    node.status = 'merged';
    node.github.pr = {
      number: 1271,
      url: 'https://github.com/nalfeo/Crawler/pull/1271',
      head_sha: FULL_COMMIT,
    };
    node.merge = {
      commit: TEST_MERGE_COMMIT,
      merged_at: '2026-07-17T17:50:00.000Z',
    };
    node.evidence = node.evidence.map((e) =>
      e.kind === 'handoff' || e.kind === 'review-ledger'
        ? {
            ...e,
            commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            sha256: sha256OfFile(REPO_ROOT, e.path_or_check),
          }
        : e,
    );

    const readerWithUnavailableCommit: GitReader = {
      commitStatus() {
        return 'missing';
      },
      readContent(_commit, filePath) {
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

    const validation = validateEpicState(state, {
      repoRoot: REPO_ROOT,
      now: NOW,
      planMarkdown: PLAN,
      gitReader: readerWithUnavailableCommit,
    });

    expect(validation.errors.map((e) => e.code)).not.toContain('evidence.git-verification-failed');
    expect(validation.warnings.map((e) => e.code)).toContain('evidence.commit-unavailable');
  });

  it('suppresses ready_queue when plan contract hash has drifted', () => {
    const state = cloneState();
    validateA0(state);
    // A1 would normally be ready (A0 validated satisfies its dependency).
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    if (a1) {
      a1.github.issue = {
        number: 9002,
        url: 'https://github.com/nalfeo/Crawler/issues/9002',
      };
    }
    // Corrupt the contract hash to trigger plan.contract-drift.
    state.plan.contract_sha256 = '0'.repeat(64);

    const result = validate(state);

    expect(result.errors.map((e) => e.code)).toContain('plan.contract-drift');
    expect(result.ready_queue).toEqual([]);
  });

  it('counts a superseded required node as satisfied when its replacement is validated', () => {
    const state = cloneState();
    const a0 = state.nodes.find((node) => node.node_id === 'slice:A0');
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    if (!a0 || !a1) return;
    // Mark A0 as superseded pointing to A1 as its replacement.
    a0.status = 'superseded';
    a0.superseded_by = 'slice:A1';
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
    // Mark A1 as validated so it satisfies the superseded A0.
    a1.status = 'validated';
    a1.dependencies = []; // clear deps so it is self-sufficient for this test
    a1.release_requirement = 'required';
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
    a1.merge = { commit: TEST_MERGE_COMMIT, merged_at: '2026-07-17T17:50:00.000Z' };
    a1.evidence = a0.evidence.length > 0 ? structuredClone(a0.evidence) : [];
    a1.github.pr = {
      number: 9999,
      url: 'https://github.com/nalfeo/Crawler/pull/9999',
      head_sha: FULL_COMMIT,
    };

    const result = validate(state);

    // A0 is superseded; its requirement is satisfied because A1 (the replacement) is validated.
    // The readiness.false-ready error code should NOT appear for slice:A0.
    expect(
      result.errors.some((e) => e.code === 'readiness.false-ready' && e.node_id === 'slice:A0'),
    ).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === 'lifecycle.superseded-replacement' && e.node_id === 'slice:A0',
      ),
    ).toBe(false);
  });

  it('does not require heartbeat_at for a freshly claimed node', () => {
    const state = cloneState();
    const a1 = state.nodes.find((node) => node.node_id === 'slice:A1');
    if (!a1) return;
    a1.status = 'claimed';
    a1.github.issue = {
      number: 9003,
      url: 'https://github.com/nalfeo/Crawler/issues/9003',
    };
    a1.ownership = {
      claimant: 'agent-x',
      session: 'sess-abc',
      source: 'child-issue-comment',
      scope: 'Slice A1 only',
      claimed_at: '2026-07-18T00:00:00.000Z',
      lease_expires_at: '2026-07-19T00:00:00.000Z',
      heartbeat_at: null, // no heartbeat yet — freshly claimed
      base_commit: FULL_COMMIT,
    };

    const result = validate(state);

    expect(result.errors.some((e) => e.code === 'ownership.incomplete')).toBe(false);
  });

  it('proposes ownership patch when same owner/session posts a refreshed heartbeat expiry', () => {
    const state = cloneState();
    state.nodes[0]!.status = 'in_progress';
    state.nodes[0]!.github.pr = null;
    const STALE_EXPIRY = '2026-07-18T10:00:00.000Z';
    const NEW_EXPIRY = '2026-07-19T10:00:00.000Z';
    state.nodes[0]!.ownership.claimant = 'agent-y';
    state.nodes[0]!.ownership.session = 'sess-xyz';
    state.nodes[0]!.ownership.lease_expires_at = STALE_EXPIRY;
    state.nodes[0]!.ownership.heartbeat_at = '2026-07-17T12:00:00.000Z';
    const makeRefreshedClaim = (): string =>
      [
        'CLAIMED',
        'node: slice:A0',
        'claimant: agent-y',
        'session: sess-xyz',
        `expires_at: ${NEW_EXPIRY}`,
        'claimed_at: 2026-07-17T10:00:00.000Z',
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
              body: makeRefreshedClaim(),
              author_association: 'OWNER',
              html_url: 'https://github.com/nalfeo/Crawler/issues/1264#issuecomment-200',
            },
          ];
        }
        if (path.includes('/comments?per_page=100&page=2')) return [];
        throw new Error(`Unexpected GitHub path ${path}`);
      },
    };

    const audit = auditGithub(state, runner, NOW);

    expect(audit.errors).toEqual([]);
    // Should propose a patch updating the cached lease_expires_at to the new value.
    const expiryPatch = audit.proposal.repo_patch.find(
      (p) => p.path.endsWith('/ownership/lease_expires_at') && p.value === NEW_EXPIRY,
    );
    expect(expiryPatch).toBeDefined();
  });
});
