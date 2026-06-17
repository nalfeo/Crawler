/**
 * Vision-provider abstraction for the sprite pipeline's VLM judge (spec §F4).
 *
 * Separate from `ImageProvider` (image generation) and `TextProvider`
 * (variation expansion) because:
 *
 *   1. Different Azure deployment surface — vision-capable chat completions
 *      use a different deployment name (`AZURE_OPENAI_VISION_DEPLOYMENT`)
 *      than the gpt-image-1 deployment that generates the sheet.
 *   2. Different cost profile — vision calls are billed per-image and per
 *      output token; the judge is opt-in per brief and CI-banned.
 *   3. Different failure semantics — a vision call returning malformed JSON
 *      is a "the model misread instructions" failure, not a "the image
 *      provider drifted" failure, so it gets its own error kind so the
 *      orchestrator can decide whether to surface or retry.
 *
 * The provider returns the parsed JSON object as `unknown`. The caller
 * (`judge.ts`) validates the shape against a Zod schema; the provider
 * only guarantees "valid JSON object came back". This keeps the provider
 * decoupled from the judge's evaluator schema — adding a fourth
 * evaluator one day doesn't touch this file.
 */
export class VisionProviderError extends Error {
  kind;
  name = 'VisionProviderError';
  constructor(kind, message, options) {
    super(message, options);
    this.kind = kind;
  }
}
//# sourceMappingURL=vision-types.js.map
