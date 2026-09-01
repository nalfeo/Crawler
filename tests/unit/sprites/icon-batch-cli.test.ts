import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runFull: vi.fn(async () => ({ runDir: '/fake/runs/icons/run-01' })),
  resolveGenerationRunStore: vi.fn(() => ({
    store: { backend: 'fake' },
    durable: { backend: 'fake-durable' },
    mode: 'durable',
    description: 'run store: DURABLE',
  })),
  parseSourceRun: vi.fn(() => ({ briefId: 'icons', runId: 'run-01' })),
  ensureRunDurable: vi.fn(async () => ({ backfilled: [], verified: ['summary.json'] })),
  approveIconBatch: vi.fn(() => [
    {
      spriteName: 'test-icon',
      assetPath: 'generated/test-icon.png',
      briefId: 'test-icons',
      variantIndex: 0,
    },
  ]),
  runQueueCommit: vi.fn(async () => ({
    status: 'committed',
    branch: 'assets/queue',
    commit: 'abc123',
  })),
}));

vi.mock('../../../scripts/sprites/run-full.js', () => ({ runFull: mocks.runFull }));
vi.mock('../../../scripts/sprites/run-durability.js', () => ({
  resolveGenerationRunStore: mocks.resolveGenerationRunStore,
  parseSourceRun: mocks.parseSourceRun,
  ensureRunDurable: mocks.ensureRunDurable,
}));
vi.mock('../../../scripts/sprites/approve.js', () => ({
  approveIconBatch: mocks.approveIconBatch,
}));
vi.mock('../../../scripts/sprites/queue-commit.js', () => ({
  runQueueCommit: mocks.runQueueCommit,
}));
vi.mock('../../../scripts/sprites/queue-commit-runtime.js', () => ({
  createDefaultQueueCommitDeps: vi.fn(() => ({})),
}));
vi.mock('../../../scripts/sprites/provider/factory.js', () => ({
  createImageProvider: vi.fn(() => ({})),
  createTextProvider: vi.fn(() => ({})),
  createVisionProvider: vi.fn(() => ({})),
}));

const { main } = await import('../../../scripts/sprites/icon-batch-cli.js');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('icon-batch-cli durability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists and verifies the run before icon approval and queue publication', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'icon-batch-cli-'));
    tempDirs.push(dir);
    const brief = path.join(dir, 'test-icons.yaml');
    writeFileSync(brief, 'iconBatch:\n  - id: test-icon\n    concept: Test icon\n');

    expect(await main(['run', '--brief', brief])).toBe(0);
    expect(mocks.runFull).toHaveBeenCalledWith(
      expect.objectContaining({ store: { backend: 'fake' } }),
    );
    expect(mocks.ensureRunDurable).toHaveBeenCalledWith({
      briefId: 'icons',
      runId: 'run-01',
      durable: { backend: 'fake-durable' },
      localRunDir: '/fake/runs/icons/run-01',
    });
    expect(mocks.ensureRunDurable.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.approveIconBatch.mock.invocationCallOrder[0]!,
    );
    expect(mocks.ensureRunDurable.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runQueueCommit.mock.invocationCallOrder[0]!,
    );
  });

  it('fails closed before approval and queue publication when verification fails', async () => {
    mocks.ensureRunDurable.mockRejectedValueOnce(new Error('Azure unavailable'));
    const dir = mkdtempSync(path.join(tmpdir(), 'icon-batch-cli-'));
    tempDirs.push(dir);
    const brief = path.join(dir, 'test-icons.yaml');
    writeFileSync(brief, 'iconBatch:\n  - id: test-icon\n    concept: Test icon\n');

    expect(await main(['run', '--brief', brief])).toBe(1);
    expect(mocks.approveIconBatch).not.toHaveBeenCalled();
    expect(mocks.runQueueCommit).not.toHaveBeenCalled();
  });
});
