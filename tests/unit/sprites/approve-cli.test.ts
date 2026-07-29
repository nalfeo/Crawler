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

  return {
    runQueueCommit,
    loadApprovedEntry,
    loadApprovedFrameSequenceEntry,
    approveVariant,
    approveFrameSequence,
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

vi.mock('../../../scripts/sprites/approve.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../scripts/sprites/approve.js')>();
  return {
    ...original,
    approveVariant: mocks.approveVariant,
    loadApprovedEntry: mocks.loadApprovedEntry,
    approveFrameSequence: mocks.approveFrameSequence,
    loadApprovedFrameSequenceEntry: mocks.loadApprovedFrameSequenceEntry,
    ApproveError: mocks.ApproveError,
  };
});

// ── import the subject under test AFTER mocks are registered ───────────────
const { main } = await import('../../../scripts/sprites/approve-cli.js');

// ── tests ──────────────────────────────────────────────────────────────────

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

describe('approve-cli --sequence already-approved idempotent retry (round-1 code review finding)', () => {
  let savedCI: string | undefined;

  beforeEach(() => {
    savedCI = process.env.CI;
    delete process.env.CI;
    mocks.runQueueCommit.mockClear();
    mocks.loadApprovedFrameSequenceEntry.mockClear();
    mocks.approveFrameSequence.mockClear();
  });

  afterEach(() => {
    if (savedCI !== undefined) {
      process.env.CI = savedCI;
    }
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
