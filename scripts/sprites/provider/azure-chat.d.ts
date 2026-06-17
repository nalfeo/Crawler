/**
 * Azure OpenAI chat-completions adapter used to expand a brief's
 * `variations` seed list with LLM-proposed on-theme embellishments.
 *
 * Same envelope conventions as `azure-openai.ts`:
 *
 *   - Constructor takes `fetch` so unit tests stub the network.
 *   - No retries here. The orchestrator owns retry policy and, for
 *     variation expansion specifically, the orchestrator chooses
 *     "swallow and degrade" over "retry" because the run can still
 *     succeed without the extra variations.
 *   - All failures surface as `TextProviderError` with a typed `kind`.
 *
 * Response parsing is deliberately permissive:
 *
 *   - Models sometimes wrap JSON in ```json ... ``` fences or prefix it
 *     with "Sure! Here are the variations:" prose. We strip fences,
 *     locate the first `{` or `[`, and parse from there.
 *   - We accept either a JSON array of strings or an object with a
 *     top-level `variations` array. Whichever the model picks today.
 *   - Non-string entries are filtered out; whitespace is trimmed;
 *     duplicates (case-insensitive) within the response are collapsed.
 *
 * This keeps the integration robust against the small instruction
 * drifts that text models inevitably exhibit.
 */
import type { ExpandVariationsRequest, TextProvider } from './text-types.js';
export interface AzureOpenAIChatProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /** Sampling temperature for the brainstorm call. Defaults to 0.9 — we
   *  want creative spread, not deterministic output. */
  readonly temperature?: number;
  /** Hard cap on response tokens. 600 is plenty for ~20 short strings. */
  readonly maxTokens?: number;
  /** Injectable fetch implementation; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}
export declare class AzureOpenAIChatProvider implements TextProvider {
  private readonly endpoint;
  private readonly deployment;
  private readonly apiKey;
  private readonly apiVersion;
  private readonly temperature;
  private readonly maxTokens;
  private readonly fetchImpl;
  constructor(opts: AzureOpenAIChatProviderOptions);
  expandVariations(request: ExpandVariationsRequest): Promise<ReadonlyArray<string>>;
}
//# sourceMappingURL=azure-chat.d.ts.map
