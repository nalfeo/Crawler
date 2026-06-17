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
import { z } from 'zod';
import type { Brief } from './brief-schema.js';
import { JudgeCache } from './judge-cache.js';
import type { VisionProvider } from './provider/vision-types.js';
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
export declare const PROMPT_TEMPLATE_VERSION = 'v2';
export declare const EVALUATORS: readonly ['style_match', 'brief_match', 'readability'];
export type Evaluator = (typeof EVALUATORS)[number];
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
export declare const judgeResponseSchema: z.ZodObject<
  {
    style_match: z.ZodObject<
      {
        score: z.ZodNumber;
        rationale: z.ZodString;
      },
      z.core.$strict
    >;
    brief_match: z.ZodObject<
      {
        score: z.ZodNumber;
        rationale: z.ZodString;
      },
      z.core.$strict
    >;
    readability: z.ZodObject<
      {
        score: z.ZodNumber;
        rationale: z.ZodString;
      },
      z.core.$strict
    >;
  },
  z.core.$strict
>;
/**
 * Error thrown when a judge call fails for any non-provider reason —
 * principally the CI refusal and response-schema validation. Provider
 * failures still surface as `VisionProviderError` from the underlying
 * provider so the orchestrator can distinguish "the model returned
 * garbage" from "the network timed out".
 */
export declare class JudgeError extends Error {
  readonly kind: 'ci-refused' | 'malformed';
  readonly name = 'JudgeError';
  constructor(kind: 'ci-refused' | 'malformed', message: string);
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
export declare function judgeVariant(options: JudgeVariantOptions): Promise<JudgeScorecard>;
//# sourceMappingURL=judge.d.ts.map
