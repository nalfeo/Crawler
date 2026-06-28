/**
 * Unit tests for the shared per-variant pipeline (`run-pipeline.ts`).
 *
 * Focus: the JUDGE GATING that both `generateOne` and the re-run endpoints
 * rely on (`runJudgePass`) and the sensor+judge fold (`assembleSummaryEntries`).
 * The eligible variants are judged with a mock vision provider; we assert on
 * the returned plan/skip maps and the number of provider calls, so the gating
 * decisions are pinned independently of the judge's scoring internals.
 */

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  assembleSummaryEntries,
  runJudgePass,
  type ProcessedVariant,
} from '../../../scripts/sprites/run-pipeline.js';
import type { JudgeScorecard } from '../../../scripts/sprites/judge.js';
import type { JudgeSkipReason } from '../../../scripts/sprites/run-artifacts.js';
import type { Brief } from '../../../scripts/sprites/brief-schema.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import { mockVisionProvider, scorecard } from '../../fixtures/sprites/seed-run.js';

/** Minimal azure-like store: judgeVariant skips the local sidecar write off-local. */
function fakeStore(): RunStore {
  const mem = new Map<string, Buffer>();
  return {
    backend: 'azure-blob',
    put: async (key, data) => void mem.set(key, data),
    get: async (key) => mem.get(key) ?? Buffer.alloc(0),
    has: async (key) => mem.has(key),
    list: async (prefix) => [...mem.keys()].filter((k) => k.startsWith(prefix)),
    remove: async (key) => void mem.delete(key),
    resolve: (key) => `https://fake.blob/${key}`,
  };
}

/** A tiny solid PNG — these gating tests only need a decodable buffer, not real art. */
function tinyPng(): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 180;
    png.data[i + 1] = 190;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const PROCESSED = tinyPng();

function variant(index: number, passed: boolean, score: number): ProcessedVariant {
  return {
    index,
    score,
    outOf: 7,
    breakdown: [],
    passed,
    rawPath: `https://fake.blob/raw/${index}.png`,
    processedPath: `https://fake.blob/processed/${index}.png`,
    scorecardPath: `https://fake.blob/processed/${index}.scorecard.json`,
    derivedAnchor: null,
    derivedAnchors: { hold: null, centerOfGravity: null },
    anchorSidecarPath: null,
    centerOfGravitySidecarPath: null,
    anchorOverlayPath: `https://fake.blob/processed/${index}.anchor-overlay.png`,
    processed: PROCESSED,
  };
}

/** Brief stub carrying the fields the judge reads plus the cap the gating uses. */
function briefWithCap(maxVariants: number): Brief {
  return {
    name: 'iron-sword',
    type: 'weapon',
    prompt: 'An iron sword.',
    tags: [],
    references: [],
    judge: { enabled: true, maxVariants },
  } as unknown as Brief;
}

function judgeArgs(
  variants: ProcessedVariant[],
  responses: ReturnType<typeof scorecard>[],
  maxVariants = 16,
) {
  const { provider, calls } = mockVisionProvider(responses);
  return {
    calls,
    args: {
      variants,
      judgeEnabled: true,
      brief: briefWithCap(maxVariants),
      referencePngs: [tinyPng()],
      styleGuide: 'guide',
      visionProvider: provider,
      store: fakeStore(),
      storeKey: (rel: string) => `iron-sword/run/${rel}`,
      env: {},
    },
  };
}

describe('runJudgePass — gating', () => {
  it('judge-disabled: every considered variant is skipped, no provider calls', async () => {
    const { provider, calls } = mockVisionProvider([]);
    const variants = [variant(0, true, 7), variant(1, true, 6)];
    const res = await runJudgePass({
      variants,
      judgeEnabled: false,
      brief: briefWithCap(16),
      referencePngs: [],
      styleGuide: 'guide',
      visionProvider: provider,
      store: fakeStore(),
      storeKey: (rel) => rel,
      env: {},
    });
    expect(calls).toHaveLength(0);
    expect([...res.judgeSkipReason.values()]).toEqual(['judge-disabled', 'judge-disabled']);
    expect([...res.judgePlan.values()]).toEqual([null, null]);
  });

  it('sensor-failed variants are still judge-eligible by default', async () => {
    const variants = [variant(0, true, 7), variant(1, false, 3)];
    const { calls, args } = judgeArgs(variants, [
      scorecard({ style: 5, brief: 5, readability: 5 }),
      scorecard({ style: 4, brief: 4, readability: 4 }),
    ]);
    const res = await runJudgePass(args);
    expect(calls).toHaveLength(2);
    expect(res.judgeSkipReason.get(1)).toBeNull();
    expect(res.judgePlan.get(1)).not.toBeNull();
    expect(res.judgePlan.get(0)).not.toBeNull();
    expect(res.judgeSkipReason.get(0)).toBeNull();
  });

  it('over-cap: only the top-`maxVariants` by sensor score are judged', async () => {
    const variants = [variant(0, true, 5), variant(1, true, 7), variant(2, true, 6)];
    // maxVariants=1 ⇒ only the highest sensor score (index 1) is judged.
    const { calls, args } = judgeArgs(
      variants,
      [scorecard({ style: 5, brief: 5, readability: 5 })],
      1,
    );
    const res = await runJudgePass(args);
    expect(calls).toHaveLength(1);
    expect(res.judgePlan.get(1)).not.toBeNull();
    expect(res.judgeSkipReason.get(1)).toBeNull();
    expect(res.judgeSkipReason.get(0)).toBe('over-cap');
    expect(res.judgeSkipReason.get(2)).toBe('over-cap');
  });

  it('variantIndexes: only the named variants get plan/skip entries', async () => {
    const variants = [variant(0, true, 7), variant(1, true, 6), variant(2, true, 5)];
    const { calls, args } = judgeArgs(variants, [
      scorecard({ style: 5, brief: 5, readability: 5 }),
    ]);
    const res = await runJudgePass({ ...args, variantIndexes: new Set([1]) });
    expect(calls).toHaveLength(1);
    expect(res.judgePlan.has(0)).toBe(false);
    expect(res.judgePlan.has(2)).toBe(false);
    expect(res.judgePlan.get(1)).not.toBeNull();
  });
});

describe('assembleSummaryEntries — combinedPassed', () => {
  const pass: JudgeScorecard = { passed: true } as unknown as JudgeScorecard;
  const fail: JudgeScorecard = { passed: false } as unknown as JudgeScorecard;

  it('judge disabled ⇒ combinedPassed mirrors sensors.passed', () => {
    const variants = [variant(0, true, 7), variant(1, false, 3)];
    const entries = assembleSummaryEntries({
      variants,
      judgePlan: new Map(),
      judgeSkipReason: new Map<number, JudgeSkipReason | null>([
        [0, 'judge-disabled'],
        [1, 'judge-disabled'],
      ]),
      judgeEnabled: false,
    });
    expect(entries[0]!.combinedPassed).toBe(true);
    expect(entries[1]!.combinedPassed).toBe(false);
  });

  it('judge enabled ⇒ requires BOTH sensors and a passing judge verdict', () => {
    const variants = [variant(0, true, 7), variant(1, true, 6), variant(2, false, 3)];
    const entries = assembleSummaryEntries({
      variants,
      judgePlan: new Map<number, JudgeScorecard | null>([
        [0, pass],
        [1, fail],
        [2, null],
      ]),
      judgeSkipReason: new Map<number, JudgeSkipReason | null>([
        [0, null],
        [1, null],
        [2, null],
      ]),
      judgeEnabled: true,
    });
    expect(entries[0]!.combinedPassed).toBe(true); // sensors pass + judge pass
    expect(entries[1]!.combinedPassed).toBe(false); // sensors pass + judge fail
    expect(entries[2]!.combinedPassed).toBe(false); // sensors fail
  });

  it('judge enabled but a sensor-passer has no verdict ⇒ combinedPassed false', () => {
    const variants = [variant(0, true, 7)];
    const entries = assembleSummaryEntries({
      variants,
      judgePlan: new Map<number, JudgeScorecard | null>([[0, null]]),
      judgeSkipReason: new Map<number, JudgeSkipReason | null>([[0, 'over-cap']]),
      judgeEnabled: true,
    });
    expect(entries[0]!.combinedPassed).toBe(false);
  });
});
