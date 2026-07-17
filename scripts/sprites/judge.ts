/**
 * VLM judge for the sprite generation pipeline (spec §F4).
 *
 * Four evaluators, one vision call per variant:
 *
 *   - `design_language` — does the concept feel specifically like Crawler?
 *   - `reference_style_match` — does rendering match approved references?
 *   - `brief_match`   — does the candidate match `brief.prompt`?
 *   - `readability`   — does the candidate read at game scale on a dark
 *                       floor tile? (composited preview attached)
 *
 * Each evaluator returns a 1-5 integer score and a 1-2 sentence
 * rationale. A variant is `passed` only when ALL evaluators score >= 3
 * (spec §F4: `< 3 auto-rejects`).
 *
 * Hard constitutional rule (§3 — Deterministic CI Only): this module
 * REFUSES to run when `process.env.CI` is defined. The judge calls a
 * live Azure deployment, is non-deterministic, and costs credits;
 * none of those are acceptable in a CI gate. Bypassing requires an
 * ADR — see ADR 0043 for the asset-request CI worker exception, which
 * opens the gate when `SPRITES_ALLOW_CI_PIPELINE=true` is ALSO set.
 *
 * Cost discipline: one vision call per variant — all three evaluators
 * are requested in a single structured-output response, NOT fanned out
 * into three separate calls. This keeps a typical 8-variant brief well
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
const PROMPT_TEMPLATE_VERSION = 'v4';

export type Evaluator = 'design_language' | 'reference_style_match' | 'brief_match' | 'readability';

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
  /** True iff every evaluator scored >= 3. */
  readonly passed: boolean;
  /** Lowest of the three scores. Convenient for ranking. */
  readonly minScore: number;
  /** Evaluator names that auto-rejected (`< 3`). Empty when `passed`. */
  readonly rejectedBy: ReadonlyArray<Evaluator>;
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
}

/** Zod schema for the model's structured response. Single source of truth. */
const evaluatorPayloadSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    rationale: z.string().min(1).max(500),
  })
  .strict();

const judgeResponseSchema = z
  .object({
    design_language: evaluatorPayloadSchema,
    reference_style_match: evaluatorPayloadSchema,
    brief_match: evaluatorPayloadSchema,
    readability: evaluatorPayloadSchema,
  })
  .strict();

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

  // Cache lookup runs BEFORE building previews / images — a hit
  // avoids both the provider call AND the (cheap-but-not-free) PNG
  // composition work. The orchestrator only calls judgeVariant when
  // `brief.judge.enabled === true`, so the cache will never be
  // queried for a judge-disabled brief.
  const cacheKey = options.cache
    ? options.cache.computeKey({
        modelDeployment: options.provider.modelDeployment,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        variantPng: options.processed,
        referencePngs: options.referencePngs,
        briefMatchInstructions: options.brief.prompt,
        floor: options.brief.floor,
      })
    : null;
  if (options.cache && cacheKey) {
    const hit = options.cache.get(cacheKey);
    if (hit) {
      // Re-stamp variantIndex so the cached card looks correct for THIS
      // run — same model verdict, but slot in the right index for the
      // sidecar/summary. Everything else (scores, rationales, usage,
      // model) is replayed verbatim from cache.
      const replayed: JudgeScorecard = { ...hit, variantIndex: options.variantIndex };
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
    systemInstructions: buildSystemInstructions(options.styleGuide, options.brief.floor),
    userPrompt: buildUserPrompt(options.brief, referencePreviews.length),
    images: [
      { png: candidatePreview, label: 'candidate' },
      { png: readabilityComposite, label: 'readability-composite' },
      ...referencePreviews.map((r, i) => ({ png: r.png, label: `reference-${i + 1}` })),
    ],
  };

  const response = await options.provider.evaluate(request);

  const parsed = judgeResponseSchema.safeParse(normalizeLegacyJudgeResponse(response.json));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new JudgeError(
      'malformed',
      `Judge response failed schema validation:\n${issues}\nRaw: ${JSON.stringify(response.json).slice(0, 300)}`,
    );
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

  const scorecard = buildScorecard({
    variantIndex: options.variantIndex,
    payload: parsed.data,
    modelDeployment: response.modelDeployment,
    usage: response.usage,
    now: now(),
  });

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
  payload: z.infer<typeof judgeResponseSchema>;
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
  ];
  const rejectedBy = evaluators.filter(([, r]) => r.score < 3).map(([name]) => name);
  const minScore = Math.min(...evaluators.map(([, r]) => r.score));
  return {
    variantIndex: args.variantIndex,
    modelDeployment: args.modelDeployment,
    judgedAt: args.now.toISOString(),
    designLanguage: args.payload.design_language,
    referenceStyleMatch: args.payload.reference_style_match,
    styleMatch: args.payload.reference_style_match,
    briefMatch: args.payload.brief_match,
    readability: args.payload.readability,
    passed: rejectedBy.length === 0,
    minScore,
    rejectedBy,
    usage: args.usage,
  };
}

function buildSystemInstructions(styleGuide: string, floor: number): string {
  return [
    'You are a strict quality judge for pixel-art sprites generated for a top-down roguelike game.',
    '',
    'You will be shown a CANDIDATE sprite (upscaled for legibility), a READABILITY-COMPOSITE',
    '(the same sprite at 1x size on a dark floor tile, then upscaled), and one or more',
    'REFERENCE sprites. The references are our OWN highest-quality approved in-game sprites —',
    'the canonical Crawler art style, not off-style stock art — so the candidate should look',
    'like it belongs in the same shipped set.',
    '',
    contentDirectionBlock(floor),
    '',
    'Score the candidate on four independent 1-5 ordinal axes:',
    '',
    '  1. design_language — Does the concept feel specifically like Crawler: one readable',
    '                       identity plus one authored contradiction, darkly funny rather than',
    '                       generic grim fantasy, and appropriately strange for the supplied floor?',
    '',
    '  2. reference_style_match — Does the rendering belong beside the approved references?',
    '                              Compare outline weight, palette depth, shading stops, dithering,',
    '                              edge treatment, final-output pixel-cluster granularity, scale, and',
    '                              production finish. Obvious coarser blocks or inconsistent effective',
    '                              resolution versus the references score <= 2. Do not require the same',
    '                              subject matter or palette.',
    '',
    '  3. brief_match  — Does the candidate depict the subject described in the brief',
    '                    and comply with EXPECTED PRESENTATION in the user prompt?',
    '                    5 = unambiguously the requested subject and camera angle. An enemy shown in',
    '                    strict profile when front-biased three-quarter is expected scores <= 2.',
    '                    Accidental faces or limbs on an inanimate item score <= 2.',
    '',
    '  4. readability  — Inspect the READABILITY-COMPOSITE. Does the silhouette read clearly',
    '                    at game scale on a dark floor tile? 5 = silhouette pops; the subject',
    '                    is obvious in one glance. 1 = the sprite blends into the floor or',
    '                    the silhouette is illegible.',
    '                    Explicitly penalize visual integrity defects: transparency holes',
    '                    punched through the body, disconnected/floating pixel islands,',
    '                    detached limbs/fragments, and broken contiguous silhouette.',
    '                    These defects should score readability <= 2.',
    '',
    'Anything scoring below 3 auto-rejects the variant. Use the full 1-5 scale; do not',
    'default to 3 for borderline cases — pick 2 (fail) or 4 (pass) and justify briefly.',
    '',
    'Rationale per axis: 1-2 sentences max. Be specific (e.g. "outline too thin compared',
    'to references" not "looks wrong"). No prose outside the JSON.',
    '',
    'Rendering reference (references provide evidence but do not override Crawler design language):',
    truncate(styleGuide, 1500),
    '',
    'Respond with STRICT JSON only — no prose, no markdown — matching this shape:',
    '{',
    '  "design_language": { "score": 1-5, "rationale": "..." },',
    '  "reference_style_match": { "score": 1-5, "rationale": "..." },',
    '  "brief_match": { "score": 1-5, "rationale": "..." },',
    '  "readability": { "score": 1-5, "rationale": "..." }',
    '}',
  ].join('\n');
}

function buildUserPrompt(brief: Brief, referenceCount: number): string {
  const hasReferences = referenceCount > 0;
  const refSummary = hasReferences
    ? `${referenceCount} reference image(s) attached, labelled reference-1 .. reference-${referenceCount}.`
    : 'No reference images attached.';
  const lines = [
    `BRIEF NAME: ${brief.name}`,
    `BRIEF TYPE: ${brief.type}`,
    `BRIEF PROMPT: ${brief.prompt}`,
    `FLOOR: ${brief.floor} of 20`,
    `EXPECTED PRESENTATION: ${expectedPresentation(brief)}`,
    `EFFECTIVE GEOMETRY: ${effectiveGeometry(brief)}`,
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

  function expectedPresentation(brief: Brief): string {
    if (brief.type !== 'enemy') return 'follow the brief and type conventions';
    const facing = brief.sensors.enemy?.facing ?? 'front';
    if (facing === 'front') {
      return 'front-biased three-quarter, roughly two-thirds toward camera, with both eyes and the face plane readable; not strict profile';
    }
    if (facing === 'left' || facing === 'right') return `strict profile facing ${facing}`;
    return 'consistent across variants';
  }

  function effectiveGeometry(brief: Brief): string {
    const sheet = brief.generation?.sheet ?? {
      nativeCanvas: 1024,
      rows: 4,
      cols: 4,
    };
    const { nativeCanvas, rows, cols } = sheet;
    const size = brief.size ?? { width: 64, height: 64 };
    const sourceWidth = nativeCanvas / cols;
    const sourceHeight = nativeCanvas / rows;
    return (
      `${rows} rows x ${cols} columns on ${nativeCanvas}x${nativeCanvas}; ` +
      `approximately ${formatDimension(sourceWidth)}x${formatDimension(sourceHeight)} source pixels ` +
      `to ${size.width}x${size.height} output pixels`
    );
  }

  function formatDimension(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  lines.push('', refSummary, '', 'Return your four scores and rationales as a strict JSON object.');
  return lines.filter((s) => s !== '').join('\n');
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
