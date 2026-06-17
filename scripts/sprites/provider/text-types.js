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
export class TextProviderError extends Error {
  kind;
  name = 'TextProviderError';
  constructor(kind, message, options) {
    super(message, options);
    this.kind = kind;
  }
}
//# sourceMappingURL=text-types.js.map
