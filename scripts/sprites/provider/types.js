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
export class ProviderError extends Error {
  kind;
  name = 'ProviderError';
  constructor(kind, message, options) {
    super(message, options);
    this.kind = kind;
  }
}
//# sourceMappingURL=types.js.map
