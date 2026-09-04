import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  decideLifecycleLease,
  isRepositoryPullRequestUrl,
  isTrustedLifecycleLeaseComment,
  LIFECYCLE_CLAIM_LANE,
  LIFECYCLE_LANES,
  LIFECYCLE_LEASE_MARKER,
  LIFECYCLE_PR_LANES,
  lifecycleLaneOwner,
  lifecycleLaneWriterEnabled,
  lifecycleLeaseTtlSeconds,
  lifecycleWriterEnabled,
  parseLifecycleLease,
  renderLifecycleLease,
  selectLifecycleLeaseComments,
} = await import(path.join(repositoryRoot, '.github/scripts/lifecycle-ownership.mjs'));
const { legacyReviewThreadWritesEnabled } = await import(
  path.join(repositoryRoot, '.github/scripts/ci-recovery/state.mjs')
);
const { goobersOwnsImplementationClaim } = await import(
  path.join(repositoryRoot, '.github/scripts/ci-recovery/issue-intake-lib.mjs')
);
const markers = await import(path.join(repositoryRoot, '.github/scripts/ci-recovery/markers.mjs'));

function workflow(name: string) {
  return fs.readFileSync(path.join(repositoryRoot, '.github/workflows', name), 'utf8');
}

const base = {
  owner: 'goobers',
  legacyBridgeEnabled: 'true',
  repository: 'nalfeo/Crawler',
  headRepository: 'nalfeo/Crawler',
  issueNumber: 3843,
  leaseId: 'goobers:100:1',
  operation: 'acquire',
  now: '2026-09-02T03:00:00.000Z',
  ttlSeconds: '300',
  markerComments: [] as Array<{ id: number; body: string }>,
};

/** Phase 2 steady state: Goobers claims, legacy still runs every PR lane. */
const PHASE_2 = { owner: 'goobers', legacyBridgeEnabled: 'true' };

function markerComment(
  leaseId: string,
  expiresAt = '2026-09-02T03:05:00.000Z',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 7,
    body: renderLifecycleLease({
      version: 1,
      owner: 'goobers',
      repository: base.repository,
      issueNumber: base.issueNumber,
      leaseId,
      acquiredAt: base.now,
      expiresAt,
      ...overrides,
    }),
  };
}

describe('Goobers lifecycle ownership', () => {
  it('bounds the operational lease TTL and defaults invalid values', () => {
    expect(lifecycleLeaseTtlSeconds('120')).toBe(120);
    expect(lifecycleLeaseTtlSeconds('3600')).toBe(3600);
    expect(lifecycleLeaseTtlSeconds('119')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('3601')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('invalid')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('120junk')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('120.9')).toBe(300);
    expect(lifecycleLeaseTtlSeconds(' 600 ')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('-300')).toBe(300);
    expect(lifecycleLeaseTtlSeconds('')).toBe(300);
    expect(lifecycleLeaseTtlSeconds(undefined)).toBe(300);
  });

  it('sources the managed lease marker from the marker registry', () => {
    expect(LIFECYCLE_LEASE_MARKER).toBe(markers.LIFECYCLE_LEASE_MARKER);
    expect(markers.MANAGED_COMMENT_MARKERS).toContain(markers.LIFECYCLE_LEASE_MARKER);
    expect(markers.MANAGED_COMMENT_MARKERS).toContain(markers.LIFECYCLE_LEASE_DATA_PREFIX);
    expect(renderLifecycleLease(decideLifecycleLease(base).lease)).toContain(
      markers.LIFECYCLE_LEASE_DATA_PREFIX,
    );
  });

  // ---------------------------------------------------------------------------
  // Lane ownership: the no-downtime contract
  // ---------------------------------------------------------------------------

  it('keeps every PR-lifecycle lane on legacy while Goobers owns the claim lane', () => {
    expect(lifecycleLaneOwner(LIFECYCLE_CLAIM_LANE, PHASE_2)).toBe('goobers');
    expect(lifecycleLaneWriterEnabled(LIFECYCLE_CLAIM_LANE, PHASE_2, 'goobers')).toBe(true);
    expect(lifecycleLaneWriterEnabled(LIFECYCLE_CLAIM_LANE, PHASE_2, 'legacy')).toBe(false);

    for (const lane of LIFECYCLE_PR_LANES) {
      expect(lifecycleLaneOwner(lane, PHASE_2)).toBe('legacy');
      expect(lifecycleLaneWriterEnabled(lane, PHASE_2, 'legacy')).toBe(true);
      expect(lifecycleLaneWriterEnabled(lane, PHASE_2, 'goobers')).toBe(false);
    }
  });

  it('never leaves a lane without exactly one writer in Phase 2', () => {
    for (const lane of LIFECYCLE_LANES) {
      const writers = (['goobers', 'legacy'] as const).filter((actor) =>
        lifecycleLaneWriterEnabled(lane, PHASE_2, actor),
      );
      expect(writers).toHaveLength(1);
    }
  });

  it('fails closed only for the claim lane and never disables an unrelated required lane', () => {
    // Every one of these is a malformed/partial configuration of the CLAIM
    // selector. None of them may take a PR-lifecycle lane offline.
    for (const owner of ['', 'typo', 'Goobers', ' goobers', 'LEGACY', undefined]) {
      const config = { owner, legacyBridgeEnabled: 'true' };
      expect(lifecycleLaneOwner(LIFECYCLE_CLAIM_LANE, config)).toBe('off');
      expect(lifecycleLaneWriterEnabled(LIFECYCLE_CLAIM_LANE, config, 'goobers')).toBe(false);
      expect(lifecycleLaneWriterEnabled(LIFECYCLE_CLAIM_LANE, config, 'legacy')).toBe(false);

      for (const lane of LIFECYCLE_PR_LANES) {
        expect(lifecycleLaneWriterEnabled(lane, config, 'legacy')).toBe(true);
      }
    }

    // A malformed lane selector also fails operational, never dark.
    for (const laneOwner of ['', 'goobrs', 'Goobers', ' goobers', 'legacy', undefined]) {
      const config = { ...PHASE_2, laneOwners: { 'merge-train': laneOwner } };
      expect(lifecycleLaneOwner('merge-train', config)).toBe('legacy');
      expect(lifecycleLaneWriterEnabled('merge-train', config, 'legacy')).toBe(true);
    }
  });

  it('migrates each Phase 3 lane independently without creating dual writers', () => {
    for (const migrating of LIFECYCLE_PR_LANES) {
      const config = { ...PHASE_2, laneOwners: { [migrating]: 'goobers' } };

      expect(lifecycleLaneWriterEnabled(migrating, config, 'goobers')).toBe(true);
      expect(lifecycleLaneWriterEnabled(migrating, config, 'legacy')).toBe(false);

      for (const untouched of LIFECYCLE_PR_LANES.filter((lane: string) => lane !== migrating)) {
        expect(lifecycleLaneWriterEnabled(untouched, config, 'legacy')).toBe(true);
        expect(lifecycleLaneWriterEnabled(untouched, config, 'goobers')).toBe(false);
      }

      for (const lane of LIFECYCLE_LANES) {
        const writers = (['goobers', 'legacy'] as const).filter((actor) =>
          lifecycleLaneWriterEnabled(lane, config, actor),
        );
        expect(writers).toHaveLength(1);
      }
    }
  });

  it('restores legacy claim ownership on rollback and honours the emergency kill switch', () => {
    const rollback = { owner: 'legacy', legacyBridgeEnabled: 'true' };
    expect(lifecycleLaneWriterEnabled(LIFECYCLE_CLAIM_LANE, rollback, 'legacy')).toBe(true);
    expect(lifecycleLaneWriterEnabled(LIFECYCLE_CLAIM_LANE, rollback, 'goobers')).toBe(false);
    for (const lane of LIFECYCLE_PR_LANES) {
      expect(lifecycleLaneWriterEnabled(lane, rollback, 'legacy')).toBe(true);
    }

    // Kill switch: bridge off stops every legacy mutation lane at once.
    for (const bridge of ['false', '', 'tru', undefined]) {
      const killed = { owner: 'legacy', legacyBridgeEnabled: bridge };
      for (const lane of LIFECYCLE_LANES) {
        expect(lifecycleLaneWriterEnabled(lane, killed, 'legacy')).toBe(false);
      }
    }
    // The kill switch never silently promotes Goobers into a legacy lane.
    for (const lane of LIFECYCLE_PR_LANES) {
      expect(
        lifecycleLaneWriterEnabled(
          lane,
          { owner: 'legacy', legacyBridgeEnabled: 'false' },
          'goobers',
        ),
      ).toBe(false);
    }
  });

  it('keeps the claim-lane writer check decoupled from the legacy bridge', () => {
    // Regression: the original design required bridge=false for Goobers, which
    // forced every legacy lane offline the moment Goobers was selected.
    expect(
      lifecycleWriterEnabled({ owner: 'goobers', legacyBridgeEnabled: 'true' }, 'goobers'),
    ).toBe(true);
    expect(
      lifecycleWriterEnabled({ owner: 'goobers', legacyBridgeEnabled: 'false' }, 'goobers'),
    ).toBe(true);
    expect(
      lifecycleWriterEnabled({ owner: 'goobers', legacyBridgeEnabled: 'true' }, 'legacy'),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Claim lease behaviour
  // ---------------------------------------------------------------------------

  it('keeps the Goobers task decision-only', () => {
    const definition = parse(
      fs.readFileSync(
        path.join(
          repositoryRoot,
          '.goobers/gaggles/crawler/workflows/crawler-lifecycle-owner.yaml',
        ),
        'utf8',
      ),
    );
    const task = definition.spec.tasks.find(
      (candidate: { name: string }) => candidate.name === 'decide-ownership',
    );

    expect(task.capabilities).toBeUndefined();
    expect(task.expectedOutputs).toEqual(['decision']);
    expect(task.run.script).toContain('.github/scripts/lifecycle-ownership.mjs');
  });

  it('acquires, renders, parses, and renews the same claim idempotently', () => {
    const acquired = decideLifecycleLease(base);
    expect(acquired).toMatchObject({
      status: 'acquired',
      reason: 'lease-created',
      writeAction: 'create',
      lockKey: 'nalfeo/crawler#issue-3843',
    });

    const rendered = renderLifecycleLease(acquired.lease);
    expect(parseLifecycleLease(rendered)).toEqual(acquired.lease);

    const renewed = decideLifecycleLease({
      ...base,
      operation: 'heartbeat',
      now: '2026-09-02T03:01:00.000Z',
      markerComments: [{ id: 7, body: rendered }],
    });
    expect(renewed).toMatchObject({
      status: 'renewed',
      reason: 'lease-renewed',
      writeAction: 'update',
      expectedCommentId: 7,
      expectedLeaseId: base.leaseId,
    });
  });

  it('retains the active incumbent and deterministically permits expired takeover', () => {
    expect(
      decideLifecycleLease({
        ...base,
        leaseId: 'goobers:200:1',
        markerComments: [markerComment(base.leaseId)],
      }),
    ).toMatchObject({
      status: 'contended',
      reason: 'active-lease',
      writeAction: 'none',
      lease: { leaseId: base.leaseId },
    });

    expect(
      decideLifecycleLease({
        ...base,
        leaseId: 'goobers:200:1',
        now: '2026-09-02T03:06:00.000Z',
        markerComments: [markerComment(base.leaseId)],
      }),
    ).toMatchObject({
      status: 'acquired',
      reason: 'lease-takeover',
      writeAction: 'update',
      expectedCommentId: 7,
      expectedLeaseId: base.leaseId,
      lease: { leaseId: 'goobers:200:1', acquiredAt: '2026-09-02T03:06:00.000Z' },
    });
  });

  it('rejects malformed claim input without mutating', () => {
    for (const override of [
      { issueNumber: 0 },
      { issueNumber: Number.NaN },
      { leaseId: '' },
      { operation: 'promote' },
      { now: 'not-a-date' },
    ]) {
      expect(decideLifecycleLease({ ...base, ...override })).toMatchObject({
        status: 'rejected',
        reason: 'invalid-input',
        writeAction: 'none',
        observable: true,
      });
    }

    // An empty repository cannot satisfy the same-repository fence, so it is
    // rejected earlier, as a fork.
    expect(decideLifecycleLease({ ...base, repository: '' })).toMatchObject({
      status: 'rejected',
      reason: 'fork',
      writeAction: 'none',
    });
  });

  it('counts only trusted authors when reading lease marker comments', () => {
    const trusted = { ...markerComment(base.leaseId), user: { login: 'github-actions[bot]' } };
    const forged = {
      id: 9,
      body: markerComment('forged').body,
      user: { login: 'drive-by' },
      author_association: 'NONE',
    };
    const poisoned = {
      id: 10,
      body: `${LIFECYCLE_LEASE_MARKER} malformed`,
      user: { login: 'drive-by' },
      author_association: 'CONTRIBUTOR',
    };

    expect(isTrustedLifecycleLeaseComment(trusted)).toBe(true);
    expect(isTrustedLifecycleLeaseComment(forged)).toBe(false);
    expect(isTrustedLifecycleLeaseComment({ ...forged, author_association: 'COLLABORATOR' })).toBe(
      true,
    );
    expect(selectLifecycleLeaseComments([trusted, forged, poisoned])).toEqual([trusted]);
    expect(selectLifecycleLeaseComments([forged, poisoned])).toEqual([]);
  });

  it('fails closed on malformed or duplicate marker state', () => {
    expect(
      decideLifecycleLease({
        ...base,
        markerComments: [{ id: 7, body: '<!-- crawler-lifecycle-lease:v1 --> malformed' }],
      }),
    ).toMatchObject({ status: 'contended', reason: 'invalid-lease-state' });
    expect(
      decideLifecycleLease({
        ...base,
        markerComments: [markerComment('first'), { ...markerComment('second'), id: 8 }],
      }),
    ).toMatchObject({ status: 'contended', reason: 'duplicate-lease-state' });
  });

  it('is observe-only when Goobers does not own the claim lane', () => {
    expect(
      decideLifecycleLease({
        ...base,
        owner: 'legacy',
        markerComments: [markerComment(base.leaseId)],
      }),
    ).toMatchObject({ status: 'observe-only', reason: 'goobers-not-selected' });
  });

  it('requires the exact holder to release the claim', () => {
    const current = markerComment(base.leaseId);
    expect(
      decideLifecycleLease({
        ...base,
        operation: 'release',
        leaseId: 'different-run',
        markerComments: [current],
      }),
    ).toMatchObject({ status: 'contended', reason: 'lease-not-held' });
    expect(
      decideLifecycleLease({ ...base, operation: 'release', markerComments: [current] }),
    ).toMatchObject({
      status: 'released',
      reason: 'lease-released',
      writeAction: 'delete',
      expectedCommentId: 7,
    });
  });

  // ---------------------------------------------------------------------------
  // Publication handoff: approved issue -> Goobers -> PR -> legacy, with no gap
  // ---------------------------------------------------------------------------

  it('hands the claim off at PR publication and leaves no Goobers writer behind', () => {
    const current = markerComment(base.leaseId);
    const prUrl = 'https://github.com/nalfeo/Crawler/pull/4091';

    const handoff = decideLifecycleLease({
      ...base,
      operation: 'handoff',
      prUrl,
      markerComments: [current],
    });
    expect(handoff).toMatchObject({
      status: 'handed-off',
      reason: 'handoff-complete',
      writeAction: 'delete',
      expectedCommentId: 7,
      expectedLeaseId: base.leaseId,
      lease: null,
      prUrl,
    });

    // After the handoff the claim marker is gone, so a later acquire for the
    // same issue starts clean rather than colliding with a stale PR lease.
    expect(decideLifecycleLease({ ...base, markerComments: [] })).toMatchObject({
      status: 'acquired',
      reason: 'lease-created',
    });
  });

  it('makes a replayed publication handoff idempotent', () => {
    expect(
      decideLifecycleLease({
        ...base,
        operation: 'handoff',
        prUrl: 'https://github.com/nalfeo/Crawler/pull/4091',
        markerComments: [],
      }),
    ).toMatchObject({
      status: 'handed-off',
      reason: 'already-released',
      writeAction: 'none',
    });
  });

  it('refuses a fork head so a fork PR cannot drop a legitimate claim', () => {
    // pull_request_target runs with base-repo write permission even for fork
    // PRs, so an outside contributor writing "Fixes #3843" must not be able to
    // delete the claim on that issue.
    for (const headRepository of ['attacker/Crawler', 'nalfeo/Crawler-evil', '', undefined]) {
      expect(
        decideLifecycleLease({
          ...base,
          headRepository,
          operation: 'handoff',
          prUrl: 'https://github.com/nalfeo/Crawler/pull/4091',
          markerComments: [markerComment(base.leaseId)],
        }),
      ).toMatchObject({ status: 'rejected', reason: 'fork', writeAction: 'none' });
    }
  });

  it('matches handoff targets structurally rather than by prefix', () => {
    expect(
      isRepositoryPullRequestUrl('https://github.com/nalfeo/Crawler/pull/1', 'nalfeo/Crawler'),
    ).toBe(true);
    for (const hostile of [
      // Shares the prefix but addresses a different resource.
      'https://github.com/nalfeo/Crawler/pull/1/../../../attacker/evil/pull/1',
      'https://github.com/nalfeo/Crawler/pull/1/files',
      // Look-alike hosts and schemes.
      'https://github.com.evil.test/nalfeo/Crawler/pull/1',
      'http://github.com/nalfeo/Crawler/pull/1',
      'https://evil.test/nalfeo/Crawler/pull/1',
      // Wrong resource kind or repository.
      'https://github.com/nalfeo/Crawler/issues/1',
      'https://github.com/attacker/Crawler/pull/1',
      'https://github.com/nalfeo/Crawler/pull/0',
      'https://github.com/nalfeo/Crawler/pull/abc',
      'not-a-url',
      '',
    ]) {
      expect(isRepositoryPullRequestUrl(hostile, 'nalfeo/Crawler')).toBe(false);
    }
  });

  it('refuses a handoff that does not point at a PR in this repository', () => {
    for (const prUrl of [
      '',
      'https://github.com/attacker/Crawler/pull/1',
      'https://example.com/nalfeo/Crawler/pull/1',
      'https://github.com/nalfeo/Crawler/issues/1',
      'https://github.com/nalfeo/Crawler/pull/1/../../../attacker/evil/pull/1',
    ]) {
      expect(
        decideLifecycleLease({
          ...base,
          operation: 'handoff',
          prUrl,
          markerComments: [markerComment(base.leaseId)],
        }),
      ).toMatchObject({
        status: 'rejected',
        reason: 'invalid-handoff-target',
        writeAction: 'none',
      });
    }
  });

  it('keeps PR-lifecycle lanes live throughout the whole handoff sequence', () => {
    const current = markerComment(base.leaseId);
    const sequence = [
      { operation: 'acquire', markerComments: [] },
      { operation: 'heartbeat', markerComments: [current] },
      {
        operation: 'handoff',
        prUrl: 'https://github.com/nalfeo/Crawler/pull/4091',
        markerComments: [current],
      },
    ];

    for (const step of sequence) {
      const decision = decideLifecycleLease({ ...base, ...step });
      expect(decision.status).not.toBe('rejected');
      // The invariant that matters: at no point in the claim lifecycle does a
      // PR-lifecycle lane lose its legacy writer.
      for (const lane of LIFECYCLE_PR_LANES) {
        expect(lifecycleLaneWriterEnabled(lane, PHASE_2, 'legacy')).toBe(true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Workflow wiring
  // ---------------------------------------------------------------------------

  it('gates each legacy workflow on its own lane, not the claim selector', () => {
    const laneGates: Array<[string, string]> = [
      ['ci-recovery.yml', 'LIFECYCLE_OWNER_CI_RECOVERY'],
      ['ci-recovery-router.yml', 'LIFECYCLE_OWNER_CI_RECOVERY'],
      ['merge-train.yml', 'LIFECYCLE_OWNER_MERGE_TRAIN'],
      ['auto-rebase-prs.yml', 'LIFECYCLE_OWNER_BRANCH_UPDATE'],
    ];

    for (const [file, laneVar] of laneGates) {
      const source = workflow(file);
      // Selecting Goobers for the claim lane must not appear in a legacy gate.
      expect(source).not.toContain("vars.LIFECYCLE_MUTATION_OWNER == 'legacy'");
      expect(source).not.toContain("vars.LIFECYCLE_MUTATION_OWNER != 'legacy'");
      // Legacy runs unless that specific lane migrated to Goobers.
      expect(source).toContain(
        `vars.${laneVar} != 'goobers' && vars.LEGACY_CI_MUTATION_BRIDGE_ENABLED == 'true'`,
      );
    }
  });

  it('keeps the owner workflow scoped to the pre-PR claim and its publication handoff', () => {
    const source = workflow('goobers-lifecycle-owner.yml');
    const parsed = parse(source);

    // Publication is a handoff trigger only -- never synchronize/closed, which
    // would make this a PR-lifecycle lease again.
    expect(parsed.on.pull_request_target.types).toEqual(['opened', 'ready_for_review']);
    expect(parsed.on.workflow_dispatch.inputs.operation.options).toEqual([
      'acquire',
      'heartbeat',
      'handoff',
      'release',
    ]);
    expect(parsed.on.workflow_dispatch.inputs.issue_number).toBeDefined();
    expect(parsed.on.workflow_dispatch.inputs.pr_number).toBeUndefined();

    // Claim concurrency must not share the PR-lifecycle group, or the claim
    // lane could stall PR automation.
    expect(parsed.concurrency.group).toContain('crawler-implementation-claim-');
    expect(workflow('ci-recovery.yml')).toContain('group: crawler-ci-pr-');

    // Startup validity regressions (see PR #4132 / #4157).
    expect(source).not.toMatch(/\$\{\{[^}]*\brunner\.temp\b[^}]*\}\}/);
    expect(
      source.match(/^\s*GOOBERS_INSTANCE="\$RUNNER_TEMP\/goobers-lifecycle-instance"$/gm),
    ).toHaveLength(3);
    expect(source.match(/^\s*export GOOBERS_INSTANCE$/gm)).toHaveLength(3);
    expect(source).toContain('mkdir -p "$GOOBERS_INSTANCE/config"');
    expect(source).toContain('cp .goobers/gaggles/crawler/workflows/crawler-lifecycle-owner.yaml');
    expect(source).not.toMatch(/cp\s+(?:-[^\s]+\s+)*\.goobers\/?\s/);
    expect(source).not.toContain('path: ${GITHUB_WORKSPACE}/.goobers');
    expect(source).toMatch(
      /path: \.goobers-lifecycle\/\s+if-no-files-found: error\s+include-hidden-files: true/,
    );
  });

  it('enforces the review-thread lane in the reconciler, not just in workflow env', () => {
    // Regression: the lane selector was previously passed as an env var that no
    // script read, so migrating the lane silently created a dual writer.
    expect(workflow('ci-recovery.yml')).toContain(
      "LIFECYCLE_OWNER_REVIEW_THREADS: ${{ vars.LIFECYCLE_OWNER_REVIEW_THREADS || 'legacy' }}",
    );

    expect(legacyReviewThreadWritesEnabled({ LIFECYCLE_OWNER_REVIEW_THREADS: 'goobers' })).toBe(
      false,
    );
    // Fail-operational: anything that is not the literal 'goobers' keeps legacy
    // resolving review threads.
    for (const value of ['legacy', '', 'Goobers', ' goobers', 'goobrs', undefined]) {
      expect(legacyReviewThreadWritesEnabled({ LIFECYCLE_OWNER_REVIEW_THREADS: value })).toBe(true);
    }

    const reconciler = fs.readFileSync(
      path.join(repositoryRoot, '.github/scripts/ci-recovery/reconcile.mjs'),
      'utf8',
    );

    // Generic review-thread WRITEs must consult the lane. Rather than pinning a
    // magic count (which would lock in an under-count and reject a correct
    // fix), assert that each generic write endpoint is gated: the two
    // outdated-marker reply POSTs and the two generic resolve passes.
    // Follow-up-backlog reply/resolve stays legacy-owned because Goobers does
    // not receive the created/reused follow-up issue mapping yet.
    const replyPosts = reconciler.match(/comments\/\$\{replyCommentId\}\/replies/g) ?? [];
    const resolveMutations = reconciler.match(/resolveReviewThread\(input:/g) ?? [];
    const gates = reconciler.match(/legacyReviewThreadWritesEnabled\(\)/g) ?? [];
    expect(replyPosts.length).toBe(3);
    expect(resolveMutations.length).toBe(3);
    const followUpBacklogWrites = 2;
    expect(gates.length).toBeGreaterThanOrEqual(
      replyPosts.length + resolveMutations.length - followUpBacklogWrites,
    );

    // The gate must precede the in-memory resolution write. Skipping only the
    // GraphQL call would mark a thread resolved without resolving it, dropping
    // a real blocker and admitting the PR prematurely.
    expect(reconciler).not.toContain('if (live && legacyReviewThreadWritesEnabled())');
    for (const segment of reconciler.split('thread.isResolved = true;').slice(0, -1)) {
      if (segment.includes('followup-backlog-thread-reply')) continue;
      const guarded = segment.lastIndexOf('if (!legacyReviewThreadWritesEnabled()) {');
      const resolveCall = segment.lastIndexOf('resolveReviewThread(input:');
      expect(guarded).toBeGreaterThan(-1);
      expect(guarded).toBeLessThan(resolveCall);
    }
  });

  it('keeps Goobers intake gated on the claim lane so rollback cannot dual-write', () => {
    // Legacy intake now defers only while Goobers owns the lane, so the Goobers
    // entry point must be gated on the same literal or a rollback would leave
    // both writers claiming the same approved issue.
    expect(workflow('goobers-run.yml')).toContain("vars.LIFECYCLE_MUTATION_OWNER == 'goobers' &&");
  });

  it('leaves no approved issue unowned for ANY value of the claim selector', () => {
    // The no-work-gap proof. Goobers runs iff the selector is the literal
    // `goobers` (the goobers-run.yml job gate); legacy intake handles the issue
    // iff it is NOT that literal (goobersOwnsImplementationClaim). Those are
    // exact complements, so every possible configuration — including unset,
    // empty, and malformed — leaves exactly one owner and never zero.
    expect(workflow('goobers-run.yml')).toContain("vars.LIFECYCLE_MUTATION_OWNER == 'goobers' &&");

    for (const selector of [
      'goobers',
      'legacy',
      'off',
      '',
      ' goobers',
      'Goobers',
      'GOOBERS',
      'goobrs',
      'true',
      undefined,
    ]) {
      const goobersHandles = selector === 'goobers';
      const legacyHandles = !goobersOwnsImplementationClaim({
        LIFECYCLE_MUTATION_OWNER: selector,
      });
      expect([goobersHandles, legacyHandles].filter(Boolean)).toHaveLength(1);
    }
  });

  it('proves the Goobers path itself takes an exclusive pre-PR claim and ends it at publication', () => {
    // The implementation-claim boundary is satisfied by the production Goobers
    // workflow, not only by the comment lease: `query-backlog` takes an
    // exclusive claim and `open-pr` always transitions it.
    const gaggle = parse(
      fs.readFileSync(
        path.join(repositoryRoot, '.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml'),
        'utf8',
      ),
    );
    const tasks = Object.fromEntries(
      gaggle.spec.tasks.map((task: { name: string }) => [task.name, task]),
    );
    const gates = Object.fromEntries(
      gaggle.spec.gates.map((gate: { name: string }) => [gate.name, gate]),
    );

    // Acquisition is exclusive: only approved, unassigned, not-already-claimed
    // issues, one at a time...
    const claim = tasks['query-backlog'];
    expect(claim.inputs.trustLabel).toBe('goobers:approved');
    expect(claim.inputs.requireUnassigned).toBe('true');
    expect(claim.inputs.excludeLabel).toBe('goobers/status:in-review');
    expect(claim.inputs.maxItems).toBe('1');
    // ...and claiming SETS the very label named in excludeLabel, so the claim
    // is self-excluding against any later run.
    expect(claim.run.script).toContain("--add-label 'goobers/status:in-review'");
    expect(gaggle.spec.readiness.maxConcurrentRuns).toBe(1);

    // Publication deterministically ends the claim on EVERY branch, so a claim
    // can never outlive PR publication.
    expect(tasks['open-pr'].next).toBe('pr-opened-gate');
    expect(gates['pr-opened-gate'].branches.pass).toBe('close-out');
    expect(gates['pr-opened-gate'].branches.fail).toBe('close-out');
    expect(tasks['close-out'].inputs.status).toBe('in-review');
  });

  it('resolves closing issues within this repository and bounded', () => {
    const source = workflow('goobers-lifecycle-owner.yml');
    // A cross-repository closing reference must not alias a same-numbered
    // local issue.
    expect(source).toContain('nodes { number repository { nameWithOwner } }');
    expect(source).toContain('closingIssuesReferences(first:100)');
    // More references than one page cannot prove which claim ends here.
    expect(source).toContain("skip('unbounded-closing-references')");

    // The truncation guard must precede candidate classification, or a claim
    // that only appears past page one is reported as "no claim" instead of the
    // honest fail-closed reason.
    const truncation = source.indexOf("skip('unbounded-closing-references')");
    const ambiguous = source.indexOf("skip('ambiguous-claimed-issues')");
    const noClaim = source.indexOf("skip('no-claimed-issue')");
    expect(truncation).toBeGreaterThan(-1);
    expect(truncation).toBeLessThan(ambiguous);
    expect(truncation).toBeLessThan(noClaim);
  });

  it('hands approved-issue intake back to legacy on rollback', () => {
    // Rollback must not leave approved issues without an intake owner.
    expect(goobersOwnsImplementationClaim({ LIFECYCLE_MUTATION_OWNER: 'goobers' })).toBe(true);
    for (const value of ['legacy', '', 'Goobers', ' goobers', 'off', undefined]) {
      expect(goobersOwnsImplementationClaim({ LIFECYCLE_MUTATION_OWNER: value })).toBe(false);
    }

    const intake = fs.readFileSync(
      path.join(repositoryRoot, '.github/scripts/ci-recovery/issue-intake-lib.mjs'),
      'utf8',
    );
    // Each deferral to Goobers must be conditional on Goobers owning the lane.
    expect(intake.match(/goobersOwnsImplementationClaim\(\)/g)).toHaveLength(3);
    expect(workflow('issue-copilot-intake.yml')).toContain(
      'LIFECYCLE_MUTATION_OWNER: ${{ vars.LIFECYCLE_MUTATION_OWNER }}',
    );
  });

  it('always writes a decision artifact, even when publication is a no-op', () => {
    // The artifact upload uses if-no-files-found: error, so a skip path that
    // wrote nothing turned an expected no-op into a failed workflow run.
    const source = workflow('goobers-lifecycle-owner.yml');
    expect(source).toContain("skip('no-claimed-issue')");
    expect(source).toContain("skip('ambiguous-claimed-issues')");
    expect(source).toContain('.goobers-lifecycle/decision.json');
    // Ambiguity is refused rather than guessed.
    expect(source).toContain('refusing to hand off');
  });
});
