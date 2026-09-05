/**
 * Unit tests for approve-cli.ts — the idempotent already-approved retry path
 * for both `--variant` (concern #6) and `--sequence` (round-1 code review
 * finding: the same retry gap existed for frame-sequence approvals).
 *
 * Strategy: mock the I/O boundaries (`approveVariant`/`approveFrameSequence`,
 * `loadApprovedEntry`/`loadApprovedFrameSequenceEntry`, and `runQueueCommit`)
 * so the test exercises only the CLI's own wiring logic, verifying that an
 * `already-approved` entry re-enters `runQueueCommit` and returns exit code 0
 * instead of the old early-exit with a non-zero code.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── hoisted mocks ─────────────────────────────────────────────────────────
// vi.mock factory functions are hoisted above imports; use vi.hoisted() to
// create the spy references that the factory closures can safely capture.

const mocks = vi.hoisted(() => {
  const FAKE_ENTRY = {
    briefId: 'iron-sword',
    spriteName: 'iron-sword-var-1',
    assetPath: 'generated/iron-sword-var-1.png',
    approvedAt: '2026-07-01T00:00:00.000Z',
    sourceRun: 'generated/runs/iron-sword/2026-07-01T00-00-00-deadbeef',
    variantIndex: 1,
    anchor: null,
    anchors: { hold: null, centerOfGravity: null },
    sensorScore: '7/7',
    judgeScore: null,
    type: null,
  };

  const FAKE_SEQUENCE_ENTRY = {
    briefId: 'player-walk-cycle',
    spriteName: 'player-walk-cycle',
    assetPath: 'generated/player-walk-cycle.png',
    approvedAt: '2026-07-01T00:00:00.000Z',
    sourceRun: 'generated/runs/player-walk-cycle/2026-07-01T00-00-00-deadbeef',
    variantIndex: 0,
    anchor: null,
    anchors: { hold: null, centerOfGravity: null },
    sensorScore: 'frame-sequence',
    judgeScore: null,
    type: null,
    animation: { frameWidth: 64, frameHeight: 64, frameCount: 4, frameRate: 8, loop: true },
  };

  const runQueueCommit = vi.fn(async () => ({
    status: 'committed' as const,
    branch: 'assets/queue',
    commit: 'abc1234567890',
  }));

  const loadApprovedEntry = vi.fn(() => FAKE_ENTRY);
  const loadApprovedFrameSequenceEntry = vi.fn(() => FAKE_SEQUENCE_ENTRY);

  class ApproveError extends Error {
    constructor(
      public readonly kind: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApproveError';
    }
  }

  const approveVariant = vi.fn(() => {
    throw new ApproveError('already-approved', 'variant 1 already approved');
  });

  const approveFrameSequence = vi.fn(() => {
    throw new ApproveError('already-approved', 'player-walk-cycle already approved');
  });
  const approveIconBatch = vi.fn((_options: { readonly allowHardBlocked?: boolean }) => [
    {
      briefId: 'achv-icons',
      spriteName: 'achv-first-bonk',
      assetPath: 'generated/achv-first-bonk.png',
      variantIndex: 0,
    },
  ]);
  const resolveVariantIdentity = vi.fn(() => ({
    briefId: FAKE_ENTRY.briefId,
    variantId: FAKE_ENTRY.spriteName,
    assetPath: FAKE_ENTRY.assetPath,
    contentHash: 'a'.repeat(64),
  }));
  const resolveFrameSequenceIdentity = vi.fn(() => ({
    briefId: FAKE_SEQUENCE_ENTRY.briefId,
    variantId: FAKE_SEQUENCE_ENTRY.spriteName,
    assetPath: FAKE_SEQUENCE_ENTRY.assetPath,
  }));

  return {
    runQueueCommit,
    loadApprovedEntry,
    loadApprovedFrameSequenceEntry,
    approveVariant,
    approveFrameSequence,
    approveIconBatch,
    resolveVariantIdentity,
    resolveFrameSequenceIdentity,
    ApproveError,
    FAKE_ENTRY,
    FAKE_SEQUENCE_ENTRY,
  };
});

vi.mock('../../../scripts/sprites/queue-commit.js', () => ({
  runQueueCommit: mocks.runQueueCommit,
  QueueCommitError: class extends Error {},
}));

vi.mock('../../../scripts/sprites/queue-commit-runtime.js', () => ({
  createDefaultQueueCommitDeps: vi.fn(() => ({})),
}));

// The durability gate reaches for a real Azure store, so stub the two I/O
// entry points. Everything else (RunDurabilityError, parseSourceRun) stays real
// so the CLI's own error handling is genuinely exercised.
const durability = vi.hoisted(() => ({
  resolvePublicationDurableStore: vi.fn(() => ({ backend: 'fake-durable' })),
  ensureRunDurable: vi.fn(() => Promise.resolve({ backfilled: [], verified: ['a', 'b'] })),
}));

vi.mock('../../../scripts/sprites/run-durability.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../scripts/sprites/run-durability.js')>();
  return {
    ...original,
    resolvePublicationDurableStore: durability.resolvePublicationDurableStore,
    ensureRunDurable: durability.ensureRunDurable,
  };
});

vi.mock('../../../scripts/sprites/approve.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../scripts/sprites/approve.js')>();
  return {
    ...original,
    approveVariant: mocks.approveVariant,
    loadApprovedEntry: mocks.loadApprovedEntry,
    approveFrameSequence: mocks.approveFrameSequence,
    approveIconBatch: mocks.approveIconBatch,
    loadApprovedFrameSequenceEntry: mocks.loadApprovedFrameSequenceEntry,
    resolveVariantIdentity: mocks.resolveVariantIdentity,
    resolveFrameSequenceIdentity: mocks.resolveFrameSequenceIdentity,
    ApproveError: mocks.ApproveError,
  };
});

const lifecycle = vi.hoisted(() => {
  interface FakePlan {
    removed: Array<{ manifestKey: string; assetPath: string }>;
    retainedGroups: Array<{ conceptId: string; manifestKeys: string[] }>;
    deferredGroups: Array<{ conceptId: string; manifestKeys: string[] }>;
    annotationUpdates: Array<Record<string, unknown> & { key: string }>;
  }
  return {
    runAcceptedDislikedLifecycleTransaction: vi.fn(
      async (options: {
        replacements: readonly { manifestKey: string; conceptId: string; assetPath: string }[];
        approve: () => unknown;
        publish: (approved: unknown, plan: FakePlan) => Promise<void>;
      }) => {
        const approved = options.approve();
        const plan: FakePlan = {
          removed: [],
          retainedGroups: [],
          deferredGroups: [],
          annotationUpdates: [],
        };
        await options.publish(approved, plan);
        return { approved, plan };
      },
    ),
  };
});

vi.mock('../../../scripts/sprites/disliked-lifecycle.js', () => ({
  runAcceptedDislikedLifecycleTransaction: lifecycle.runAcceptedDislikedLifecycleTransaction,
  toQueueCommitAnnotationUpdates: vi.fn((updates: readonly unknown[]) => updates),
}));

vi.mock('../../../scripts/sprites/checkin-runtime.js', () => ({
  makeCheckinFileLock: vi.fn(() => async (run: () => Promise<unknown>) => run()),
}));

// ── import the subject under test AFTER mocks are registered ───────────────
const { main } = await import('../../../scripts/sprites/approve-cli.js');
const { RunDurabilityError } = await import('../../../scripts/sprites/run-durability.js');

// ── tests ──────────────────────────────────────────────────────────────────

/**
 * The durability gate is the fix for the incident where seven finished sprite
 * runs were approved into git while their briefs, prompts and sheets existed
 * only inside a gitignored worktree that later vanished. Approving writes a
 * manifest `sourceRun` pointer and pushes a commit to `assets/queue`; both are
 * promises that the run still exists somewhere recoverable.
 */
describe('approve-cli durability gate (fail-closed before git publication)', () => {
  let savedCI: string | undefined;

  beforeEach(() => {
    savedCI = process.env.CI;
    delete process.env.CI;
    mocks.runQueueCommit.mockClear();
    mocks.approveVariant.mockClear();
    mocks.resolveVariantIdentity.mockClear();
    lifecycle.runAcceptedDislikedLifecycleTransaction.mockClear();
    durability.ensureRunDurable.mockClear();
    durability.resolvePublicationDurableStore.mockClear();
  });

  afterEach(() => {
    if (savedCI !== undefined) process.env.CI = savedCI;
    else delete process.env.CI;
  });

  it('verifies durability BEFORE approving or committing to the queue', async () => {
    await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(durability.ensureRunDurable).toHaveBeenCalledOnce();
    expect(mocks.runQueueCommit).toHaveBeenCalledOnce();
    // Ordering is the whole contract: Azure writes must be verified complete
    // before anything git-backed is emitted.
    const durableOrder = durability.ensureRunDurable.mock.invocationCallOrder[0] ?? 0;
    const approveOrder = mocks.approveVariant.mock.invocationCallOrder[0] ?? 0;
    const commitOrder = mocks.runQueueCommit.mock.invocationCallOrder[0] ?? 0;
    expect(durableOrder).toBeLessThan(approveOrder);
    expect(durableOrder).toBeLessThan(commitOrder);
    expect(lifecycle.runAcceptedDislikedLifecycleTransaction).toHaveBeenCalledOnce();
  });

  it('passes the run coordinates parsed from the run dir', async () => {
    await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(durability.ensureRunDurable).toHaveBeenCalledWith(
      expect.objectContaining({ briefId: 'iron-sword', runId: 'run-01' }),
    );
  });

  it('fails closed when variant identity resolution fails', async () => {
    mocks.resolveVariantIdentity.mockImplementationOnce(() => {
      throw new Error('missing variant provenance');
    });

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(exitCode).toBe(1);
    expect(lifecycle.runAcceptedDislikedLifecycleTransaction).not.toHaveBeenCalled();
    expect(mocks.approveVariant).not.toHaveBeenCalled();
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });

  it('fails closed with exit code 5 and never publishes when the run is not durable', async () => {
    durability.ensureRunDurable.mockRejectedValueOnce(
      new RunDurabilityError('missing artifacts', ['iron-sword/run-01/sheet-NN.png']),
    );

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(exitCode).toBe(5);
    // No success-shaped git output whatsoever: no approval, no queue commit.
    expect(mocks.approveVariant).not.toHaveBeenCalled();
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });

  it('fails closed when no durable store is configured at all', async () => {
    durability.resolvePublicationDurableStore.mockReturnValueOnce(
      null as unknown as { backend: string },
    );
    durability.ensureRunDurable.mockRejectedValueOnce(
      new RunDurabilityError('no durable run store is configured'),
    );

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(exitCode).toBe(5);
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });

  it('treats an ordinary durable-store error as a fail-closed exit 5', async () => {
    durability.ensureRunDurable.mockRejectedValueOnce(new Error('Azure unavailable'));

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(exitCode).toBe(5);
    expect(mocks.approveVariant).not.toHaveBeenCalled();
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });

  it('surfaces a queue-commit failure that would strand an annotation-only lifecycle change', async () => {
    // A tombstone clear (or any annotation write) is applied LOCALLY before
    // publication. Swallowing the push failure would make the advertised
    // "re-run to retry" a lie: the second run computes an empty delta and never
    // republishes it. So the publish must throw and let the transaction roll back.
    lifecycle.runAcceptedDislikedLifecycleTransaction.mockImplementationOnce(async (options) => {
      const approved = options.approve();
      const plan = {
        removed: [],
        retainedGroups: [],
        deferredGroups: [],
        annotationUpdates: [{ key: 'iron-sword-var-1', tombstone: undefined }],
      };
      await options.publish(approved, plan as never);
      return { approved, plan };
    });
    mocks.runQueueCommit.mockRejectedValueOnce(new Error('push rejected'));

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(exitCode).not.toBe(0);
  });

  it('still keeps a plain approval local-only (exit 0) when queue-commit fails with no lifecycle change', async () => {
    mocks.runQueueCommit.mockRejectedValueOnce(new Error('push rejected'));

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(exitCode).toBe(0);
  });

  it('skips the gate on CI, where the CLI approves locally and never pushes', async () => {
    process.env.CI = 'true';

    await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(durability.ensureRunDurable).not.toHaveBeenCalled();
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });
});

describe('approve-cli already-approved idempotent retry (concern #6)', () => {
  let savedCI: string | undefined;

  beforeEach(() => {
    savedCI = process.env.CI;
    // The queue-commit block is skipped on CI; delete the env var so the test
    // exercises the non-CI path that actually calls runQueueCommit.
    delete process.env.CI;
    mocks.runQueueCommit.mockClear();
    mocks.loadApprovedEntry.mockClear();
    mocks.approveVariant.mockClear();
  });

  afterEach(() => {
    if (savedCI !== undefined) {
      process.env.CI = savedCI;
    }
  });

  it('re-enters runQueueCommit for an already-approved entry and returns exit code 0', async () => {
    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    // The critical invariant: exits 0 (was 1 before the fix) even when the
    // variant was already approved, because the CLI re-runs queue-commit.
    expect(exitCode).toBe(0);

    // The queue-commit MUST have been reached — this is the regression guard.
    // Before the fix the CLI exited immediately after the `already-approved`
    // error, so the durable push was never retried (the warning's advice lied).
    expect(mocks.runQueueCommit).toHaveBeenCalledOnce();

    // The asset info passed to runQueueCommit must come from the stored entry.
    const callArgs = (mocks.runQueueCommit.mock.calls[0] as unknown[]) ?? [];
    const assets = callArgs[1] as Array<{ manifestKey: string }>;
    expect(assets[0]?.manifestKey).toBe('iron-sword-var-1');
  });

  it('returns exit code 0 on CI without calling runQueueCommit (already-approved CI path)', async () => {
    process.env.CI = 'true';

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    // On CI the remote push is skipped, but the exit code must still be 0 —
    // the already-approved retry is a success, not an error.
    expect(exitCode).toBe(0);
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });

  it('returns a non-zero exit code when the stored manifest entry cannot be found', async () => {
    mocks.loadApprovedEntry.mockReturnValueOnce(null as never);

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    // No stored entry → nothing to make durable; original error code preserved.
    expect(exitCode).not.toBe(0);
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });
});

describe('approve-cli --allow-hard-blocked flag and exit-code-4 (hard-blocked)', () => {
  let savedCI: string | undefined;

  beforeEach(() => {
    savedCI = process.env.CI;
    delete process.env.CI;
    mocks.runQueueCommit.mockClear();
    mocks.loadApprovedEntry.mockClear();
    mocks.approveVariant.mockClear();
  });

  afterEach(() => {
    if (savedCI !== undefined) {
      process.env.CI = savedCI;
    } else {
      delete process.env.CI;
    }
  });

  it('returns exit code 4 when approveVariant throws a hard-blocked error', async () => {
    mocks.approveVariant.mockImplementationOnce(() => {
      throw new mocks.ApproveError('hard-blocked', 'variant 1 was hard-blocked by the judge');
    });

    const exitCode = await main(['/fake/runs/iron-sword/run-01', '--variant', '1'], '/fake/repo');

    expect(exitCode).toBe(4);
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });

  it('forwards allowHardBlocked: true when --allow-hard-blocked is passed', async () => {
    mocks.approveVariant.mockReturnValueOnce(mocks.FAKE_ENTRY as never);

    const exitCode = await main(
      ['/fake/runs/iron-sword/run-01', '--variant', '1', '--allow-hard-blocked'],
      '/fake/repo',
    );

    expect(exitCode).toBe(0);

    // Verify allowHardBlocked: true was forwarded to approveVariant.
    const callArgs = (mocks.approveVariant.mock.calls[0] as unknown[]) ?? [];
    const opts = callArgs[0] as { allowHardBlocked?: boolean };
    expect(opts.allowHardBlocked).toBe(true);
  });
});

describe('approve-cli --sequence already-approved idempotent retry (round-1 code review finding)', () => {
  let savedCI: string | undefined;

  beforeEach(() => {
    savedCI = process.env.CI;
    delete process.env.CI;
    mocks.runQueueCommit.mockClear();
    mocks.loadApprovedFrameSequenceEntry.mockClear();
    mocks.approveFrameSequence.mockClear();
    mocks.resolveFrameSequenceIdentity.mockClear();
    lifecycle.runAcceptedDislikedLifecycleTransaction.mockClear();
  });

  afterEach(() => {
    if (savedCI !== undefined) {
      process.env.CI = savedCI;
    }
  });

  it('routes the frame-sequence acceptance through the disliked-asset lifecycle transaction', async () => {
    const exitCode = await main(
      ['/fake/runs/player-walk-cycle/run-01', '--sequence'],
      '/fake/repo',
    );

    // Accepting a walk cycle replaces the art for a whole concept, so it must
    // not approve outside the transaction that retires what it replaces.
    expect(exitCode).toBe(0);
    expect(lifecycle.runAcceptedDislikedLifecycleTransaction).toHaveBeenCalledOnce();
    const options = lifecycle.runAcceptedDislikedLifecycleTransaction.mock.calls[0]?.[0];
    expect(options?.replacements).toEqual([
      {
        manifestKey: 'player-walk-cycle',
        conceptId: 'player-walk-cycle',
        assetPath: 'generated/player-walk-cycle.png',
      },
    ]);
    // Identity is resolved WITHOUT mutating, before approval runs.
    expect(mocks.resolveFrameSequenceIdentity).toHaveBeenCalledOnce();
    const identityOrder = mocks.resolveFrameSequenceIdentity.mock.invocationCallOrder[0] ?? 0;
    const approveOrder = mocks.approveFrameSequence.mock.invocationCallOrder[0] ?? 0;
    expect(identityOrder).toBeLessThan(approveOrder);
  });

  it('re-enters runQueueCommit for an already-approved frame sequence and returns exit code 0', async () => {
    const exitCode = await main(
      ['/fake/runs/player-walk-cycle/run-01', '--sequence'],
      '/fake/repo',
    );

    // The critical invariant this test guards: exits 0 (was 1 before the fix)
    // even when the sequence was already approved, because the CLI re-runs
    // queue-commit instead of dead-ending on `already-approved`.
    expect(exitCode).toBe(0);
    expect(mocks.runQueueCommit).toHaveBeenCalledOnce();

    const callArgs = (mocks.runQueueCommit.mock.calls[0] as unknown[]) ?? [];
    const assets = callArgs[1] as Array<{ manifestKey: string }>;
    expect(assets[0]?.manifestKey).toBe('player-walk-cycle');
  });

  it('returns exit code 0 on CI without calling runQueueCommit (already-approved sequence CI path)', async () => {
    process.env.CI = 'true';

    const exitCode = await main(
      ['/fake/runs/player-walk-cycle/run-01', '--sequence'],
      '/fake/repo',
    );

    expect(exitCode).toBe(0);
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });

  it('returns a non-zero exit code when the stored sequence manifest entry cannot be found', async () => {
    mocks.loadApprovedFrameSequenceEntry.mockReturnValueOnce(null as never);

    const exitCode = await main(
      ['/fake/runs/player-walk-cycle/run-01', '--sequence'],
      '/fake/repo',
    );

    expect(exitCode).not.toBe(0);
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });
});

describe('approve-cli --icon-batch lifecycle routing', () => {
  const roots: string[] = [];
  let savedCI: string | undefined;

  beforeEach(() => {
    savedCI = process.env.CI;
    delete process.env.CI;
    mocks.runQueueCommit.mockClear();
    mocks.approveIconBatch.mockClear();
    lifecycle.runAcceptedDislikedLifecycleTransaction.mockClear();
  });

  afterEach(async () => {
    if (savedCI !== undefined) process.env.CI = savedCI;
    else delete process.env.CI;
    const { rm } = await import('node:fs/promises');
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('routes an icon batch through the transaction with one replacement per declared icon', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const nodePath = (await import('node:path')).default;

    const repoRoot = mkdtempSync(nodePath.join(tmpdir(), 'approve-cli-icons-'));
    roots.push(repoRoot);
    const runDir = nodePath.join(repoRoot, 'generated', 'runs', 'achv-icons', 'run-01');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(nodePath.join(repoRoot, 'briefs'), { recursive: true });
    writeFileSync(
      nodePath.join(runDir, 'summary.json'),
      JSON.stringify({ briefPath: 'briefs/achv-icons.yaml' }),
    );
    writeFileSync(
      nodePath.join(repoRoot, 'briefs', 'achv-icons.yaml'),
      'name: achv-icons\niconBatch:\n  - id: achv-first-bonk\n  - id: achv-deep-delve\n',
    );

    const exitCode = await main([runDir, '--icon-batch'], repoRoot);

    expect(exitCode).toBe(0);
    // Every declared icon id is its own concept, so each is an explicit
    // replacement acceptance that scopes cleanup to that icon.
    expect(lifecycle.runAcceptedDislikedLifecycleTransaction).toHaveBeenCalledOnce();
    const options = lifecycle.runAcceptedDislikedLifecycleTransaction.mock.calls[0]?.[0];
    expect(options?.replacements).toEqual([
      {
        manifestKey: 'achv-first-bonk',
        conceptId: 'achv-first-bonk',
        assetPath: 'generated/achv-first-bonk.png',
      },
      {
        manifestKey: 'achv-deep-delve',
        conceptId: 'achv-deep-delve',
        assetPath: 'generated/achv-deep-delve.png',
      },
    ]);
    // Approval and publication still happen, inside the transaction.
    expect(mocks.approveIconBatch).toHaveBeenCalledOnce();
    expect(mocks.runQueueCommit).toHaveBeenCalledOnce();
    // Default is fail-closed: no override unless the operator asks for one.
    expect(mocks.approveIconBatch.mock.calls[0]?.[0]).toMatchObject({
      allowHardBlocked: false,
    });
  });

  /**
   * Regression: `--allow-hard-blocked` was parsed and then dropped on the floor
   * for `--icon-batch`, so a documented, conscious human override silently did
   * nothing and the approval still failed with `hard-blocked`.
   */
  it('forwards --allow-hard-blocked to approveIconBatch', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const nodePath = (await import('node:path')).default;

    const repoRoot = mkdtempSync(nodePath.join(tmpdir(), 'approve-cli-icons-override-'));
    roots.push(repoRoot);
    const runDir = nodePath.join(repoRoot, 'generated', 'runs', 'achv-icons', 'run-01');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(nodePath.join(repoRoot, 'briefs'), { recursive: true });
    writeFileSync(
      nodePath.join(runDir, 'summary.json'),
      JSON.stringify({ briefPath: 'briefs/achv-icons.yaml' }),
    );
    writeFileSync(
      nodePath.join(repoRoot, 'briefs', 'achv-icons.yaml'),
      'name: achv-icons\niconBatch:\n  - id: achv-first-bonk\n',
    );

    const exitCode = await main([runDir, '--icon-batch', '--allow-hard-blocked'], repoRoot);

    expect(exitCode).toBe(0);
    expect(mocks.approveIconBatch.mock.calls[0]?.[0]).toMatchObject({
      allowHardBlocked: true,
    });
  });
});
