/**
 * Synth-provider interface — distinct from `TextProvider` because the
 * request/response shape is fundamentally different (one structured
 * call returns N candidates; variation expansion returns a flat list
 * of strings).
 *
 * The provider returns raw, untrusted data. All validation lives in
 * `synthesize-brief.ts` so the provider stays a thin transport.
 */
export class SynthProviderError extends Error {
  kind;
  name = 'SynthProviderError';
  constructor(kind, message, options) {
    super(message, options);
    this.kind = kind;
  }
}
//# sourceMappingURL=synth-types.js.map
