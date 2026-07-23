/**
 * Provider abstraction for image generation.
 *
 * The pipeline takes a `brief + prompt + reference PNGs` triple and asks
 * the provider to return one big sheet PNG containing N variants in a
 * regular grid. The orchestrator slices that sheet, post-processes each
 * cell, and scores the results.
 *
 * Two reasons for an interface:
 *
 * 1. **Mock-friendly tests**: the orchestrator integration test uses a
 *    synthetic-sheet mock provider so the full pipeline (slice + process +
 *    score + select) runs without network.
 * 2. **Provider swap**: the same interface accommodates the planned MAI
 *    image-gen path (see TODO in `./azure-openai.ts`). The factory in
 *    `./factory.ts` picks an implementation from env.
 */

import type { Brief } from '../brief-schema.js';

export interface GenerateSheetRequest {
  readonly brief: Brief;
  readonly prompt: string;
  /**
   * Optional single-cell prompt for providers that cannot generate a whole
   * multi-variant sheet in one call (for example local txt2img backends).
   * When present, providers should prefer this over the sheet-level prompt.
   */
  readonly singleVariantPrompt?: string;
  readonly referencePngs: ReadonlyArray<Buffer>;
  /**
   * Number of variants the model is ASKED to produce on the sheet (the brief's
   * commanded count, `variantCount(brief)`). This is a generation hint only —
   * the slicer is data-driven and accepts whatever grid the model actually draws
   * (see ADR 0052), so a mismatch no longer forces a
   * count-based retry. Exposed separately so callers can still override the hint.
   */
  readonly variants: number;
  /**
   * Square pixel side of the *whole sheet* to request from the provider.
   * Defaults to `brief.generation.sheet.nativeCanvas` (1024 unless the
   * brief overrides it).
   */
  readonly size?: number;
}

export type ProviderErrorKind =
  /** Auth failed (bad API key, expired token). Don't retry. */
  | 'auth'
  /** Rate-limited or quota exhausted. Caller may back off and retry. */
  | 'rate-limit'
  /** Provider failed transiently after bounded in-process retries. */
  | 'server-error'
  /** Provider deterministically rejected the request or its content. */
  | 'request-error'
  /** Network error talking to the provider. Caller may retry. */
  | 'network'
  /** Provider returned a non-PNG body or one that doesn't decode. */
  | 'non-png'
  /** Provider returned a sheet that doesn't match the requested grid. */
  | 'bad-grid'
  /** Unexpected provider or pipeline failure that may be transient. */
  | 'provider-error';

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * An image provider returns a single PNG buffer containing all N variants
 * laid out in a `rows x cols` grid matching the brief's `generation.sheet`.
 *
 * Implementations:
 * - MAY perform bounded transport retries for rate limits, server failures,
 *   and network errors. Semantic retries remain the orchestrator's concern.
 * - DO throw `ProviderError` with a typed `kind` so the orchestrator can
 *   decide intelligently.
 */
export interface ImageProvider {
  /**
   * Optional provider capabilities used by orchestrators to adapt behaviour
   * without backend-specific type checks.
   */
  readonly capabilities?: {
    /**
     * Whether this provider can consume `referencePngs` directly.
     * Defaults to true when omitted.
     */
    readonly referenceImages?: boolean;
  };
  generateSheet(request: GenerateSheetRequest): Promise<Buffer>;
}
