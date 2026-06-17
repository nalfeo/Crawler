/**
 * Azure OpenAI vision/chat-completions adapter used by the VLM judge.
 *
 * The judge sends ONE chat-completion request per variant with:
 *   - a system message containing the evaluator definitions and rubric,
 *   - a user message containing the prompt + multiple labelled images
 *     attached as `image_url` parts with base64 `data:` URLs.
 *
 * Conventions mirror `azure-openai.ts` and `azure-chat.ts`:
 *
 *   - Constructor takes `fetch` so unit tests stub the network.
 *   - No retries here — the caller (the orchestrator) decides whether a
 *     failed judge call is fatal or worth retrying. The judge itself is
 *     local-only and per-variant, so a retry loop would burn Azure credits
 *     silently; we surface every failure as a typed error and let the
 *     human inspect.
 *   - All failures surface as `VisionProviderError` with a typed `kind`.
 *
 * The provider validates that the model returned a JSON object (parses
 * with `JSON.parse` after stripping markdown fences) but does NOT
 * validate the shape — the judge's Zod schema does that. Keeping the
 * provider schema-agnostic means adding a fourth evaluator doesn't
 * touch this file.
 */
import type { EvaluateRequest, EvaluateResponse, VisionProvider } from './vision-types.js';
export interface AzureOpenAIVisionProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /** Injectable fetch implementation; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}
export declare class AzureOpenAIVisionProvider implements VisionProvider {
  private readonly endpoint;
  readonly modelDeployment: string;
  private readonly apiKey;
  private readonly apiVersion;
  private readonly fetchImpl;
  constructor(opts: AzureOpenAIVisionProviderOptions);
  evaluate(request: EvaluateRequest): Promise<EvaluateResponse>;
}
//# sourceMappingURL=azure-vision.d.ts.map
