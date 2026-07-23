/**
 * Text-provider abstraction for the sprite pipeline.
 *
 * The image provider handles the heavyweight `images/edits` round-trip
 * that produces the sheet PNG. A separate text-provider is responsible
 * for cheaper text-completion calls — currently only used to *expand*
 * a brief's `variations` seed list when the author wants the LLM to
 * brainstorm additional on-theme embellishments.
 *
 * Kept distinct from `ImageProvider` for three reasons:
 *
 *   1. Different deployment surface — chat completions vs images/edits
 *      use different Azure deployment names and request shapes.
 *   2. Optionality — the pipeline must run end-to-end even if no chat
 *      deployment is configured. Image generation is required; text
 *      expansion is a "nice to have" that degrades gracefully.
 *   3. Future swap — when MAI text models come online they can
 *      implement this interface independently of the image swap.
 */

import type { Brief } from '../brief-schema.js';

export interface ExpandVariationsRequest {
  readonly brief: Brief;
  /** Variations the author has already declared. Must not be duplicated. */
  readonly existing: ReadonlyArray<string>;
  /** Number of additional variations to propose (always >= 1). */
  readonly count: number;
}

export interface TextProvider {
  /**
   * Propose `request.count` additional on-theme variations for the
   * brief, given the seed `request.existing`. Return value contains
   * ONLY the new entries — the orchestrator appends them to `existing`
   * itself so the seed always survives intact.
   */
  expandVariations(request: ExpandVariationsRequest): Promise<ReadonlyArray<string>>;
}

export type TextProviderErrorKind =
  /** Auth failed. Don't retry. */
  | 'auth'
  /** Rate-limited or quota exhausted. */
  | 'rate-limit'
  /** Provider failed transiently after bounded in-process retries. */
  | 'server-error'
  /** Provider deterministically rejected the request or its content. */
  | 'request-error'
  /** Network error talking to the provider. */
  | 'network'
  /** Provider returned a malformed payload (not parseable JSON, wrong shape). */
  | 'malformed'
  /** Unexpected provider failure that may be transient. */
  | 'provider-error';

export class TextProviderError extends Error {
  override readonly name = 'TextProviderError';
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly kind: TextProviderErrorKind,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.retryAfterMs = options?.retryAfterMs;
  }
}
