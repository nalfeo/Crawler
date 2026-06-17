/**
 * Azure OpenAI chat-completions adapter for brief synthesis.
 *
 * Sibling to `azure-chat.ts` (which handles variation expansion). Both
 * point at the same chat deployment but request very different
 * response shapes, so they're kept as separate classes — easier to
 * test, easier to reason about, no flag-of-flags inside one method.
 *
 * Conventions match `azure-chat.ts`:
 *   - `fetch` is injectable for tests.
 *   - No retries; the orchestrator owns retry policy.
 *   - HTTP / payload errors surface as `SynthProviderError` with a
 *     typed `kind`.
 *
 * The provider does NOT validate the structured response semantically
 * — it only parses it as JSON and confirms the top-level shape is
 * plausible. Field-level validation (banned adjectives, allow-list
 * membership, candidate count) is the synthesizer's job, so all the
 * rejection logic lives in one place.
 */
import type {
  SynthesizeBriefRequest,
  SynthesizeBriefResponse,
  SynthProvider,
} from './synth-types.js';
export interface AzureOpenAISynthProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /**
   * Sampling temperature. Default 0.85 — we want creative spread
   * across the three candidates but not so much that the model goes
   * off-format. Slightly below the variation-expander's 0.9 because
   * synthesis is more structured (must hit the JSON schema).
   */
  readonly temperature?: number;
  /** Hard cap on response tokens. 1500 covers 5 candidates with prose. */
  readonly maxTokens?: number;
  /** Injectable fetch implementation; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}
export declare class AzureOpenAISynthProvider implements SynthProvider {
  private readonly endpoint;
  private readonly deployment;
  private readonly apiKey;
  private readonly apiVersion;
  private readonly temperature;
  private readonly maxTokens;
  private readonly fetchImpl;
  readonly providerLabel: string;
  constructor(opts: AzureOpenAISynthProviderOptions);
  synthesizeBrief(request: SynthesizeBriefRequest): Promise<SynthesizeBriefResponse>;
}
export declare function buildSystemPrompt(request: SynthesizeBriefRequest): string;
export declare function buildUserPrompt(request: SynthesizeBriefRequest): string;
//# sourceMappingURL=azure-chat-synth.d.ts.map
