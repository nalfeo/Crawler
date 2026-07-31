/**
 * Wiring test: `rejudgeRun` (`rerun.ts`) must forward the speedup knobs
 * (`judgeMaxVariants`, `concurrency`) into `runJudgePass` verbatim. Unit-testing
 * `runJudgePass` alone proves the engine; this proves the RejudgeArgs → JudgePassArgs
 * hand-off the theme-equipment rejudge relies on.
 *
 * `runJudgePass` is mocked to RECORD its args then throw a sentinel, so the test
 * needs no real judge calls, no summary write, and no Azure. It lives in its own
 * file because the module mock would otherwise clobber the direct `runJudgePass`
 * tests in `run-pipeline-judge-concurrency.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import type { RunSummary } from '../../../scripts/sprites/run-artifacts.js';
import type { Brief } from '../../../scripts/sprites/brief-schema.js';
import type { VisionProvider } from '../../../scripts/sprites/provider/vision-types.js';

const hoisted = vi.hoisted(() => ({ captured: { value: undefined as unknown } }));

vi.mock('../../../scripts/sprites/run-pipeline.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../scripts/sprites/run-pipeline.js')>();
  return {
    ...actual,
    runJudgePass: (args: unknown) => {
      hoisted.captured.value = args;
      throw new Error('__wiring_sentinel__');
    },
  };
});

// Imported AFTER the mock is registered so `rejudgeRun` binds the mocked
// `runJudgePass`.
const { rejudgeRun } = await import('../../../scripts/sprites/rerun.js');

function tinyPng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function fakeStore(): RunStore {
  const png = tinyPng();
  return {
    backend: 'azure-blob',
    put: async () => {},
    get: async () => png,
    has: async () => true,
    list: async () => [],
    remove: async () => {},
    resolve: (key) => `https://fake.blob/${key}`,
  };
}

/** Two candidate entries — only `.index` is read before `runJudgePass`. */
function summaryWith2Candidates(): RunSummary {
  return {
    candidates: [{ index: 0 }, { index: 1 }],
  } as unknown as RunSummary;
}

const provider: VisionProvider = {
  modelDeployment: 'mock-vision-deployment',
  evaluate: async () => {
    throw new Error('provider should not be called (runJudgePass is mocked)');
  },
};

function baseArgs() {
  return {
    store: fakeStore(),
    briefId: 'iron-sword',
    runId: 'run-1',
    summary: summaryWith2Candidates(),
    brief: { judge: { enabled: true, maxVariants: 16 } } as unknown as Brief,
    referencePngs: [] as Buffer[],
    styleGuide: 'guide',
    visionProvider: provider,
  };
}

describe('rejudgeRun forwards speedup knobs to runJudgePass', () => {
  it('threads judgeMaxVariants and concurrency verbatim', async () => {
    await expect(
      rejudgeRun({ ...baseArgs(), judgeMaxVariants: 6, concurrency: 4 }),
    ).rejects.toThrow('__wiring_sentinel__');
    const forwarded = hoisted.captured.value as { judgeMaxVariants?: number; concurrency?: number };
    expect(forwarded.judgeMaxVariants).toBe(6);
    expect(forwarded.concurrency).toBe(4);
  });

  it('omits both knobs when not supplied (conditional spread)', async () => {
    hoisted.captured.value = undefined;
    await expect(rejudgeRun(baseArgs())).rejects.toThrow('__wiring_sentinel__');
    const forwarded = hoisted.captured.value as Record<string, unknown>;
    expect('judgeMaxVariants' in forwarded).toBe(false);
    expect('concurrency' in forwarded).toBe(false);
  });
});
