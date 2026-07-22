/**
 * Synth-provider interface — distinct from `TextProvider` because the
 * request/response shape is fundamentally different (one structured
 * call returns N candidates; variation expansion returns a flat list
 * of strings).
 *
 * The provider returns raw, untrusted data. All validation lives in
 * `synthesize-brief.ts` so the provider stays a thin transport.
 */

import { SPRITE_TYPES } from '../brief-schema.js';

export interface SynthesizeBriefRequest {
  /** Human-supplied subject name, e.g. "devils-yoyo", "scythe". */
  readonly name: string;
  /**
   * Optional one-line direction that refines the subject without being part of
   * its name/slug, e.g. "a corked glass vial of glowing purple liquid". Woven
   * into the user prompt when present; absent/empty leaves the prompt unchanged.
   */
  readonly briefHint?: string;
  /** Caller-supplied type, or null when the model must classify. */
  readonly type: (typeof SPRITE_TYPES)[number] | null;
  /** Dungeon floor intensity, 1..20. */
  readonly floor: number;
  /** Number of distinct candidates to return (1..5). */
  readonly candidates: number;
  /**
   * Inclusive lower bound for `embellishmentSeeds` per candidate. The
   * synthesizer derives this from the sprite-type's `minVariations`
   * default (`data/sprite-types/<type>.json`) so the downstream
   * expand-variations pass doesn't have to manufacture extra entries
   * from a text provider that may not be configured.
   */
  readonly effectiveMinSeeds: number;
  /** Inclusive upper bound for `embellishmentSeeds` per candidate. */
  readonly effectiveMaxSeeds: number;
}

export interface SynthesizedCandidate {
  /** Concrete pose/silhouette description (no vague adjectives). */
  readonly description: string;
  /** 3-5 starter variation ideas for the expander. */
  readonly embellishmentSeeds: ReadonlyArray<string>;
  /** Why this candidate's silhouette differs from the others. */
  readonly rationale: string;
}

export interface SynthesizeBriefResponse {
  /** Set when the request omitted `type` and the model classified it. */
  readonly inferredType: (typeof SPRITE_TYPES)[number] | null;
  /** Confidence in `inferredType`, 0..1. Null when type was provided. */
  readonly typeConfidence: number | null;
  /** Candidate proposals (length === request.candidates). */
  readonly candidates: ReadonlyArray<SynthesizedCandidate>;
}

export interface SynthProvider {
  synthesizeBrief(request: SynthesizeBriefRequest): Promise<SynthesizeBriefResponse>;
  /**
   * Stable identifier for the underlying model/deployment, recorded in
   * the synthesis sidecar so a candidate's provenance is reproducible.
   * Format: `<provider>:<deployment>` (no API keys, no endpoints).
   */
  readonly providerLabel: string;
}

export type SynthProviderErrorKind =
  'auth' | 'rate-limit' | 'network' | 'malformed' | 'provider-error';

export class SynthProviderError extends Error {
  override readonly name = 'SynthProviderError';
  constructor(
    readonly kind: SynthProviderErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
