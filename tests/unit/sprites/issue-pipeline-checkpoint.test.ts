import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createIssueCheckpointController,
  loadIssueCheckpoint,
  markIssuePipelineTerminal,
  runCheckpointStage,
} from '../../../scripts/sprites/issue-pipeline-checkpoint.js';
import { QueueCommitError } from '../../../scripts/sprites/queue-commit.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';

function makeStore(): RunStore & { mem: Map<string, Buffer> } {
  const mem = new Map<string, Buffer>();
  return {
    mem,
    backend: 'local',
    async put(key, data) {
      mem.set(key, data);
    },
    async get(key) {
      const value = mem.get(key);
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    },
    async has(key) {
      return mem.has(key);
    },
    async list(prefix) {
      return [...mem.keys()].filter((key) => key.startsWith(prefix));
    },
    async remove(key) {
      mem.delete(key);
    },
    resolve(key) {
      return key;
    },
  };
}

function controller(store: RunStore) {
  return createIssueCheckpointController({
    store,
    issueNumber: 42,
    fingerprint: 'request-fingerprint',
    now: () => new Date('2026-07-24T12:00:00.000Z'),
  });
}

describe('issue pipeline checkpoints', () => {
  it('retries transient failures three times and persists the successful output', async () => {
    const store = makeStore();
    const operation = vi
      .fn<() => Promise<{ value: string }>>()
      .mockRejectedValueOnce(new Error('temporary one'))
      .mockRejectedValueOnce(new Error('temporary two'))
      .mockResolvedValueOnce({ value: 'done' });

    const result = await runCheckpointStage(
      controller(store),
      'generate',
      z.object({ value: z.string() }).strict(),
      operation,
    );

    expect(result).toEqual({ output: { value: 'done' }, resumed: false });
    expect(operation).toHaveBeenCalledTimes(3);
    const checkpoint = await loadIssueCheckpoint(controller(store));
    expect(checkpoint?.stages['generate']).toMatchObject({
      status: 'completed',
      attempts: 3,
      output: { value: 'done' },
    });
  });

  it('resumes a completed stage without invoking provider work again', async () => {
    const store = makeStore();
    const firstOperation = vi.fn(async () => ({ runId: 'run-1' }));
    const schema = z.object({ runId: z.string() }).strict();
    await runCheckpointStage(controller(store), 'generate', schema, firstOperation);

    const resumedOperation = vi.fn(async () => ({ runId: 'run-2' }));
    const resumed = await runCheckpointStage(
      controller(store),
      'generate',
      schema,
      resumedOperation,
    );

    expect(resumed).toEqual({ output: { runId: 'run-1' }, resumed: true });
    expect(resumedOperation).not.toHaveBeenCalled();
  });

  it('does not consume transient retries for permanent failures', async () => {
    const store = makeStore();
    const operation = vi.fn(async () => {
      throw new QueueCommitError('destination-conflict', 'different payload exists');
    });

    await expect(
      runCheckpointStage(
        controller(store),
        'publish',
        z.object({ published: z.boolean() }).strict(),
        operation,
      ),
    ).rejects.toThrow('different payload exists');

    expect(operation).toHaveBeenCalledTimes(1);
    const checkpoint = await loadIssueCheckpoint(controller(store));
    expect(checkpoint?.stages['publish']).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: {
        kind: 'destination-conflict',
      },
    });
  });

  it('keeps a completed generation terminal while publication is pending', async () => {
    const store = makeStore();
    const stageOperation = vi.fn(async () => ({ runId: 'run-1' }));
    const checkpoint = controller(store);
    await runCheckpointStage(
      checkpoint,
      'select-variants',
      z.object({ runId: z.string() }).strict(),
      stageOperation,
    );
    await markIssuePipelineTerminal(checkpoint, 'selected-pending-publish', {
      runId: 'run-1',
      selectedIndexes: [0, 2],
    });

    const retryOperation = vi.fn(async () => ({ runId: 'run-2' }));
    const resumed = await runCheckpointStage(
      controller(store),
      'select-variants',
      z.object({ runId: z.string() }).strict(),
      retryOperation,
    );

    expect(resumed.resumed).toBe(true);
    expect(retryOperation).not.toHaveBeenCalled();
    const persisted = await loadIssueCheckpoint(controller(store));
    expect(persisted).toMatchObject({
      stage: 'completed',
      details: {
        outcome: 'selected-pending-publish',
      },
    });
  });
});
