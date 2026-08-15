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

export interface VisionImageInput {
  /** PNG bytes of the image to show the model. */
  readonly png: Buffer;
  /** MIME type for arbitrary screenshot inputs; defaults to image/png. */
  readonly mediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
  /**
   * Short label the prompt references when asking the model about this
   * image (e.g. "candidate", "reference-1", "readability-composite").
   * The judge embeds the label in the textual instructions so the model
   * doesn't conflate candidate vs. reference vs. composite — a real
   * failure mode when three or more images share a single user turn.
   */
  readonly label: string;
}

export interface EvaluateRequest {
  /**
   * System-level instructions. The judge composes these from the style
   * preamble and the evaluator definitions; the provider passes them
   * through unchanged.
   */
  readonly systemInstructions: string;
  /**
   * Free-form user prompt that names every attached image by its label
   * and asks the model to return a structured JSON object. The provider
   * sends this verbatim alongside the images.
   */
  readonly userPrompt: string;
  /** Images attached to the user turn, in declared order. */
  readonly images: ReadonlyArray<VisionImageInput>;
  /** Hard cap on response tokens. */
  readonly maxTokens?: number;
  /** Sampling temperature. Defaults to 0 — judges should be near-deterministic. */
  readonly temperature?: number;
}

export interface EvaluateResponse {
  /**
   * Parsed JSON object returned by the model. The provider validates
   * "is this valid JSON?" but NOT "does the shape match what the caller
   * wanted" — that's the caller's job (typically via Zod).
   */
  readonly json: unknown;
  /**
   * Best-effort token accounting surfaced for cost tracking. Some
   * Azure responses omit `usage`; treat undefined as "unknown".
   */
  readonly usage: VisionUsage | null;
  /**
   * Deployment name the call hit. Echoed for traceability in the judge
   * artifact so reviewers can tell which model produced a verdict.
   */
  readonly modelDeployment: string;
}

export interface VisionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface VisionProvider {
  /**
   * Deployment name this provider hits. Echoed for traceability and
   * used by the judge cache as part of its hash key — a verdict from
   * model A must NEVER replay for model B. Mock providers in tests
   * pick any deterministic string.
   */
  readonly modelDeployment: string;
  evaluate(request: EvaluateRequest): Promise<EvaluateResponse>;
}

export type VisionProviderErrorKind =
  /** Auth failed (bad key, deployment not provisioned). Don't retry. */
  | 'auth'
  /** Rate-limited or quota exhausted. */
  | 'rate-limit'
  /** Provider failed transiently after bounded in-process retries. */
  | 'server-error'
  /** Provider deterministically rejected the request or its content. */
  | 'request-error'
  /** Network error talking to the provider. */
  | 'network'
  /** Provider returned a non-JSON / unparseable body. */
  | 'malformed'
  /** Unexpected provider failure that may be transient. */
  | 'provider-error';

export class VisionProviderError extends Error {
  override readonly name = 'VisionProviderError';
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly kind: VisionProviderErrorKind,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.retryAfterMs = options?.retryAfterMs;
  }
}
