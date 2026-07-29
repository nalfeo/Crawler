/**
 * Unit tests for the VLM judge (spec §F4).
 *
 * Coverage:
 *   - CI refusal (Constitutional §3): explicit env injection so the
 *     real `process.env.CI` isn't required.
 *   - Happy path: all three evaluators score 5 → `passed: true`.
 *   - Threshold rejection: any score < 3 → `passed: false` with the
 *     failing evaluator surfaced in `rejectedBy`.
 *   - Malformed provider response: extra/missing fields surface as
 *     `JudgeError('malformed')`.
 *   - Provider errors propagate through unchanged.
 *   - One vision call per judge invocation (cost discipline).
 *   - Artifact written to `processed/NN.judge.json` when `processedDir`
 *     is supplied; not written otherwise.
 *   - Images include the labelled candidate, readability composite, and
 *     references (capped at 3).
 *
 * The judge is provider-agnostic; we stub `VisionProvider` directly so
 * tests run without any HTTP machinery.
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { briefSchema, type Brief } from '../../../scripts/sprites/brief-schema.js';
import { JudgeCache } from '../../../scripts/sprites/judge-cache.js';
import {
  JUDGE_HARD_BLOCK_PHRASE,
  judgeVariant,
  JudgeError,
} from '../../../scripts/sprites/judge.js';
import {
  VisionProviderError,
  type EvaluateRequest,
  type EvaluateResponse,
  type VisionProvider,
} from '../../../scripts/sprites/provider/vision-types.js';

function makeBrief(overrides: Partial<Brief> = {}): Brief {
  return briefSchema.parse({
    type: 'weapon',
    name: 'judge-sword',
    size: { width: 16, height: 16 },
    palette: { id: 'kenney-roguelike' },
    anchor: { x: 8, y: 14 },
    tags: ['blade'],
    prompt: 'A vertical iron sword on a transparent background.',
    references: [{ path: 'docs/refs/sword-1.png' }, { path: 'docs/refs/sword-2.png' }],
    generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
    judge: { enabled: true, maxVariants: 16 },
    ...overrides,
  });
}

/** Build a tiny 16x16 PNG with a diagonal stripe so it's not all transparent. */
function makeTinyPng(): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const idx = (y * 16 + x) * 4;
      const onStripe = Math.abs(x - y) <= 1;
      png.data[idx] = onStripe ? 192 : 0;
      png.data[idx + 1] = onStripe ? 192 : 0;
      png.data[idx + 2] = onStripe ? 200 : 0;
      png.data[idx + 3] = onStripe ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function makeRefPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 100;
    png.data[i + 1] = 100;
    png.data[i + 2] = 100;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

interface StubArgs {
  readonly responseJson: unknown;
  readonly modelDeployment?: string;
  readonly usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

interface CapturedCall {
  readonly request: EvaluateRequest;
}

function stubProvider(args: StubArgs): { provider: VisionProvider; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const provider: VisionProvider = {
    modelDeployment: args.modelDeployment ?? 'gpt-4o-vision',
    evaluate: async (request: EvaluateRequest): Promise<EvaluateResponse> => {
      calls.push({ request });
      return {
        json: args.responseJson,
        usage: args.usage === undefined ? null : args.usage,
        modelDeployment: args.modelDeployment ?? 'gpt-4o-vision',
      };
    },
  };
  return { provider, calls };
}

function throwingProvider(err: unknown): VisionProvider {
  return {
    modelDeployment: 'gpt-4o-vision',
    evaluate: async () => {
      throw err;
    },
  };
}

function responseShape(systemInstructions: string): unknown {
  const marker = 'matching this shape:\n';
  const start = systemInstructions.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(systemInstructions.slice(start + marker.length));
}

const FIXED_NOW = () => new Date('2026-06-05T14:30:00Z');

describe('judgeVariant — Constitutional §3 CI guard', () => {
  it('refuses to run when CI=1 with a clear, citation-bearing error', async () => {
    const { provider, calls } = stubProvider({ responseJson: {} });
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [makeRefPng()],
        brief: makeBrief(),
        styleGuide: 'style',
        provider,
        variantIndex: 0,
        env: { CI: '1' },
      }),
    ).rejects.toMatchObject({
      name: 'JudgeError',
      kind: 'ci-refused',
    });
    // Provider must never be called when CI guard trips.
    expect(calls).toHaveLength(0);
    // Error text cites §3 and the ADR escape hatch so the human knows why.
    try {
      await judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: { CI: '1' },
      });
    } catch (err) {
      expect((err as Error).message).toContain('§3');
      expect((err as Error).message).toContain('ADR');
    }
  });

  it('refuses on ANY CI value, not just truthy strings', async () => {
    const { provider } = stubProvider({ responseJson: {} });
    // `false`, `0`, `''` all still trip — CI being *defined* is the signal.
    for (const value of ['false', '0', '']) {
      await expect(
        judgeVariant({
          processed: makeTinyPng(),
          referencePngs: [],
          brief: makeBrief(),
          styleGuide: '',
          provider,
          variantIndex: 0,
          env: { CI: value },
        }),
      ).rejects.toMatchObject({ kind: 'ci-refused' });
    }
  });

  it('runs when CI is undefined in the injected env', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'a' },
        brief_match: { score: 5, rationale: 'b' },
        readability: { score: 5, rationale: 'c' },
      },
    });
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: {},
        now: FIXED_NOW,
      }),
    ).resolves.toMatchObject({ passed: true });
  });

  it('runs in CI when the ADR-0043 pipeline bypass is set', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'a' },
        brief_match: { score: 5, rationale: 'b' },
        readability: { score: 5, rationale: 'c' },
      },
    });
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: { CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'true' },
        now: FIXED_NOW,
      }),
    ).resolves.toMatchObject({ passed: true });
    expect(calls).toHaveLength(1);
  });

  it('still refuses in CI when the bypass flag is anything other than an accepted opt-in', async () => {
    const { provider, calls } = stubProvider({ responseJson: {} });
    for (const val of ['', 'false', '0', 'no', 'garbage']) {
      await expect(
        judgeVariant({
          processed: makeTinyPng(),
          referencePngs: [],
          brief: makeBrief(),
          styleGuide: '',
          provider,
          variantIndex: 0,
          env: { CI: '1', SPRITES_ALLOW_CI_PIPELINE: val },
        }),
      ).rejects.toMatchObject({ kind: 'ci-refused' });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('judgeVariant — happy path', () => {
  it('scores design language separately from reference rendering style', async () => {
    const { provider } = stubProvider({
      responseJson: {
        design_language: { score: 5, rationale: 'unmistakably Crawler' },
        reference_style_match: { score: 4, rationale: 'matches rendering finish' },
        brief_match: { score: 4, rationale: 'on target' },
        readability: { score: 5, rationale: 'silhouette pops' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [makeRefPng()],
      brief: makeBrief(),
      styleGuide: 'style',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    expect(scorecard.designLanguage?.score).toBe(5);
    expect(scorecard.referenceStyleMatch?.score).toBe(4);
    expect(scorecard.styleMatch.score).toBe(4);
    expect(scorecard.minScore).toBe(4);
  });

  it('returns passed=true when every evaluator scores >= 3', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'looks identical' },
        brief_match: { score: 4, rationale: 'on target' },
        readability: { score: 5, rationale: 'silhouette pops' },
      },
      modelDeployment: 'gpt-4o-judge-test',
      usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [makeRefPng(), makeRefPng()],
      brief: makeBrief(),
      styleGuide: 'pixel art style guide content',
      provider,
      variantIndex: 3,
      now: FIXED_NOW,
      env: {},
    });

    expect(scorecard.passed).toBe(true);
    expect(scorecard.rejectedBy).toEqual([]);
    expect(scorecard.minScore).toBe(4);
    expect(scorecard.styleMatch).toEqual({ score: 5, rationale: 'looks identical' });
    expect(scorecard.briefMatch).toEqual({ score: 4, rationale: 'on target' });
    expect(scorecard.readability).toEqual({ score: 5, rationale: 'silhouette pops' });
    expect(scorecard.variantIndex).toBe(3);
    expect(scorecard.modelDeployment).toBe('gpt-4o-judge-test');
    expect(scorecard.judgedAt).toBe('2026-06-05T14:30:00.000Z');
    expect(scorecard.usage).toEqual({
      promptTokens: 1500,
      completionTokens: 80,
      totalTokens: 1580,
    });

    // Cost discipline: one vision call per variant.
    expect(calls).toHaveLength(1);

    // Request shape — labels present so the model can disambiguate.
    const call = calls[0]!;
    const labels = call.request.images.map((i) => i.label);
    expect(labels).toEqual(['candidate', 'readability-composite', 'reference-1', 'reference-2']);
    // User prompt must mention the brief prompt verbatim so brief_match
    // is grounded in the actual brief, not the model's prior.
    expect(call.request.userPrompt).toContain('A vertical iron sword');
    // System prompt must include the 1-5 scale and the rejection threshold.
    expect(call.request.systemInstructions).toContain('1-5');
    expect(call.request.systemInstructions).toContain('below 3');
    expect(call.request.systemInstructions).toContain('transparency holes');
    expect(call.request.systemInstructions).toContain('disconnected/floating pixel islands');
    // System prompt must embed the (truncated) style guide.
    expect(call.request.systemInstructions).toContain('pixel art style guide content');
  });

  it('accepts the hard-block response contract and surfaces the exact phrase', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        confidence: 0.91,
        hard_block: {
          blocked: true,
          instruction: JUDGE_HARD_BLOCK_PHRASE,
          rationale: 'The sheet is fundamentally unusable at game scale.',
        },
        design_language: { score: 5, rationale: 'crawler specific' },
        reference_style_match: { score: 5, rationale: 'matches finish' },
        brief_match: { score: 5, rationale: 'matches brief' },
        readability: { score: 5, rationale: 'reads cleanly' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [makeRefPng()],
      brief: makeBrief(),
      styleGuide: 'pixel art style guide content',
      provider,
      variantIndex: 1,
      now: FIXED_NOW,
      env: {},
    });

    expect(scorecard.passed).toBe(false);
    expect(scorecard.hardBlockEvaluated).toBe(true);
    expect(scorecard.hardBlocked).toBe(true);
    expect(scorecard.hardBlockInstruction).toBe(JUDGE_HARD_BLOCK_PHRASE);
    expect(scorecard.hardBlockRationale).toBe('The sheet is fundamentally unusable at game scale.');
    expect(scorecard.confidence).toBe(0.91);
    expect(calls[0]?.request.systemInstructions).toContain(JUDGE_HARD_BLOCK_PHRASE);
    expect(responseShape(calls[0]!.request.systemInstructions)).toMatchObject({
      confidence: 0.85,
      hard_block: { blocked: false, instruction: null, rationale: '...' },
    });
  });

  it('accepts a non-blocked response with a null hard_block.rationale (live judge output)', async () => {
    // Regression: the vision judge legitimately returns rationale=null when
    // nothing is blocked. The schema previously required a non-null string,
    // which failed the whole paid run mid-flight (Actions run 30339239243).
    const { provider } = stubProvider({
      responseJson: {
        confidence: 0.9,
        hard_block: { blocked: false, instruction: null, rationale: null },
        design_language: { score: 4, rationale: 'consistent' },
        reference_style_match: { score: 4, rationale: 'matches finish' },
        brief_match: { score: 4, rationale: 'matches brief' },
        readability: { score: 4, rationale: 'reads cleanly' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [makeRefPng()],
      brief: makeBrief(),
      styleGuide: 'pixel art style guide content',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });

    expect(scorecard.passed).toBe(true);
    expect(scorecard.hardBlockEvaluated).toBe(true);
    expect(scorecard.hardBlocked).toBe(false);
    expect(scorecard.hardBlockInstruction).toBeNull();
    expect(scorecard.hardBlockRationale).toBeNull();
  });

  it('caps references at 3 to control cost', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        style_match: { score: 4, rationale: 'x' },
        brief_match: { score: 4, rationale: 'y' },
        readability: { score: 4, rationale: 'z' },
      },
    });
    await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [makeRefPng(), makeRefPng(), makeRefPng(), makeRefPng(), makeRefPng()],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    const labels = calls[0]!.request.images.map((i) => i.label);
    // candidate + composite + 3 refs = 5 total, NOT 7.
    expect(labels).toEqual([
      'candidate',
      'readability-composite',
      'reference-1',
      'reference-2',
      'reference-3',
    ]);
  });

  it('includes Floor 2 and family direction in the design-language rubric', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 5, rationale: 'family fit' },
        reference_style_match: { score: 5, rationale: 'style fit' },
        brief_match: { score: 5, rationale: 'brief fit' },
        readability: { score: 5, rationale: 'readable' },
        pose_orientation: { score: 5, rationale: 'camera-facing turn' },
        theme_adherence: { score: 5, rationale: 'goblin cartel details visible' },
      },
    });

    await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [makeRefPng()],
      brief: makeBrief({ type: 'enemy', name: 'goblin-grunt', floor: 2 }),
      styleGuide: 'pixel art style guide content',
      provider,
      variantIndex: 0,
      env: {},
      now: FIXED_NOW,
    });

    expect(calls[0]?.request.systemInstructions).toContain('Family Matters');
    expect(calls[0]?.request.systemInstructions).toContain('The Snaggle Cartel');
  });

  it('requires and scores camera-facing pose orientation for enemies', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 5, rationale: 'specific' },
        reference_style_match: { score: 5, rationale: 'on style' },
        brief_match: { score: 5, rationale: 'matches' },
        readability: { score: 5, rationale: 'readable' },
        pose_orientation: { score: 2, rationale: 'full side profile' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({ type: 'enemy', name: 'camera-facing-mob' }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      env: {},
    });
    expect(calls[0]?.request.systemInstructions).toContain('pose_orientation');
    expect(scorecard.poseOrientation).toEqual({ score: 2, rationale: 'full side profile' });
    expect(scorecard.rejectedBy).toContain('pose_orientation');
  });

  it('skips pose_orientation for enemies with facing: front', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 5, rationale: 'specific' },
        reference_style_match: { score: 5, rationale: 'on style' },
        brief_match: { score: 5, rationale: 'matches' },
        readability: { score: 5, rationale: 'readable' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({
        type: 'enemy',
        name: 'front-facing-boss',
        sensors: { enemy: { facing: 'front', toleranceDeg: 20 } },
      }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      env: {},
    });
    expect(calls[0]?.request.systemInstructions).not.toContain('pose_orientation');
    expect(scorecard.poseOrientation).toBeUndefined();
    expect(scorecard.rejectedBy).not.toContain('pose_orientation');
  });

  it('requires boss presence in addition to enemy pose orientation', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 5, rationale: 'specific' },
        reference_style_match: { score: 5, rationale: 'on style' },
        brief_match: { score: 5, rationale: 'matches' },
        readability: { score: 5, rationale: 'readable' },
        pose_orientation: { score: 5, rationale: 'camera-facing turn' },
        boss_presence: { score: 2, rationale: 'ordinary mob scale' },
        theme_adherence: { score: 5, rationale: 'cartel details visible' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({ type: 'enemy', name: 'goblin-boss', floor: 2, mobRole: 'boss' }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      env: {},
    });
    expect(calls[0]?.request.systemInstructions).toContain('boss_presence');
    expect(scorecard.bossPresence).toEqual({ score: 2, rationale: 'ordinary mob scale' });
    expect(scorecard.rejectedBy).toContain('boss_presence');
    const axes = [
      ...(calls[0]?.request.systemInstructions.matchAll(/^ {2}(\d+)\. ([a-z_]+)/gm) ?? []),
    ].map((match) => `${match[1]}:${match[2]}`);
    expect(axes).toEqual([
      '1:design_language',
      '2:reference_style_match',
      '3:brief_match',
      '4:readability',
      '5:pose_orientation',
      '6:boss_presence',
      '7:theme_adherence',
    ]);
    expect(responseShape(calls[0]!.request.systemInstructions)).toMatchObject({
      boss_presence: { score: 3 },
      theme_adherence: { score: 3 },
    });
  });

  it.each(['equipment', 'item', 'prop'] as const)(
    'requires family presentation for %s briefs',
    async (type) => {
      const { provider, calls } = stubProvider({
        responseJson: {
          design_language: { score: 5, rationale: 'specific' },
          reference_style_match: { score: 5, rationale: 'on style' },
          brief_match: { score: 5, rationale: 'matches' },
          readability: { score: 5, rationale: 'readable' },
          presentation: { score: 5, rationale: `${type} presentation is correct` },
        },
      });
      const scorecard = await judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief({ type, name: `${type}-subject` }),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: {},
      });
      expect(calls[0]?.request.systemInstructions).toContain('presentation');
      expect(scorecard.presentation?.score).toBe(5);
    },
  );

  it('requests a fifth theme_adherence axis when a floor or theme addendum applies (goblin-grunt has both)', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 4, rationale: 'a' },
        reference_style_match: { score: 4, rationale: 'b' },
        brief_match: { score: 4, rationale: 'c' },
        readability: { score: 4, rationale: 'd' },
        pose_orientation: { score: 4, rationale: 'camera-facing turn' },
        theme_adherence: { score: 5, rationale: 'cartel details visible' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({ type: 'enemy', name: 'goblin-grunt', floor: 2 }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });

    expect(calls[0]?.request.systemInstructions).toContain('6 independent 1-5 ordinal axes');
    expect(calls[0]?.request.systemInstructions).toContain('theme_adherence');
    expect(calls[0]?.request.userPrompt).toContain('Return your 6 scores');
    expect(scorecard.themeAdherence).toEqual({ score: 5, rationale: 'cartel details visible' });
  });

  it('requests a fifth theme_adherence axis for a floor-only addendum (cave-slime has no family theme)', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 4, rationale: 'a' },
        reference_style_match: { score: 4, rationale: 'b' },
        brief_match: { score: 4, rationale: 'c' },
        readability: { score: 4, rationale: 'd' },
        pose_orientation: { score: 4, rationale: 'camera-facing turn' },
        theme_adherence: { score: 4, rationale: 'floor Family Matters vibe present' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({ type: 'enemy', name: 'cave-slime', floor: 2 }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });

    expect(calls[0]?.request.systemInstructions).toContain('6 independent 1-5 ordinal axes');
    expect(calls[0]?.request.systemInstructions).toContain('theme_adherence');
    expect(calls[0]?.request.userPrompt).toContain('Return your 6 scores');
    expect(scorecard.passed).toBe(true);
    expect(scorecard.themeAdherence).toEqual({
      score: 4,
      rationale: 'floor Family Matters vibe present',
    });
  });

  it('requests theme_adherence for an authored floor 1 equipment theme', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 4, rationale: 'a' },
        reference_style_match: { score: 4, rationale: 'b' },
        brief_match: { score: 4, rationale: 'c' },
        readability: { score: 4, rationale: 'd' },
        presentation: { score: 4, rationale: 'isolated equipment icon' },
        theme_adherence: { score: 5, rationale: 'materials and heraldry match' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({
        type: 'equipment',
        name: 'classic-fantasy-helm',
        theme: {
          setId: 'classic-fantasy',
          displayName: 'Classic Fantasy',
          designLanguage:
            'Practical late-medieval steel, leather, wool, and carved hardwood with restrained heraldry.',
        },
      }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });

    expect(calls[0]?.request.systemInstructions).toContain('Practical late-medieval steel');
    expect(calls[0]?.request.systemInstructions).toContain('theme_adherence');
    expect(scorecard.themeAdherence?.score).toBe(5);
  });

  it('does not request theme_adherence and leaves it undefined when no theme addendum applies', async () => {
    const { provider, calls } = stubProvider({
      responseJson: {
        design_language: { score: 4, rationale: 'a' },
        reference_style_match: { score: 4, rationale: 'b' },
        brief_match: { score: 4, rationale: 'c' },
        readability: { score: 4, rationale: 'd' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });

    expect(calls[0]?.request.systemInstructions).toContain('four independent 1-5 ordinal axes');
    expect(calls[0]?.request.systemInstructions).not.toContain('theme_adherence');
    expect(calls[0]?.request.userPrompt).toContain('Return your four scores');
    expect(scorecard.themeAdherence).toBeUndefined();
    expect(responseShape(calls[0]!.request.systemInstructions)).toMatchObject({
      readability: { score: 3 },
    });
  });

  it('writes a `NN.judge.json` artifact when processedDir is supplied', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 4, rationale: 'a' },
        brief_match: { score: 4, rationale: 'b' },
        readability: { score: 4, rationale: 'c' },
      },
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'judge-test-'));
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 7,
      processedDir: dir,
      now: FIXED_NOW,
      env: {},
    });
    const artifactPath = path.join(dir, '07.judge.json');
    expect(existsSync(artifactPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    expect(onDisk).toEqual(scorecard);

    // The sensor scorecard MUST NOT be touched.
    const sensorPath = path.join(dir, '07.scorecard.json');
    expect(existsSync(sensorPath)).toBe(false);
  });

  it('does NOT write an artifact when processedDir is omitted', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'a' },
        brief_match: { score: 5, rationale: 'b' },
        readability: { score: 5, rationale: 'c' },
      },
    });
    // No `processedDir` => pure return-only.
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    expect(scorecard.passed).toBe(true);
  });
});

describe('judgeVariant - cache key includes conditional rubric contract', () => {
  it('does not reuse non-boss cached verdict for boss brief with identical pixels', async () => {
    const cache = new JudgeCache({ cacheDir: mkdtempSync(path.join(tmpdir(), 'judge-cache-')) });
    let calls = 0;
    const provider: VisionProvider = {
      modelDeployment: 'gpt-4o-vision',
      evaluate: async (request) => {
        calls += 1;
        const boss = request.systemInstructions.includes('boss_presence');
        return {
          modelDeployment: 'gpt-4o-vision',
          usage: null,
          json: boss
            ? {
                design_language: { score: 5, rationale: 'crawler' },
                reference_style_match: { score: 5, rationale: 'style' },
                brief_match: { score: 5, rationale: 'boss brief' },
                readability: { score: 5, rationale: 'clear' },
                pose_orientation: { score: 5, rationale: 'forward' },
                boss_presence: { score: 5, rationale: 'dominant' },
              }
            : {
                design_language: { score: 5, rationale: 'crawler' },
                reference_style_match: { score: 5, rationale: 'style' },
                brief_match: { score: 5, rationale: 'normal brief' },
                readability: { score: 5, rationale: 'clear' },
                pose_orientation: { score: 5, rationale: 'forward' },
              },
        };
      },
    };

    const processed = makeTinyPng();
    const refs = [makeRefPng()];
    const normal = await judgeVariant({
      processed,
      referencePngs: refs,
      brief: makeBrief({ type: 'enemy', mobRole: 'normal', prompt: 'A normal dungeon rat enemy.' }),
      styleGuide: 'style',
      provider,
      variantIndex: 0,
      cache,
      now: FIXED_NOW,
      env: {},
    });
    const boss = await judgeVariant({
      processed,
      referencePngs: refs,
      brief: makeBrief({ type: 'enemy', mobRole: 'boss', prompt: 'A boss dungeon rat enemy.' }),
      styleGuide: 'style',
      provider,
      variantIndex: 1,
      cache,
      now: FIXED_NOW,
      env: {},
    });

    expect(calls).toBe(2);
    expect(normal.bossPresence).toBeUndefined();
    expect(boss.bossPresence?.score).toBe(5);
  });
});

describe('judgeVariant — threshold rejection', () => {
  it('marks passed=false when any evaluator scores below 3 and lists the rejecter(s)', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 4, rationale: 'a' },
        brief_match: { score: 2, rationale: 'wrong subject' },
        readability: { score: 5, rationale: 'c' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    expect(scorecard.passed).toBe(false);
    expect(scorecard.rejectedBy).toEqual(['brief_match']);
    expect(scorecard.minScore).toBe(2);
  });

  it('lists multiple rejecters when several evaluators fail', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 1, rationale: 'a' },
        brief_match: { score: 5, rationale: 'b' },
        readability: { score: 2, rationale: 'c' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    expect(scorecard.passed).toBe(false);
    expect(scorecard.rejectedBy).toEqual([
      'design_language',
      'reference_style_match',
      'readability',
    ]);
    expect(scorecard.minScore).toBe(1);
  });

  it('treats exactly 3 as passing (>= 3 is the spec threshold, not > 3)', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 3, rationale: 'a' },
        brief_match: { score: 3, rationale: 'b' },
        readability: { score: 3, rationale: 'c' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    expect(scorecard.passed).toBe(true);
    expect(scorecard.rejectedBy).toEqual([]);
  });

  it('auto-rejects on a low theme_adherence score even when the other four axes pass', async () => {
    const { provider } = stubProvider({
      responseJson: {
        design_language: { score: 5, rationale: 'a' },
        reference_style_match: { score: 5, rationale: 'b' },
        brief_match: { score: 5, rationale: 'c' },
        readability: { score: 5, rationale: 'd' },
        pose_orientation: { score: 5, rationale: 'camera-facing turn' },
        theme_adherence: { score: 1, rationale: 'ignores the family addendum entirely' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({ type: 'enemy', name: 'goblin-grunt', floor: 2 }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    expect(scorecard.passed).toBe(false);
    expect(scorecard.rejectedBy).toEqual(['theme_adherence']);
    expect(scorecard.minScore).toBe(1);
  });

  it('auto-rejects score 2 theme_adherence (on-vibe but no addendum details legible)', async () => {
    const { provider } = stubProvider({
      responseJson: {
        design_language: { score: 5, rationale: 'a' },
        reference_style_match: { score: 5, rationale: 'b' },
        brief_match: { score: 5, rationale: 'c' },
        readability: { score: 5, rationale: 'd' },
        pose_orientation: { score: 5, rationale: 'camera-facing turn' },
        theme_adherence: { score: 2, rationale: 'on-vibe but no addendum details visible' },
      },
    });
    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief({ type: 'enemy', name: 'goblin-grunt', floor: 2 }),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });
    expect(scorecard.passed).toBe(false);
    expect(scorecard.rejectedBy).toEqual(['theme_adherence']);
    expect(scorecard.minScore).toBe(2);
  });
});

describe('judgeVariant — malformed responses', () => {
  it.each([
    {
      blocked: true,
      instruction: null,
      rationale: 'blocked without the required exact phrase',
    },
    {
      blocked: false,
      instruction: JUDGE_HARD_BLOCK_PHRASE,
      rationale: 'not blocked but still emitted the phrase',
    },
    {
      blocked: true,
      instruction: JUDGE_HARD_BLOCK_PHRASE,
      rationale: null,
    },
  ])('throws JudgeError(malformed) on hard_block contract mismatch: %j', async (hardBlock) => {
    const { provider } = stubProvider({
      responseJson: {
        confidence: 0.5,
        hard_block: hardBlock,
        design_language: { score: 5, rationale: 'a' },
        reference_style_match: { score: 5, rationale: 'b' },
        brief_match: { score: 5, rationale: 'c' },
        readability: { score: 5, rationale: 'd' },
      },
    });
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: {},
      }),
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('throws JudgeError(malformed) when an evaluator is missing', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'a' },
        brief_match: { score: 5, rationale: 'b' },
        // readability missing
      },
    });
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: {},
      }),
    ).rejects.toMatchObject({ name: 'JudgeError', kind: 'malformed' });
  });

  it('throws JudgeError(malformed) when a score is out of range', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'a' },
        brief_match: { score: 6, rationale: 'b' }, // > 5
        readability: { score: 4, rationale: 'c' },
      },
    });
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: {},
      }),
    ).rejects.toMatchObject({ name: 'JudgeError', kind: 'malformed' });
  });

  it('throws JudgeError(malformed) when an extra field appears (strict schema)', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'a' },
        brief_match: { score: 5, rationale: 'b' },
        readability: { score: 5, rationale: 'c' },
        bonus_evaluator: { score: 5, rationale: 'unauthorised' },
      },
    });
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: {},
      }),
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('propagates VisionProviderError unchanged (does not wrap)', async () => {
    const provider = throwingProvider(
      new VisionProviderError('rate-limit', 'slow down', undefined),
    );
    await expect(
      judgeVariant({
        processed: makeTinyPng(),
        referencePngs: [],
        brief: makeBrief(),
        styleGuide: '',
        provider,
        variantIndex: 0,
        env: {},
      }),
    ).rejects.toMatchObject({ name: 'VisionProviderError', kind: 'rate-limit' });
  });
});

describe('judgeVariant — legacy scorecards', () => {
  it('marks legacy responses as hard-block unevaluated with safe defaults', async () => {
    const { provider } = stubProvider({
      responseJson: {
        style_match: { score: 5, rationale: 'looks identical' },
        brief_match: { score: 4, rationale: 'on target' },
        readability: { score: 5, rationale: 'silhouette pops' },
      },
    });

    const scorecard = await judgeVariant({
      processed: makeTinyPng(),
      referencePngs: [],
      brief: makeBrief(),
      styleGuide: '',
      provider,
      variantIndex: 0,
      now: FIXED_NOW,
      env: {},
    });

    expect(scorecard.passed).toBe(true);
    expect(scorecard.hardBlockEvaluated).toBe(false);
    expect(scorecard.hardBlocked).toBe(false);
    expect(scorecard.hardBlockInstruction).toBeNull();
    expect(scorecard.hardBlockRationale).toBeNull();
    expect(scorecard.confidence).toBeNull();
  });
});

describe('judgeVariant — JudgeError shape', () => {
  it('exposes a typed `kind` discriminator', () => {
    const e = new JudgeError('ci-refused', 'msg');
    expect(e.kind).toBe('ci-refused');
    expect(e.name).toBe('JudgeError');
    expect(e).toBeInstanceOf(Error);
  });
});
