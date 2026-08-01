/**
 * VLM judge for the sprite generation pipeline (spec §F4).
 *
 * Four evaluators always run in one vision call per variant. Conditional
 * evaluators join them when the brief's subject family needs them:
 *
 *   - `design_language` — does the concept feel specifically like Crawler?
 *   - `reference_style_match` — does rendering match approved references?
 *   - `brief_match`   — does the candidate match `brief.prompt`?
 *   - `readability`   — does the candidate read at game scale on a dark
 *                       floor tile? (composited preview attached)
 *   - `pose_orientation` (enemy/character) — is the subject camera-facing?
 *   - `boss_presence` (boss enemy) — is the silhouette large and dominant?
 *   - `presentation` (equipment/item/prop) — is the family presented correctly?
 *   - `theme_adherence` (floor/theme addendum) — does the candidate honor the
 *                       floor/theme design-language addenda, not just the
 *                       generic Crawler style?
 *
 * Each evaluator returns a 1-5 integer score and a 1-2 sentence
 * rationale. A variant is `passed` only when ALL active evaluators score
 * >= 3 (spec §F4: `< 3 auto-rejects`).
 *
 * Hard constitutional rule (§3 — Deterministic CI Only): this module
 * REFUSES to run when `process.env.CI` is defined. The judge calls a
 * live Azure deployment, is non-deterministic, and costs credits;
 * none of those are acceptable in a CI gate. Bypassing requires an
 * ADR — see ADR 0043 for the asset-request CI worker exception, which
 * opens the gate when `SPRITES_ALLOW_CI_PIPELINE=true` is ALSO set.
 *
 * Cost discipline: one vision call per variant — all active evaluators
 * are requested in a single structured-output response, NOT fanned out
 * into separate calls. This keeps a typical 8-variant brief well
 * under the $0.50/run ceiling in spec §"Cost ceiling".
 *
 * Inputs are pure-ish (Buffer + brief + style guide string); the only
 * impurity is the provider call and the optional sidecar write. The
 * provider is injected so tests run without network.
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { z } from 'zod';
import type { Brief } from './brief-schema.js';
import { isCiPipelineBypassed } from './ci-bypass.js';
import { JudgeCache } from './judge-cache.js';
import type { EvaluateRequest, VisionProvider } from './provider/vision-types.js';
import { contentDirectionBlock } from './content-direction.js';
import { designLanguageAddendaBlock } from './content-direction.js';
import {
  resolveDesignLanguageAddenda,
  type DesignLanguageAddenda,
} from './design-language-addenda.js';

/**
 * Version of the system prompt + user prompt structure built below.
 * Bump whenever ANY of these change:
 *   - the evaluator definitions or scoring rubric,
 *   - the image labelling or attachment order,
 *   - the response schema.
 *
 * The judge cache mixes this into its hash key so a prompt change
 * automatically invalidates old verdicts without manual cache clears.
 */
const PROMPT_TEMPLATE_VERSION = 'v10';

export const JUDGE_HARD_BLOCK_PHRASE = 'I HATE THIS SO MUCH YOU MAY NOT USE THIS IN GAME';

export type Evaluator =
  | 'design_language'
  | 'reference_style_match'
  | 'brief_match'
  | 'readability'
  | 'pose_orientation'
  | 'boss_presence'
  | 'figure_framing'
  | 'presentation'
  | 'theme_adherence';

/** Per-evaluator result on the 1-5 ordinal scale. */
export interface EvaluatorResult {
  readonly score: number;
  readonly rationale: string;
}

/**
 * Standalone judge artifact written to `processed/NN.judge.json`.
 *
 * Deliberately NOT shaped like the sensor scorecard (`{ score, outOf,
 * passed, breakdown }`) — ordinal 1-5 scores aren't comparable with
 * boolean sensor counts, and reviewers should never sum them. The
 * dashboard / lab reads the `passed` flag and the per-evaluator scores
 * directly.
 */
export interface JudgeScorecard {
  readonly variantIndex: number;
  readonly modelDeployment: string;
  readonly judgedAt: string;
  readonly designLanguage?: EvaluatorResult;
  readonly referenceStyleMatch?: EvaluatorResult;
  /** Backward-compatible rendering-style alias for existing run consumers. */
  readonly styleMatch: EvaluatorResult;
  readonly briefMatch: EvaluatorResult;
  readonly readability: EvaluatorResult;
  readonly poseOrientation?: EvaluatorResult;
  readonly bossPresence?: EvaluatorResult;
  readonly figureFraming?: EvaluatorResult;
  readonly presentation?: EvaluatorResult;
  /**
   * Floor/theme design-language adherence. Only present (and only
   * scored) when the brief resolves a floor or theme addendum — see
   * `resolveDesignLanguageAddenda`. Sprites with no addendum have
   * nothing to adhere to, so this is omitted entirely for them rather
   * than defaulting to a pass. When present, it participates in
   * `passed`/`minScore`/`rejectedBy` exactly like the other evaluators,
   * so a sheet that ignores the floor or theme addendum fails review
   * instead of passing on the other four axes alone.
   */
  readonly themeAdherence?: EvaluatorResult;
  /** True iff every evaluator scored >= 3. */
  readonly passed: boolean;
  /** Lowest of the three scores. Convenient for ranking. */
  readonly minScore: number;
  /** Evaluator names that auto-rejected (`< 3`). Empty when `passed`. */
  readonly rejectedBy: ReadonlyArray<Evaluator>;
  /**
   * True when the judge response used the v9+ hard-block contract. Legacy
   * cached/artifact scorecards omit the fields entirely; callers must treat
   * those as unevaluated and therefore ineligible for deterministic
   * auto-selection.
   */
  readonly hardBlockEvaluated?: boolean;
  /** True only when the judge explicitly hard-blocked the candidate. */
  readonly hardBlocked?: boolean;
  /**
   * Exact hard-block instruction phrase when blocked, otherwise null. Legacy
   * scorecards surface null.
   */
  readonly hardBlockInstruction?: string | null;
  /** Judge rationale for the hard-block verdict, or null on legacy scorecards. */
  readonly hardBlockRationale?: string | null;
  /** Top-level judge confidence in `[0,1]`, or null on legacy scorecards. */
  readonly confidence?: number | null;
  /** Provider usage stats when surfaced. Null when the call didn't return them. */
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  } | null;
}

export interface JudgeVariantOptions {
  /** Processed `brief.size` PNG bytes for this variant. */
  readonly processed: Buffer;
  /** Reference PNG buffers from the brief (already loaded). */
  readonly referencePngs: ReadonlyArray<Buffer>;
  readonly brief: Brief;
  /** Loaded style guide string — concatenated into the system prompt. */
  readonly styleGuide: string;
  readonly provider: VisionProvider;
  /** Variant index used for the artifact and the prompt. */
  readonly variantIndex: number;
  /**
   * Directory where the judge artifact is written
   * (`<processedDir>/NN.judge.json`). When omitted, the artifact is NOT
   * written — useful for tests that only want the scorecard return
   * value.
   */
  readonly processedDir?: string;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Env source for the CI guard. Defaults to `process.env`. Tests pass
   * a literal map so they can exercise the refusal path without
   * mutating the real environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional cache. When supplied, the judge computes a hash of
   * `(modelDeployment, prompt template version, variant bytes,
   * reference bytes, brief.prompt)` and short-circuits the provider
   * call on a hit. Misses store the resulting scorecard for next
   * time. Pass `null`/omit to disable caching for this call.
   */
  readonly cache?: JudgeCache | null;
  /**
   * Variant PNG file path used as `meta.variantPath` when populating
   * the cache. Only used as a human-readable breadcrumb in the
   * sidecar `meta.json`; no functional impact. Defaults to a synthetic
   * path derived from `variantIndex`.
   */
  readonly variantPath?: string;
  /**
   * When set, overrides `brief.prompt` as the brief-match instructions passed
   * to the judge and included in the cache key. Used by icon-batch judging to
   * supply each cell's specific concept/description rather than the generic
   * sheet prompt.
   */
  readonly briefMatchInstructions?: string;
}

/** Zod schema for the model's structured response. Single source of truth. */
const evaluatorPayloadSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    rationale: z.string().min(1).max(500),
  })
  .strict();

const legacyJudgeResponseSchema = z
  .object({
    design_language: evaluatorPayloadSchema,
    reference_style_match: evaluatorPayloadSchema,
    brief_match: evaluatorPayloadSchema,
    readability: evaluatorPayloadSchema,
    pose_orientation: evaluatorPayloadSchema.optional(),
    boss_presence: evaluatorPayloadSchema.optional(),
    figure_framing: evaluatorPayloadSchema.optional(),
    presentation: evaluatorPayloadSchema.optional(),
    theme_adherence: evaluatorPayloadSchema.optional(),
  })
  .strict();

const hardBlockPayloadSchema = z
  .object({
    blocked: z.boolean(),
    instruction: z.string().nullable(),
    rationale: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.blocked) {
      if (value.instruction !== JUDGE_HARD_BLOCK_PHRASE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['instruction'],
          message: `instruction must be exactly ${JSON.stringify(JUDGE_HARD_BLOCK_PHRASE)} when blocked`,
        });
      }
      if (value.rationale === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rationale'],
          message: 'rationale must explain the block when blocked is true',
        });
      }
      return;
    }
    if (value.instruction !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruction'],
        message: 'instruction must be null when blocked is false',
      });
    }
  });

const judgeResponseSchema = legacyJudgeResponseSchema
  .extend({
    confidence: z.number().min(0).max(1),
    hard_block: hardBlockPayloadSchema,
  })
  .strict();

type LegacyJudgeResponse = z.infer<typeof legacyJudgeResponseSchema>;
type JudgeResponse = z.infer<typeof judgeResponseSchema>;
type ParsedJudgeResponse =
  | { success: true; data: LegacyJudgeResponse | JudgeResponse; hardBlockEvaluated: boolean }
  | { success: false; error: z.ZodError };

/**
 * `theme_adherence` is REQUIRED in the parsed response when the brief
 * resolves a floor or theme addendum (floor-intensity design language or
 * Floor 2 family design language), and must be absent otherwise. Requiring
 * rather than merely allowing it is deliberate — an optional field the model
 * can silently skip would let a sheet that ignores the floor or family
 * addendum still pass on the other four axes, exactly the failure mode this
 * dimension exists to catch.
 */
function parseJudgeResponse(
  value: unknown,
  brief: Brief,
  hasAddendum: boolean,
): ParsedJudgeResponse {
  const parsed = judgeResponseSchema.safeParse(value);
  if (parsed.success) {
    const validated = validateOptionalAxes(parsed.data, brief, hasAddendum);
    return validated.success
      ? { success: true, data: validated.data, hardBlockEvaluated: true }
      : validated;
  }
  const legacyParsed = legacyJudgeResponseSchema.safeParse(value);
  if (!legacyParsed.success) return parsed;
  const validated = validateOptionalAxes(legacyParsed.data, brief, hasAddendum);
  return validated.success
    ? { success: true, data: validated.data, hardBlockEvaluated: false }
    : validated;
}

function validateOptionalAxes<T extends LegacyJudgeResponse | JudgeResponse>(
  data: T,
  brief: Brief,
  hasAddendum: boolean,
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const expectedOptionalAxes = new Map<string, boolean>([
    ['theme_adherence', hasAddendum],
    ['figure_framing', brief.type === 'enemy' || brief.type === 'character'],
    [
      'pose_orientation',
      (brief.type === 'enemy' || brief.type === 'character') &&
        brief.sensors?.enemy?.facing !== 'front',
    ],
    ['boss_presence', brief.type === 'enemy' && brief.mobRole === 'boss'],
    ['presentation', ['equipment', 'item', 'prop'].includes(brief.type)],
  ]);
  for (const [axis, required] of expectedOptionalAxes) {
    const axisValue = (data as Record<string, unknown>)[axis];
    if (required && axisValue === undefined) {
      return {
        success: false,
        error: new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            path: [axis],
            message: `${axis} is required for this brief`,
          },
        ]),
      };
    }
    if (!required && axisValue !== undefined) {
      return {
        success: false,
        error: new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            path: [axis],
            message: `${axis} is not allowed for this brief`,
          },
        ]),
      };
    }
  }
  return { success: true, data };
}

function normalizeLegacyJudgeResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (
    obj.style_match !== undefined &&
    obj.design_language === undefined &&
    obj.reference_style_match === undefined
  ) {
    const { style_match, ...rest } = obj;
    return {
      ...rest,
      design_language: style_match,
      reference_style_match: style_match,
    };
  }
  return value;
}

function normalizeLegacyScorecard(scorecard: JudgeScorecard): JudgeScorecard {
  if (scorecard.hardBlockEvaluated !== true) {
    return {
      ...scorecard,
      hardBlockEvaluated: false,
      hardBlocked: false,
      hardBlockInstruction: null,
      hardBlockRationale: null,
      confidence: null,
    };
  }
  return {
    ...scorecard,
    hardBlockEvaluated: true,
    hardBlocked: scorecard.hardBlocked === true,
    hardBlockInstruction: scorecard.hardBlocked === true ? JUDGE_HARD_BLOCK_PHRASE : null,
    hardBlockRationale:
      typeof scorecard.hardBlockRationale === 'string' ? scorecard.hardBlockRationale : null,
    confidence: typeof scorecard.confidence === 'number' ? scorecard.confidence : null,
  };
}

/**
 * Error thrown when a judge call fails for any non-provider reason —
 * principally the CI refusal and response-schema validation. Provider
 * failures still surface as `VisionProviderError` from the underlying
 * provider so the orchestrator can distinguish "the model returned
 * garbage" from "the network timed out".
 */
export class JudgeError extends Error {
  override readonly name = 'JudgeError';
  constructor(
    readonly kind: 'ci-refused' | 'malformed',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Judge one variant. Returns the scorecard and (optionally) writes it
 * to disk next to the existing sensor scorecard. Does NOT mutate the
 * sensor scorecard.
 *
 * Throws `JudgeError('ci-refused')` if `env.CI` is defined and the
 * ADR-0043 bypass (`SPRITES_ALLOW_CI_PIPELINE=true`) is NOT set. Throws
 * `VisionProviderError` on provider failures. Throws `JudgeError('malformed')`
 * when the provider returned valid JSON that fails the evaluator schema.
 */
export async function judgeVariant(options: JudgeVariantOptions): Promise<JudgeScorecard> {
  const env = options.env ?? process.env;
  if (env.CI !== undefined && !isCiPipelineBypassed(env)) {
    throw new JudgeError(
      'ci-refused',
      'Per Constitutional §3, judge.ts is local-only — it costs Azure credits and is ' +
        'non-deterministic. Bypassing requires an ADR. Unset the CI environment variable ' +
        'to run locally, disable the judge for this brief, or set SPRITES_ALLOW_CI_PIPELINE=true ' +
        'in the asset-request CI workflow (see ADR 0043).',
    );
  }

  const now = options.now ?? (() => new Date());
  const designLanguageAddenda = resolveDesignLanguageAddenda(
    options.brief.name,
    options.brief.floor,
    options.brief.theme?.designLanguage,
  );
  const hasAddendumForPrompt =
    designLanguageAddenda.floor !== undefined || designLanguageAddenda.theme !== undefined;
  const systemInstructions = buildSystemInstructions(
    options.brief,
    options.styleGuide,
    designLanguageAddenda,
  );
  const userPrompt = buildUserPrompt(
    options.brief,
    Math.min(options.referencePngs.length, 3),
    hasAddendumForPrompt,
  );

  // Cache lookup runs BEFORE building previews / images — a hit
  // avoids both the provider call AND the (cheap-but-not-free) PNG
  // composition work. The orchestrator only calls judgeVariant when
  // `brief.judge.enabled === true`, so the cache will never be
  // queried for a judge-disabled brief.
  const briefMatchInstructions = options.briefMatchInstructions ?? options.brief.prompt;
  const cacheKey = options.cache
    ? options.cache.computeKey({
        modelDeployment: options.provider.modelDeployment,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        variantPng: options.processed,
        referencePngs: options.referencePngs,
        systemInstructions,
        userPrompt,
        briefMatchInstructions,
        floor: options.brief.floor,
        designLanguageAddenda: designLanguageAddendaBlock(designLanguageAddenda),
      })
    : null;
  if (options.cache && cacheKey) {
    const hit = options.cache.get(cacheKey);
    if (hit) {
      // Re-stamp variantIndex so the cached card looks correct for THIS
      // run — same model verdict, but slot in the right index for the
      // sidecar/summary. Everything else (scores, rationales, usage,
      // model) is replayed verbatim from cache.
      const replayed: JudgeScorecard = normalizeLegacyScorecard({
        ...hit,
        variantIndex: options.variantIndex,
      });
      if (options.processedDir) {
        writeSidecar(options.processedDir, options.variantIndex, replayed);
      }
      return replayed;
    }
  }

  const candidatePreview = upscaleNearestNeighbor(options.processed, 8);
  const readabilityComposite = composeReadabilityPreview(options.processed);

  // Cap references to 3 to control per-call cost. The spec's example
  // already uses "three reference PNGs"; more would add tokens without
  // changing style_match accuracy in any measurable way.
  const referencePreviews = options.referencePngs
    .slice(0, 3)
    .map((png) => ({ png, label: 'reference' as const }));

  const request: EvaluateRequest = {
    systemInstructions,
    userPrompt,
    images: [
      { png: candidatePreview, label: 'candidate' },
      { png: readabilityComposite, label: 'readability-composite' },
      ...referencePreviews.map((r, i) => ({ png: r.png, label: `reference-${i + 1}` })),
    ],
  };

  const response = await options.provider.evaluate(request);

  const hasAddendum =
    designLanguageAddenda.floor !== undefined || designLanguageAddenda.theme !== undefined;
  const parsed = parseJudgeResponse(
    normalizeLegacyJudgeResponse(response.json),
    options.brief,
    hasAddendum,
  );
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new JudgeError(
      'malformed',
      `Judge response failed schema validation:\n${issues}\nRaw: ${JSON.stringify(response.json).slice(0, 300)}`,
    );
  }

  const scorecard = normalizeLegacyScorecard(
    buildScorecard({
      variantIndex: options.variantIndex,
      payload: parsed.data,
      hardBlockEvaluated: parsed.hardBlockEvaluated,
      modelDeployment: response.modelDeployment,
      usage: response.usage,
      now: now(),
    }),
  );

  if (options.processedDir) {
    writeSidecar(options.processedDir, options.variantIndex, scorecard);
  }

  if (options.cache && cacheKey) {
    options.cache.put(cacheKey, scorecard, {
      variantPath: options.variantPath ?? `<variant-${options.variantIndex}>`,
      briefId: options.brief.name,
    });
  }

  return scorecard;
}

function writeSidecar(processedDir: string, variantIndex: number, card: JudgeScorecard): void {
  const file = path.join(processedDir, `${String(variantIndex).padStart(2, '0')}.judge.json`);
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`);
}

function buildScorecard(args: {
  variantIndex: number;
  payload: LegacyJudgeResponse | JudgeResponse;
  hardBlockEvaluated: boolean;
  modelDeployment: string;
  usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  } | null;
  now: Date;
}): JudgeScorecard {
  const evaluators: ReadonlyArray<readonly [Evaluator, EvaluatorResult]> = [
    ['design_language', args.payload.design_language],
    ['reference_style_match', args.payload.reference_style_match],
    ['brief_match', args.payload.brief_match],
    ['readability', args.payload.readability],
    ...(args.payload.figure_framing
      ? ([['figure_framing', args.payload.figure_framing]] as const)
      : []),
    ...(args.payload.pose_orientation
      ? ([['pose_orientation', args.payload.pose_orientation]] as const)
      : []),
    ...(args.payload.boss_presence
      ? ([['boss_presence', args.payload.boss_presence]] as const)
      : []),
    ...(args.payload.presentation ? ([['presentation', args.payload.presentation]] as const) : []),
    ...(args.payload.theme_adherence
      ? ([['theme_adherence', args.payload.theme_adherence]] as const)
      : []),
  ];
  const rejectedBy = evaluators.filter(([, r]) => r.score < 3).map(([name]) => name);
  const minScore = Math.min(...evaluators.map(([, r]) => r.score));
  const hardBlock = args.hardBlockEvaluated ? (args.payload as JudgeResponse).hard_block : null;
  const confidence = args.hardBlockEvaluated ? (args.payload as JudgeResponse).confidence : null;
  return {
    variantIndex: args.variantIndex,
    modelDeployment: args.modelDeployment,
    judgedAt: args.now.toISOString(),
    designLanguage: args.payload.design_language,
    referenceStyleMatch: args.payload.reference_style_match,
    styleMatch: args.payload.reference_style_match,
    briefMatch: args.payload.brief_match,
    readability: args.payload.readability,
    poseOrientation: args.payload.pose_orientation,
    bossPresence: args.payload.boss_presence,
    figureFraming: args.payload.figure_framing,
    presentation: args.payload.presentation,
    themeAdherence: args.payload.theme_adherence,
    passed: rejectedBy.length === 0 && !(hardBlock?.blocked ?? false),
    minScore,
    rejectedBy,
    hardBlockEvaluated: args.hardBlockEvaluated,
    hardBlocked: hardBlock?.blocked ?? false,
    hardBlockInstruction: hardBlock?.instruction ?? null,
    hardBlockRationale: hardBlock?.rationale ?? null,
    confidence,
    usage: args.usage,
  };
}

function buildSystemInstructions(
  brief: Brief,
  styleGuide: string,
  addenda: DesignLanguageAddenda,
): string {
  const floor = brief.floor;
  const hasAddendum = addenda.floor !== undefined || addenda.theme !== undefined;
  const bothAddenda = addenda.floor !== undefined && addenda.theme !== undefined;
  // Skip pose_orientation for briefs that explicitly request a front-facing pose:
  // the axis checks for a 1/3-to-2/3 turn and would incorrectly penalise a sprite
  // that correctly follows a `facing: front` brief.
  const hasFigureFramingAxis = brief.type === 'enemy' || brief.type === 'character';
  const hasPoseAxis = hasFigureFramingAxis && brief.sensors?.enemy?.facing !== 'front';
  const hasBossAxis = brief.type === 'enemy' && brief.mobRole === 'boss';
  const hasPresentationAxis = ['equipment', 'item', 'prop'].includes(brief.type);
  const axisCount =
    4 +
    Number(hasFigureFramingAxis) +
    Number(hasPoseAxis) +
    Number(hasBossAxis) +
    Number(hasPresentationAxis) +
    Number(hasAddendum);
  let nextAxisNumber = 5;
  const figureFramingAxisNumber = hasFigureFramingAxis ? nextAxisNumber++ : null;
  const poseAxisNumber = hasPoseAxis ? nextAxisNumber++ : null;
  const bossAxisNumber = hasBossAxis ? nextAxisNumber++ : null;
  const presentationAxisNumber = hasPresentationAxis ? nextAxisNumber++ : null;
  const themeAxisNumber = hasAddendum ? nextAxisNumber : null;
  const responseFields = [
    'design_language',
    'reference_style_match',
    'brief_match',
    'readability',
    ...(hasFigureFramingAxis ? ['figure_framing'] : []),
    ...(hasPoseAxis ? ['pose_orientation'] : []),
    ...(hasBossAxis ? ['boss_presence'] : []),
    ...(hasPresentationAxis ? ['presentation'] : []),
    ...(hasAddendum ? ['theme_adherence'] : []),
  ];
  return [
    'You are a strict quality judge for pixel-art sprites generated for a top-down roguelike game.',
    '',
    'You will be shown a CANDIDATE sprite (upscaled for legibility), a READABILITY-COMPOSITE',
    '(the same sprite at 1x size on a dark floor tile, then upscaled), and one or more',
    'REFERENCE sprites. The references are our OWN highest-quality approved in-game sprites —',
    'the canonical Crawler art style, not off-style stock art — so the candidate should look',
    'like it belongs in the same shipped set.',
    '',
    contentDirectionBlock(floor, addenda),
    '',
    `Score the candidate on ${axisCount === 4 ? 'four' : axisCount} independent 1-5 ordinal axes:`,
    '',
    '  1. design_language — Does the concept feel specifically like Crawler: one readable',
    '                       identity plus one authored contradiction, darkly funny rather than',
    '                       generic grim fantasy, and appropriately strange for the supplied floor?',
    '',
    '  2. reference_style_match — Does the rendering belong beside the approved references?',
    '                              Compare outline weight, palette depth, shading stops, dithering,',
    '                              edge treatment, scale, and production finish. Do not require the',
    '                              same subject matter or palette.',
    '',
    '  3. brief_match  — Does the candidate depict the subject described in the brief',
    '                    (provided in the user prompt)? 5 = unambiguously the requested',
    '                    subject. Accidental faces or limbs on an inanimate item score <= 2.',
    '',
    '  4. readability  — Inspect the READABILITY-COMPOSITE. Does the silhouette read clearly',
    '                    at game scale on a dark floor tile? 5 = silhouette pops; the subject',
    '                    is obvious in one glance. 1 = the sprite blends into the floor or',
    '                    the silhouette is illegible.',
    '                    Explicitly penalize visual integrity defects: transparency holes',
    '                    punched through the body, disconnected/floating pixel islands,',
    '                    detached limbs/fragments, and broken contiguous silhouette.',
    '                    These defects should score readability <= 2.',
    ...(hasFigureFramingAxis
      ? [
          '',
          `  ${figureFramingAxisNumber}. figure_framing — Is the character or mob fully framed from its`,
          '                      highest visible extent to its lowest visible extent, with',
          '                      the whole body visible in-frame? A bust, portrait, or',
          '                      figure cropped at the waist, mid-body, or lower-body',
          '                      scores <= 2. For upright humanoid figures, head/torso/feet',
          '                      should all be visible when that anatomy is present.',
          '                      A pure 90-degree side profile where no face is visible',
          '                      also scores <= 2.',
        ]
      : []),
    ...(hasPoseAxis
      ? [
          '',
          `  ${poseAxisNumber}. pose_orientation — Does the mob or character generally face the camera at a`,
          '                        one-third-to-two-thirds turn? Full side profiles score <= 2.',
        ]
      : []),
    ...(hasBossAxis
      ? [
          '',
          `  ${bossAxisNumber}. boss_presence — Does the boss read substantially taller, wider, or larger in`,
          '                     footprint than an ordinary mob, fill its intended frame, and',
          '                     present a distinctive dominant threat silhouette? A normal-sized',
          '                     enemy with extra accessories scores <= 2.',
        ]
      : []),
    ...(hasPresentationAxis
      ? ['', `  ${presentationAxisNumber}. presentation — ${presentationCriterion(brief.type)}`]
      : []),
    ...(bothAddenda
      ? [
          '',
          `  ${themeAxisNumber}. theme_adherence — Does the candidate visibly incorporate the SPECIFIC nouns,`,
          '                       materials, garments, props, colors, or iconography named in the',
          '                       floor AND theme design language sections above — not just the',
          "                       general Crawler vibe (that is design_language's job)?",
          '                       Both active sections must be represented: floor-intensity cues',
          '                       alone do not satisfy this axis when a family theme is also present.',
          '                       5 = multiple specific details from BOTH sections are clearly visible.',
          '                       4 = at least one unambiguous named detail from EACH active section.',
          '                       3 = specific details from at least one section might be present',
          '                           but are ambiguous; the other section is not represented.',
          '                       2 = on-vibe but none of the named cues from any section are',
          '                           legible — scores 2 or below auto-reject.',
          '                       1 = the candidate contradicts or ignores the addenda entirely.',
        ]
      : hasAddendum
        ? [
            '',
            `  ${themeAxisNumber}. theme_adherence — Does the candidate visibly incorporate the SPECIFIC nouns,`,
            '                       materials, garments, props, colors, or iconography named in the',
            '                       floor or theme design language section above — not just the',
            "                       general Crawler vibe (that is design_language's job)? Look for",
            '                       concrete, named details, not a vague thematic gesture.',
            '                       5 = multiple specific addendum details are clearly visible.',
            '                       4 = at least one named addendum detail is unambiguous.',
            '                       3 = one named detail might be present but is ambiguous.',
            "                       2 = the concept is on-vibe but none of the addendum's distinguishing",
            '                       details are legible — scores 2 or below auto-reject.',
            '                       1 = the candidate contradicts or ignores the addendum entirely.',
          ]
        : []),
    '',
    'Anything scoring below 3 auto-rejects the variant. Use the full 1-5 scale; do not',
    'default to 3 for borderline cases — pick 2 (fail) or 4 (pass) and justify briefly.',
    '',
    'Hard-block contract: set hard_block.blocked=true ONLY when the candidate is so',
    'fundamentally unusable, off-brief, broken, or unacceptable that it must never ship',
    `in-game. When blocked, hard_block.instruction MUST be exactly ${JSON.stringify(
      JUDGE_HARD_BLOCK_PHRASE,
    )}. When not blocked, hard_block.blocked=false and hard_block.instruction=null.`,
    'When blocked, hard_block.rationale must briefly explain why; when not blocked,',
    'hard_block.rationale may be null. Also provide a top-level',
    'confidence number from 0 to 1 for the overall verdict.',
    '',
    'Rationale per axis: 1-2 sentences max. Be specific (e.g. "outline too thin compared',
    'to references" not "looks wrong"). No prose outside the JSON.',
    '',
    'Rendering reference (references provide evidence but do not override Crawler design language):',
    truncate(styleGuide, 1500),
    '',
    'Respond with STRICT JSON only — no prose, no markdown — matching this shape:',
    '{',
    '  "confidence": 0.85,',
    '  "hard_block": { "blocked": false, "instruction": null, "rationale": "..." },',
    ...responseFields.map(
      (field, index) =>
        `  "${field}": { "score": 3, "rationale": "..." }${
          index < responseFields.length - 1 ? ',' : ''
        }`,
    ),
    '}',
  ].join('\n');
}

function buildUserPrompt(brief: Brief, referenceCount: number, hasAddendum: boolean): string {
  const hasReferences = referenceCount > 0;
  const refSummary = hasReferences
    ? `${referenceCount} reference image(s) attached, labelled reference-1 .. reference-${referenceCount}.`
    : 'No reference images attached.';
  const lines = [
    `BRIEF NAME: ${brief.name}`,
    `BRIEF TYPE: ${brief.type}`,
    `BRIEF PROMPT: ${brief.prompt}`,
    `FLOOR: ${brief.floor} of 20`,
    brief.tags.length > 0 ? `BRIEF TAGS: ${brief.tags.join(', ')}` : '',
    '',
    'Attached images, in order:',
    '  1. candidate              — the sprite to evaluate, upscaled 8x',
    '  2. readability-composite  — the same sprite at 1x on a dark floor tile, upscaled',
  ];
  if (hasReferences) {
    lines.push(
      '  3+. reference-N            — our approved in-game sprites; the style ground truth.',
      '                               The candidate must read as same-family with them.',
    );
  }
  lines.push(
    '',
    refSummary,
    '',
    `Return your ${judgeAxisCount(
      brief,
      hasAddendum,
    )} scores and rationales, plus top-level confidence (0..1) and hard_block, as a strict JSON object.`,
  );
  return lines.filter((s) => s !== '').join('\n');
}

function judgeAxisCount(brief: Brief, hasAddendum: boolean): number | string {
  const count =
    4 +
    Number(brief.type === 'enemy' || brief.type === 'character') +
    Number(
      (brief.type === 'enemy' || brief.type === 'character') &&
        brief.sensors?.enemy?.facing !== 'front',
    ) +
    Number(brief.type === 'enemy' && brief.mobRole === 'boss') +
    Number(['equipment', 'item', 'prop'].includes(brief.type)) +
    Number(hasAddendum);
  return count === 4 ? 'four' : count;
}

function presentationCriterion(type: Brief['type']): string {
  if (type === 'equipment') {
    return 'Is this one isolated wearable/equippable icon with no wearer, mannequin, hands, limbs, room, floor, or scene? Violations score <= 2.';
  }
  if (type === 'prop') {
    return 'Is this one grounded world-space object with a readable base, top-down perspective, and appropriate tile footprint rather than a floating inventory icon or scene? Violations score <= 2.';
  }
  return 'Is this one isolated inanimate consumable, resource, or quest object with no person, hands, limbs, room, floor, or scene? Violations score <= 2.';
}

/**
 * Nearest-neighbor upscale a PNG by an integer factor. Used to make a
 * sprite legible to a vision model (which downsamples internally
 * anyway, but doesn't reason well about tiny inputs).
 *
 * Pure: same bytes in, same bytes out. No PRNG, no clock.
 */
function upscaleNearestNeighbor(pngBuffer: Buffer, factor: number): Buffer {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`upscaleNearestNeighbor: factor must be a positive integer, got ${factor}`);
  }
  const src = PNG.sync.read(pngBuffer);
  const dst = new PNG({ width: src.width * factor, height: src.height * factor });
  for (let y = 0; y < dst.height; y++) {
    const srcY = Math.floor(y / factor);
    for (let x = 0; x < dst.width; x++) {
      const srcX = Math.floor(x / factor);
      const srcIdx = (srcY * src.width + srcX) * 4;
      const dstIdx = (y * dst.width + x) * 4;
      dst.data[dstIdx] = src.data[srcIdx]!;
      dst.data[dstIdx + 1] = src.data[srcIdx + 1]!;
      dst.data[dstIdx + 2] = src.data[srcIdx + 2]!;
      dst.data[dstIdx + 3] = src.data[srcIdx + 3]!;
    }
  }
  return PNG.sync.write(dst);
}

/**
 * Compose the readability-preview: the candidate at 1x size on a dark
 * floor tile, then upscaled so the vision model can see it. The tile
 * is a flat dark color rather than a real biome asset because (a) the
 * dungeon's actual floor varies per biome and (b) flat dark is the
 * worst-case background for silhouette readability — if the sprite
 * reads on flat #2a2a32, it'll read on any biome tile.
 *
 * Pure. Same input PNG -> same output PNG.
 */
function composeReadabilityPreview(processedPng: Buffer): Buffer {
  const src = PNG.sync.read(processedPng);
  const composite = new PNG({ width: src.width, height: src.height });
  // Fill with the dark floor color first.
  const FLOOR_R = 42;
  const FLOOR_G = 42;
  const FLOOR_B = 50;
  for (let i = 0; i < composite.data.length; i += 4) {
    composite.data[i] = FLOOR_R;
    composite.data[i + 1] = FLOOR_G;
    composite.data[i + 2] = FLOOR_B;
    composite.data[i + 3] = 255;
  }
  // Source-over composite: any non-zero-alpha pixel in `src` overwrites
  // the floor. The post-processor hard-thresholds alpha to {0,255}, so
  // there's no partial-alpha math to worry about.
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const idx = (y * src.width + x) * 4;
      if (src.data[idx + 3]! > 0) {
        composite.data[idx] = src.data[idx]!;
        composite.data[idx + 1] = src.data[idx + 1]!;
        composite.data[idx + 2] = src.data[idx + 2]!;
        composite.data[idx + 3] = 255;
      }
    }
  }
  return upscaleNearestNeighbor(PNG.sync.write(composite), 8);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
