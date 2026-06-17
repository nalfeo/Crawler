/**
 * VLM judge for the sprite generation pipeline (spec §F4).
 *
 * Three evaluators, one vision call per variant:
 *
 *   - `style_match`   — does the candidate read as same-family as the
 *                       brief's reference sprites?
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
 * ADR, period.
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
export const PROMPT_TEMPLATE_VERSION = 'v2';
export const EVALUATORS = ['style_match', 'brief_match', 'readability'];
/** Zod schema for the model's structured response. Single source of truth. */
const evaluatorPayloadSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    rationale: z.string().min(1).max(500),
  })
  .strict();
export const judgeResponseSchema = z
  .object({
    style_match: evaluatorPayloadSchema,
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
  kind;
  name = 'JudgeError';
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}
/**
 * Judge one variant. Returns the scorecard and (optionally) writes it
 * to disk next to the existing sensor scorecard. Does NOT mutate the
 * sensor scorecard.
 *
 * Throws `JudgeError('ci-refused')` if `env.CI` is defined. Throws
 * `VisionProviderError` on provider failures. Throws `JudgeError('malformed')`
 * when the provider returned valid JSON that fails the evaluator schema.
 */
export async function judgeVariant(options) {
  const env = options.env ?? process.env;
  if (env.CI !== undefined) {
    throw new JudgeError(
      'ci-refused',
      'Per Constitutional §3, judge.ts is local-only — it costs Azure credits and is ' +
        'non-deterministic. Bypassing requires an ADR. Unset the CI environment variable ' +
        'to run locally, or disable the judge for this brief.',
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
      })
    : null;
  if (options.cache && cacheKey) {
    const hit = options.cache.get(cacheKey);
    if (hit) {
      // Re-stamp variantIndex so the cached card looks correct for THIS
      // run — same model verdict, but slot in the right index for the
      // sidecar/summary. Everything else (scores, rationales, usage,
      // model) is replayed verbatim from cache.
      const replayed = { ...hit, variantIndex: options.variantIndex };
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
    .map((png) => ({ png, label: 'reference' }));
  const request = {
    systemInstructions: buildSystemInstructions(options.styleGuide),
    userPrompt: buildUserPrompt(options.brief, referencePreviews.length),
    images: [
      { png: candidatePreview, label: 'candidate' },
      { png: readabilityComposite, label: 'readability-composite' },
      ...referencePreviews.map((r, i) => ({ png: r.png, label: `reference-${i + 1}` })),
    ],
  };
  const response = await options.provider.evaluate(request);
  const parsed = judgeResponseSchema.safeParse(response.json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new JudgeError(
      'malformed',
      `Judge response failed schema validation:\n${issues}\nRaw: ${JSON.stringify(response.json).slice(0, 300)}`,
    );
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
function writeSidecar(processedDir, variantIndex, card) {
  const file = path.join(processedDir, `${String(variantIndex).padStart(2, '0')}.judge.json`);
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`);
}
function buildScorecard(args) {
  const evaluators = [
    ['style_match', args.payload.style_match],
    ['brief_match', args.payload.brief_match],
    ['readability', args.payload.readability],
  ];
  const rejectedBy = evaluators.filter(([, r]) => r.score < 3).map(([name]) => name);
  const minScore = Math.min(...evaluators.map(([, r]) => r.score));
  return {
    variantIndex: args.variantIndex,
    modelDeployment: args.modelDeployment,
    judgedAt: args.now.toISOString(),
    styleMatch: args.payload.style_match,
    briefMatch: args.payload.brief_match,
    readability: args.payload.readability,
    passed: rejectedBy.length === 0,
    minScore,
    rejectedBy,
    usage: args.usage,
  };
}
function buildSystemInstructions(styleGuide) {
  return [
    'You are a strict quality judge for pixel-art sprites generated for a top-down roguelike game.',
    '',
    'You will be shown a CANDIDATE sprite (upscaled for legibility), a READABILITY-COMPOSITE',
    '(the same sprite at 1x size on a dark floor tile, then upscaled), and one or more',
    'REFERENCE sprites that anchor the target visual style.',
    '',
    'Score the candidate on three independent 1-5 ordinal axes:',
    '',
    '  1. style_match  — Does the candidate read as same-family as the references?',
    '                    Match: outline thickness, palette, shading stops, anti-aliasing,',
    '                    silhouette weight. 5 = indistinguishable from references. 1 = generic',
    '                    AI pixel art that obviously does not belong with them.',
    '',
    '  2. brief_match  — Does the candidate depict the subject described in the brief',
    '                    (provided in the user prompt)? 5 = unambiguously the requested',
    '                    subject. 1 = a different subject entirely.',
    '',
    '  3. readability  — Inspect the READABILITY-COMPOSITE. Does the silhouette read clearly',
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
    'Style ground truth (the references take precedence when these conflict):',
    truncate(styleGuide, 1500),
    '',
    'Respond with STRICT JSON only — no prose, no markdown — matching this shape:',
    '{',
    '  "style_match": { "score": 1-5, "rationale": "..." },',
    '  "brief_match": { "score": 1-5, "rationale": "..." },',
    '  "readability": { "score": 1-5, "rationale": "..." }',
    '}',
  ].join('\n');
}
function buildUserPrompt(brief, referenceCount) {
  const hasReferences = referenceCount > 0;
  const refSummary = hasReferences
    ? `${referenceCount} reference image(s) attached, labelled reference-1 .. reference-${referenceCount}.`
    : 'No reference images attached.';
  const lines = [
    `BRIEF NAME: ${brief.name}`,
    `BRIEF TYPE: ${brief.type}`,
    `BRIEF PROMPT: ${brief.prompt}`,
    brief.tags.length > 0 ? `BRIEF TAGS: ${brief.tags.join(', ')}` : '',
    '',
    'Attached images, in order:',
    '  1. candidate              — the sprite to evaluate, upscaled 8x',
    '  2. readability-composite  — the same sprite at 1x on a dark floor tile, upscaled',
  ];
  if (hasReferences) {
    lines.push(
      '  3+. reference-N            — visual style anchor(s). The candidate must read as same-family.',
    );
  }
  lines.push(
    '',
    refSummary,
    '',
    'Return your three scores and rationales as the strict JSON object described in the system prompt.',
  );
  return lines.filter((s) => s !== '').join('\n');
}
/**
 * Nearest-neighbor upscale a PNG by an integer factor. Used to make a
 * sprite legible to a vision model (which downsamples internally
 * anyway, but doesn't reason well about tiny inputs).
 *
 * Pure: same bytes in, same bytes out. No PRNG, no clock.
 */
function upscaleNearestNeighbor(pngBuffer, factor) {
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
      dst.data[dstIdx] = src.data[srcIdx];
      dst.data[dstIdx + 1] = src.data[srcIdx + 1];
      dst.data[dstIdx + 2] = src.data[srcIdx + 2];
      dst.data[dstIdx + 3] = src.data[srcIdx + 3];
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
function composeReadabilityPreview(processedPng) {
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
      if (src.data[idx + 3] > 0) {
        composite.data[idx] = src.data[idx];
        composite.data[idx + 1] = src.data[idx + 1];
        composite.data[idx + 2] = src.data[idx + 2];
        composite.data[idx + 3] = 255;
      }
    }
  }
  return upscaleNearestNeighbor(PNG.sync.write(composite), 8);
}
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
//# sourceMappingURL=judge.js.map
