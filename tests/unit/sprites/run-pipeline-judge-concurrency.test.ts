/**
 * Unit tests for the bounded-concurrency + cap-override behaviour added to
 * `runJudgePass` (`run-pipeline.ts`) to speed the theme-equipment rejudge.
 *
 * The safety contract under test:
 *   1. `concurrency > 1` produces per-variant verdicts byte-identical to the
 *      sequential path (judge calls are independent, so order must not matter),
 *      including deterministic Map iteration order.
 *   2. A bounded worker pool never exceeds its limit, yet actually parallelises.
 *   3. `concurrency > 1` is rejected when a judge budget OR cache is supplied
 *      (both race across concurrent calls), and invalid concurrency /
 *      judgeMaxVariants values are rejected.
 *   4. `judgeMaxVariants` overrides the brief's own cap.
 *   5. On the first error the pool STOPS handing out work and drains — it does
 *      not start every remaining call before rejecting.
 *
 * The vision provider is CANDIDATE-KEYED (it derives each verdict from the
 * candidate image's bytes, not from call order) so a cross-variant
 * mis-association would change a per-index verdict and fail the equivalence
 * assertion.
 */

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { runJudgePass, type ProcessedVariant } from '../../../scripts/sprites/run-pipeline.js';
import type { Brief } from '../../../scripts/sprites/brief-schema.js';
import type { RunStore } from '../../../scripts/sprites/store/types.js';
import type {
  EvaluateRequest,
  EvaluateResponse,
  VisionProvider,
} from '../../../scripts/sprites/provider/vision-types.js';
import type { JudgeBudget } from '../../../scripts/sprites/cost-tracker.js';
import type { JudgeCache } from '../../../scripts/sprites/judge-cache.js';

const FIXED_NOW = (): Date => new Date('2020-01-01T00:00:00.000Z');

/** Azure-like store: judgeVariant skips the local sidecar write off-local. */
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

/** A 4×4 PNG whose top-left R channel encodes the variant index. */
function markerPng(index: number): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = index; // R encodes the index; nearest-neighbor upscale preserves it
    png.data[i + 1] = 190;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function variant(index: number, score: number): ProcessedVariant {
  return {
    index,
    score,
    outOf: 7,
    breakdown: [],
    passed: true,
    rawPath: `https://fake.blob/raw/${index}.png`,
    processedPath: `https://fake.blob/processed/${index}.png`,
    scorecardPath: `https://fake.blob/processed/${index}.scorecard.json`,
    derivedAnchor: null,
    derivedAnchors: { hold: null, centerOfGravity: null },
    anchorSidecarPath: null,
    centerOfGravitySidecarPath: null,
    anchorOverlayPath: `https://fake.blob/processed/${index}.anchor-overlay.png`,
    processed: markerPng(index),
  };
}

/** Decode the variant index a request is about from its candidate image. */
function indexOfRequest(req: EvaluateRequest): number {
  const candidate = req.images.find((img) => img.label === 'candidate');
  if (!candidate) throw new Error('request has no candidate image');
  return PNG.sync.read(candidate.png).data[0] ?? 0;
}

/** Vision provider whose verdict is a pure function of the candidate bytes. */
function candidateKeyedProvider(): VisionProvider {
  return {
    modelDeployment: 'mock-vision-deployment',
    async evaluate(req): Promise<EvaluateResponse> {
      const index = indexOfRequest(req);
      const s = 1 + (index % 5); // integer 1..5 (evaluatorPayloadSchema range)
      // The index is encoded in each rationale so a cross-variant
      // mis-association changes the stored scorecard even when scores collide.
      return {
        json: {
          style_match: { score: s, rationale: `style idx${index}` },
          brief_match: { score: s, rationale: `brief idx${index}` },
          readability: { score: s, rationale: `readability idx${index}` },
        },
        modelDeployment: 'mock-vision-deployment',
        usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
      };
    },
  };
}

function baseArgs(variants: ProcessedVariant[], provider: VisionProvider) {
  return {
    variants,
    judgeEnabled: true as const,
    brief: {
      name: 'iron-sword',
      type: 'weapon',
      prompt: 'An iron sword.',
      tags: [],
      references: [],
      judge: { enabled: true, maxVariants: 16 },
    } as unknown as Brief,
    referencePngs: [] as Buffer[],
    styleGuide: 'guide',
    visionProvider: provider,
    store: fakeStore(),
    storeKey: (rel: string) => `iron-sword/run/${rel}`,
    env: {},
    now: FIXED_NOW,
  };
}

describe('runJudgePass — bounded concurrency', () => {
  it('concurrency > 1 yields per-index verdicts identical to sequential', async () => {
    const variants = [0, 1, 2, 3, 4, 5].map((i) => variant(i, 7 - i));
    const seq = await runJudgePass({
      ...baseArgs(variants, candidateKeyedProvider()),
      judgeMaxVariants: 6,
      concurrency: 1,
    });
    const par = await runJudgePass({
      ...baseArgs(variants, candidateKeyedProvider()),
      judgeMaxVariants: 6,
      concurrency: 4,
    });
    // Deterministic Map iteration order (considered-variant order), not
    // parallel completion order.
    expect([...par.judgePlan.keys()]).toEqual([...seq.judgePlan.keys()]);
    for (const i of [0, 1, 2, 3, 4, 5]) {
      expect(par.judgePlan.get(i)).toEqual(seq.judgePlan.get(i));
      expect(par.judgeSkipReason.get(i)).toBe(seq.judgeSkipReason.get(i));
    }
  });

  it('never exceeds the concurrency limit but does run in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    const provider: VisionProvider = {
      modelDeployment: 'mock-vision-deployment',
      async evaluate(): Promise<EvaluateResponse> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return {
          json: {
            style_match: { score: 5, rationale: 's' },
            brief_match: { score: 5, rationale: 'b' },
            readability: { score: 5, rationale: 'r' },
          },
          modelDeployment: 'mock-vision-deployment',
          usage: null,
        };
      },
    };
    const variants = [0, 1, 2, 3, 4, 5].map((i) => variant(i, 7 - i));
    await runJudgePass({ ...baseArgs(variants, provider), judgeMaxVariants: 6, concurrency: 3 });
    expect(peak).toBe(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('judgeMaxVariants override caps eligibility (rest are over-cap)', async () => {
    const variants = [0, 1, 2, 3, 4, 5].map((i) => variant(i, 7 - i));
    // Cap 2 ⇒ only the two highest sensor scores (index 0 score 7, index 1
    // score 6) are judged; the rest are over-cap.
    const res = await runJudgePass({
      ...baseArgs(variants, candidateKeyedProvider()),
      judgeMaxVariants: 2,
      concurrency: 4,
    });
    expect(res.judgeSkipReason.get(0)).toBeNull();
    expect(res.judgeSkipReason.get(1)).toBeNull();
    for (const i of [2, 3, 4, 5]) {
      expect(res.judgeSkipReason.get(i)).toBe('over-cap');
      expect(res.judgePlan.get(i)).toBeNull();
    }
  });
});

describe('runJudgePass — concurrency guards', () => {
  it('rejects concurrency > 1 with a judge budget', async () => {
    const variants = [variant(0, 7)];
    await expect(
      runJudgePass({
        ...baseArgs(variants, candidateKeyedProvider()),
        concurrency: 2,
        judgeBudget: {} as unknown as JudgeBudget,
      }),
    ).rejects.toThrow(/incompatible with judgeBudget/);
  });

  it('rejects concurrency > 1 with a judge cache', async () => {
    const variants = [variant(0, 7)];
    await expect(
      runJudgePass({
        ...baseArgs(variants, candidateKeyedProvider()),
        concurrency: 2,
        judgeCache: {} as unknown as JudgeCache,
      }),
    ).rejects.toThrow(/incompatible with judgeBudget\/judgeCache/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid concurrency %s',
    async (bad) => {
      const variants = [variant(0, 7)];
      await expect(
        runJudgePass({ ...baseArgs(variants, candidateKeyedProvider()), concurrency: bad }),
      ).rejects.toThrow(/concurrency must be an integer/);
    },
  );

  it.each([0, 65, 1.5, Number.NaN])('rejects invalid judgeMaxVariants %s', async (bad) => {
    const variants = [variant(0, 7)];
    await expect(
      runJudgePass({ ...baseArgs(variants, candidateKeyedProvider()), judgeMaxVariants: bad }),
    ).rejects.toThrow(/judge cap must be an integer in 1\.\.64/);
  });
});

describe('runJudgePass — drain on error', () => {
  it('stops handing out work on the first error and rejects', async () => {
    // Two workers start together. The first call throws quickly; the second
    // call runs much longer and records a side effect on settlement. After
    // runJudgePass rejects, the side effect must already be present — this
    // distinguishes the real drain (Promise.all waits for every in-flight
    // worker to settle) from a Promise.race-style early-exit.
    const completions: number[] = [];
    let callOrder = 0;
    const provider: VisionProvider = {
      modelDeployment: 'mock-vision-deployment',
      async evaluate(): Promise<EvaluateResponse> {
        // callOrder++ is synchronous (no await before it), so call 0 is
        // always the one that started first.
        const myOrder = callOrder++;
        if (myOrder === 0) {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error('boom');
        }
        // Long-running in-flight call: completes well after the first error.
        await new Promise((r) => setTimeout(r, 80));
        completions.push(myOrder);
        throw new Error('long-boom');
      },
    };
    const variants = [0, 1, 2, 3, 4, 5].map((i) => variant(i, 7 - i));
    await expect(
      runJudgePass({ ...baseArgs(variants, provider), judgeMaxVariants: 6, concurrency: 2 }),
    ).rejects.toThrow('boom');
    // The in-flight long call settled (recorded its completion) before
    // runJudgePass threw — this is the drain-before-throw guarantee.
    expect(completions).toContain(1);
    // No new work was dispatched after the abort (≤ 2 calls total).
    expect(callOrder).toBeLessThanOrEqual(2);
  });
});
