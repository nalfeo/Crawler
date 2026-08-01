import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createIssueCheckpointController,
  IssuePipelineCheckpointError,
  loadIssueCheckpoint,
  markIssuePipelineTerminal,
  resetExhaustedTransientStage,
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

  describe('resetExhaustedTransientStage', () => {
    const schema = z.object({ ok: z.boolean() }).strict();

    /** Write a checkpoint directly with a specific publish-stage failure state. */
    async function seedPublishFailures(
      store: ReturnType<typeof makeStore>,
      attempts: number,
      kind: string | null = null,
    ) {
      const ctrl = controller(store);
      // `runCheckpointStage` with transient errors retries to maxAttempts
      // within a single call, so we can't get partial attempts from it.
      // Seed the checkpoint directly via the store to simulate intermediate states.
      const raw = {
        version: 1,
        issueNumber: 42,
        fingerprint: 'request-fingerprint',
        stage: 'publish',
        updatedAt: '2026-07-24T12:00:00.000Z',
        stages: {
          publish: {
            status: 'failed',
            attempts,
            updatedAt: '2026-07-24T12:00:00.000Z',
            ...(kind !== null
              ? { error: { kind, message: 'failed' } }
              : { error: { kind: null, message: 'transient' } }),
          },
        },
      };
      store.mem.set(ctrl.key, Buffer.from(`${JSON.stringify(raw)}\n`));
    }

    it('returns false and leaves the checkpoint untouched when stage has not failed', async () => {
      const store = makeStore();
      const wasReset = await resetExhaustedTransientStage(controller(store), 'publish');
      expect(wasReset).toBe(false);
      // No checkpoint was even written.
      const cp = await loadIssueCheckpoint(controller(store));
      expect(cp.stages['publish']).toBeUndefined();
    });

    it('returns false when stage succeeded (status completed)', async () => {
      const store = makeStore();
      await runCheckpointStage(controller(store), 'publish', schema, async () => ({ ok: true }));
      const wasReset = await resetExhaustedTransientStage(controller(store), 'publish');
      expect(wasReset).toBe(false);
      const cp = await loadIssueCheckpoint(controller(store));
      expect(cp.stages['publish']).toMatchObject({ status: 'completed' });
    });

    it('returns false when stage failed but attempts are below the ceiling', async () => {
      const store = makeStore();
      await seedPublishFailures(store, 2, null); // 2 < 3
      const wasReset = await resetExhaustedTransientStage(controller(store), 'publish');
      expect(wasReset).toBe(false);
      const cp = await loadIssueCheckpoint(controller(store));
      expect(cp.stages['publish']).toMatchObject({ status: 'failed', attempts: 2 });
    });

    it('returns false when publish is exhausted with a permanent error', async () => {
      const store = makeStore();
      await seedPublishFailures(store, 3, 'destination-conflict'); // permanent
      const wasReset = await resetExhaustedTransientStage(controller(store), 'publish');
      expect(wasReset).toBe(false);
      const cp = await loadIssueCheckpoint(controller(store));
      expect(cp.stages['publish']).toMatchObject({ status: 'failed', attempts: 3 });
    });

    it('returns false when publish is exhausted with null kind (null is not auto-resettable)', async () => {
      const store = makeStore();
      await seedPublishFailures(store, 3, null); // null kind is NOT in INFRA_RESETTABLE_KINDS
      const wasReset = await resetExhaustedTransientStage(controller(store), 'publish');
      expect(wasReset).toBe(false);
      const cp = await loadIssueCheckpoint(controller(store));
      expect(cp.stages['publish']).toMatchObject({ status: 'failed', attempts: 3 });
    });

    it('resets transient exhaustion with push-retries-exhausted kind', async () => {
      const store = makeStore();
      await seedPublishFailures(store, 3, 'push-retries-exhausted'); // explicit resettable kind
      const wasReset = await resetExhaustedTransientStage(controller(store), 'publish');
      expect(wasReset).toBe(true);
    });

    it('returns false for git-failed (too broad; covers auth/permission failures)', async () => {
      const store = makeStore();
      await seedPublishFailures(store, 3, 'git-failed'); // git-failed is NOT auto-resettable
      const wasReset = await resetExhaustedTransientStage(controller(store), 'publish');
      expect(wasReset).toBe(false);
    });

    it('does not disturb other completed stages when resetting publish', async () => {
      const store = makeStore();
      // Seed a checkpoint that has BOTH a completed generate stage and an
      // exhausted transient publish stage so isolation is genuinely tested.
      const ctrl = controller(store);
      const raw = {
        version: 1,
        issueNumber: 42,
        fingerprint: 'request-fingerprint',
        stage: 'publish',
        updatedAt: '2026-07-24T12:00:00.000Z',
        stages: {
          generate: {
            status: 'completed',
            attempts: 1,
            updatedAt: '2026-07-24T11:00:00.000Z',
            output: { runId: 'r1' },
          },
          publish: {
            status: 'failed',
            attempts: 3,
            updatedAt: '2026-07-24T12:00:00.000Z',
            error: { kind: 'push-retries-exhausted', message: 'push loop exhausted' },
          },
        },
      };
      store.mem.set(ctrl.key, Buffer.from(`${JSON.stringify(raw)}\n`));

      await resetExhaustedTransientStage(ctrl, 'publish');

      const cpAfter = await loadIssueCheckpoint(ctrl);
      expect(cpAfter.stages['generate']).toMatchObject({
        status: 'completed',
        output: { runId: 'r1' },
      });
      expect(cpAfter.stages['publish']).toBeUndefined();
    });

    it('allows runCheckpointStage to succeed after a transient-exhausted reset', async () => {
      const store = makeStore();
      await seedPublishFailures(store, 3, 'push-retries-exhausted');

      // Without reset, runCheckpointStage would throw "already exhausted".
      await expect(
        runCheckpointStage(controller(store), 'publish', schema, async () => ({ ok: true })),
      ).rejects.toThrow(/already exhausted/);

      // After reset, runCheckpointStage should succeed.
      await resetExhaustedTransientStage(controller(store), 'publish');
      const result = await runCheckpointStage(controller(store), 'publish', schema, async () => ({
        ok: true,
      }));
      expect(result).toEqual({ output: { ok: true }, resumed: false });
    });
  });

  describe('legacy pre-checkpoint status docs', () => {
    // Shape written by the retired pipeline before commit 49d133cea
    // introduced the v1 checkpoint schema — no `version`/`stages` at all.
    function legacyDoc(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        issueNumber: 42,
        fingerprint: 'request-fingerprint',
        stage: 'completed',
        updatedAt: '2026-06-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('reinitializes a legacy status doc (even stage:"completed") to a fresh v1 checkpoint instead of throwing', async () => {
      const store = makeStore();
      store.mem.set(controller(store).key, Buffer.from(`${JSON.stringify(legacyDoc())}\n`));

      const checkpoint = await loadIssueCheckpoint(controller(store));

      expect(checkpoint).toEqual({
        version: 1,
        issueNumber: 42,
        fingerprint: 'request-fingerprint',
        stage: 'queued',
        updatedAt: '2026-07-24T12:00:00.000Z',
        stages: {},
      });
    });

    it('runs a stage fresh (not resumed) over a legacy doc and durably overwrites it with a real v1 checkpoint', async () => {
      const store = makeStore();
      const key = controller(store).key;
      store.mem.set(key, Buffer.from(`${JSON.stringify(legacyDoc({ stage: 'synthesizing' }))}\n`));

      const operation = vi.fn(async () => ({ runId: 'run-1' }));
      const result = await runCheckpointStage(
        controller(store),
        'synthesize',
        z.object({ runId: z.string() }).strict(),
        operation,
      );

      expect(result).toEqual({ output: { runId: 'run-1' }, resumed: false });
      expect(operation).toHaveBeenCalledTimes(1);

      const persistedRaw = JSON.parse(store.mem.get(key)!.toString('utf8')) as Record<
        string,
        unknown
      >;
      expect(persistedRaw.version).toBe(1);
      expect(persistedRaw.stages).toMatchObject({
        synthesize: { status: 'completed', output: { runId: 'run-1' } },
      });
    });

    it('still throws checkpoint-invalid for a legacy doc belonging to a different issue number', async () => {
      const store = makeStore();
      store.mem.set(
        controller(store).key,
        Buffer.from(`${JSON.stringify(legacyDoc({ issueNumber: 999 }))}\n`),
      );

      await expect(loadIssueCheckpoint(controller(store))).rejects.toThrow(
        IssuePipelineCheckpointError,
      );
      await expect(loadIssueCheckpoint(controller(store))).rejects.toThrow(
        /belongs to a different issue request/,
      );
    });

    it('still throws checkpoint-invalid for a legacy doc belonging to a different fingerprint', async () => {
      const store = makeStore();
      store.mem.set(
        controller(store).key,
        Buffer.from(`${JSON.stringify(legacyDoc({ fingerprint: 'other-fingerprint' }))}\n`),
      );

      await expect(loadIssueCheckpoint(controller(store))).rejects.toThrow(
        /belongs to a different issue request/,
      );
    });

    it('still throws checkpoint-invalid for genuinely malformed current-schema JSON (missing stages, present version)', async () => {
      const store = makeStore();
      store.mem.set(
        controller(store).key,
        Buffer.from(
          `${JSON.stringify({
            version: 1,
            issueNumber: 42,
            fingerprint: 'request-fingerprint',
            stage: 'generate',
            updatedAt: '2026-07-01T00:00:00.000Z',
            // `stages` missing entirely — not a legacy shape (has `version`)
            // and not a valid v1 checkpoint either.
          })}\n`,
        ),
      );

      await expect(loadIssueCheckpoint(controller(store))).rejects.toThrow(
        IssuePipelineCheckpointError,
      );
      await expect(loadIssueCheckpoint(controller(store))).rejects.toThrow(/failed validation/);
    });

    it('still throws checkpoint-invalid for arbitrary garbage JSON', async () => {
      const store = makeStore();
      store.mem.set(controller(store).key, Buffer.from(`${JSON.stringify({ foo: 1 })}\n`));

      await expect(loadIssueCheckpoint(controller(store))).rejects.toThrow(
        IssuePipelineCheckpointError,
      );
    });
  });
});
