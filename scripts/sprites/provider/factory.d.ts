/**
 * Provider factory.
 *
 * Reads environment variables and constructs an {@link ImageProvider}. The
 * orchestrator and CLI use this to avoid sprinkling env reads through the
 * codebase, and to give tests a clean construct-from-options path that
 * bypasses env entirely.
 *
 * Currently only the Azure OpenAI provider exists. When MAI's image
 * generation endpoint comes online, switch on `SPRITES_PROVIDER` here.
 */
import type { ImageProvider } from './types.js';
import type { TextProvider } from './text-types.js';
import type { SynthProvider } from './synth-types.js';
import type { VisionProvider } from './vision-types.js';
export interface CreateProviderOptions {
  /**
   * Process env source. Defaults to `process.env`. Tests pass a literal
   * map so they don't pollute the real environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional fetch override forwarded to the underlying provider.
   */
  readonly fetch?: typeof fetch;
  /**
   * Optional sink for diagnostic messages (e.g. the chat-deployment
   * alias fallback). Defaults to `console.warn`. Tests inject a
   * `vi.fn()` to assert behaviour without touching the real console.
   */
  readonly warn?: (message: string) => void;
}
export declare function __resetChatDeploymentFallbackWarnings(): void;
export declare function createImageProvider(options?: CreateProviderOptions): ImageProvider;
/**
 * Build a {@link TextProvider} for variation expansion.
 *
 * Returns `null` (not throws) when no chat deployment is configured.
 * The pipeline treats text expansion as opt-in: if the user hasn't
 * provisioned a chat model, the run still succeeds — the orchestrator
 * just skips the expansion pass and emits a warning. That keeps the
 * core "generate sprites from a brief" path runnable on systems that
 * only have image creds set up.
 */
export declare function createTextProvider(options?: CreateProviderOptions): TextProvider | null;
/**
 * Build a {@link VisionProvider} for the local-only VLM judge.
 *
 * Returns `null` when no vision deployment is configured. Unlike the
 * text provider, the orchestrator does NOT silently degrade when the
 * judge is requested but unavailable — it throws. That decision lives
 * in `generate-one.ts` so the factory stays a thin wiring layer; here
 * we just answer "is a vision provider available right now?".
 *
 * Sprite-judge calls hit a separate vision-capable Azure deployment
 * (`AZURE_OPENAI_VISION_DEPLOYMENT`) which may not be provisioned on
 * every developer machine. Returning null lets callers that don't need
 * the judge (most briefs default to `judge.enabled: false`) skip the
 * check entirely.
 */
export declare function createVisionProvider(
  options?: CreateProviderOptions,
): VisionProvider | null;
/**
 * Build a {@link SynthProvider} for brief synthesis. Unlike the
 * variation-expansion text provider this one THROWS when the chat
 * deployment is missing — synthesis is the entire point of the
 * `sprites:synth` command, so a missing deployment is a configuration
 * error the user must fix, not a graceful-degrade scenario.
 */
export declare function createSynthProvider(options?: CreateProviderOptions): SynthProvider;
//# sourceMappingURL=factory.d.ts.map
