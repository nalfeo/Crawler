/**
 * Provider factory.
 *
 * Reads environment variables and constructs an {@link ImageProvider}. The
 * orchestrator and CLI use this to avoid sprinkling env reads through the
 * codebase, and to give tests a clean construct-from-options path that
 * bypasses env entirely.
 *
 * Supports three backends for image generation:
 * - `azure-openai` (default, direct Azure OpenAI resource; ADR 0072)
 * - `foundry` (Azure AI Foundry OpenAI-compatible image deployments)
 * - `local-a1111` (local Stable Diffusion WebUI A1111/Forge fork)
 *
 * Switch on `SPRITES_PROVIDER` / `SPRITES_TEXT_PROVIDER` /
 * `SPRITES_VISION_PROVIDER` / `SPRITES_SYNTH_PROVIDER` here.
 */

import { AzureOpenAIImageProvider } from './azure-openai.js';
import { AzureOpenAIChatProvider } from './azure-chat.js';
import { AzureOpenAIBriefSelectorProvider } from './azure-chat-brief-selector.js';
import { AzureOpenAISynthProvider } from './azure-chat-synth.js';
import { AzureOpenAIVisionProvider } from './azure-vision.js';
import { LocalA1111ImageProvider } from './local-a1111.js';
import { resolveProviderTimeoutMs } from './fetch-timeout.js';
import type { ImageProvider } from './types.js';
import type { BriefSelectorProvider } from './brief-selector-types.js';
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

const DEFAULT_AZURE_API_VERSION = '2025-04-01-preview';
/**
 * Baseline Azure image deployment used when `AZURE_OPENAI_IMAGE_DEPLOYMENT` is
 * unset. Exported so the `sprites:run` `--model` allowlist can include the
 * default/baseline deployment — otherwise the flag would be strictly more
 * restrictive than the env var and could not target (or benchmark against) the
 * baseline.
 */
export const DEFAULT_AZURE_DEPLOYMENT = 'gpt-image-1';

/**
 * Supported content-generation backends. `azure-openai` hits a direct Azure
 * OpenAI resource, `foundry` hits an Azure AI Foundry OpenAI-compatible image
 * deployment, and `local-a1111` hits a local Stable Diffusion WebUI.
 */
const SUPPORTED_BACKENDS = ['azure-openai', 'foundry', 'local-a1111'] as const;
type Backend = (typeof SUPPORTED_BACKENDS)[number];

function resolveBackend(value: string | undefined, varName: string): Backend {
  const which = (value ?? 'azure-openai').toLowerCase();
  if ((SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(which)) return which as Backend;
  throw new Error(
    `Unknown ${varName} '${which}'. Supported values: ${SUPPORTED_BACKENDS.join(', ')}.`,
  );
}

/**
 * Resolve the Azure OpenAI **chat** deployment from the environment,
 * with a graceful fallback to the **vision** deployment.
 *
 * Why the alias exists: every Azure OpenAI deployment we provision
 * today is the same `gpt-4o`-class model and serves both chat and
 * vision requests. Several developer `.env` files set only
 * `AZURE_OPENAI_VISION_DEPLOYMENT` (judge.ts is the loudest consumer)
 * which left synth and the variation expander dead in the water with
 * a confusing "Missing required env var AZURE_OPENAI_CHAT_DEPLOYMENT"
 * error. Falling back is safe because the deployments are
 * functionally identical for our prompts, and we emit a one-shot
 * warning so the user knows to add the alias to their env file when
 * convenient.
 *
 * Returns `null` when neither variable is set.
 */
function resolveChatDeployment(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): { deployment: string; fromFallback: boolean } | null {
  const chat = env.AZURE_OPENAI_CHAT_DEPLOYMENT;
  if (chat) return { deployment: chat, fromFallback: false };
  const vision = env.AZURE_OPENAI_VISION_DEPLOYMENT;
  if (!vision) return null;
  warnChatDeploymentFallbackOnce(vision, warn);
  return { deployment: vision, fromFallback: true };
}

/**
 * Module-level guard so we only emit the chat-deployment alias
 * warning once per unique deployment, no matter how many provider
 * objects we construct. Exported under a `__` prefix for test resets;
 * intentionally not part of the public surface.
 */
const warnedFallbackDeployments = new Set<string>();
export function __resetChatDeploymentFallbackWarnings(): void {
  warnedFallbackDeployments.clear();
}
function warnChatDeploymentFallbackOnce(deployment: string, warn: (message: string) => void): void {
  if (warnedFallbackDeployments.has(deployment)) return;
  warnedFallbackDeployments.add(deployment);
  warn(
    `AZURE_OPENAI_CHAT_DEPLOYMENT is not set; falling back to ` +
      `AZURE_OPENAI_VISION_DEPLOYMENT='${deployment}'. ` +
      `These typically point at the same gpt-4o-class deployment; add ` +
      `AZURE_OPENAI_CHAT_DEPLOYMENT='${deployment}' to your env file to ` +
      `silence this warning. See docs/agent-os/sprite-style.md for details.`,
  );
}

export function createImageProvider(options: CreateProviderOptions = {}): ImageProvider {
  const env = options.env ?? process.env;
  const which = resolveBackend(env.SPRITES_PROVIDER, 'SPRITES_PROVIDER');

  if (which === 'local-a1111') {
    return createLocalA1111ImageProvider(env, options.fetch);
  }
  if (which === 'foundry') {
    return createFoundryImageProvider(env, options.fetch);
  }
  return createAzureProvider(env, options.fetch);
}

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
export function createTextProvider(options: CreateProviderOptions = {}): TextProvider | null {
  const env = options.env ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const which = (env.SPRITES_TEXT_PROVIDER ?? 'azure-openai').toLowerCase();
  if (which === 'none') return null;
  if (which === 'azure-openai') {
    return createAzureChatProvider(env, warn, options.fetch);
  }
  throw new Error(
    `Unknown SPRITES_TEXT_PROVIDER '${which}'. Supported values: azure-openai, none.`,
  );
}

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
export function createVisionProvider(options: CreateProviderOptions = {}): VisionProvider | null {
  const env = options.env ?? process.env;
  const which = (env.SPRITES_VISION_PROVIDER ?? 'azure-openai').toLowerCase();
  if (which === 'none') return null;
  if (which === 'azure-openai') {
    return createAzureVisionProvider(env, options.fetch);
  }
  throw new Error(
    `Unknown SPRITES_VISION_PROVIDER '${which}'. Supported values: azure-openai, none.`,
  );
}

function createAzureProvider(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): ImageProvider {
  const endpoint = required(env, 'AZURE_OPENAI_ENDPOINT');
  const apiKey = required(env, 'AZURE_OPENAI_API_KEY');
  const deployment = env.AZURE_OPENAI_IMAGE_DEPLOYMENT ?? DEFAULT_AZURE_DEPLOYMENT;
  const apiVersion = env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION;
  return new AzureOpenAIImageProvider({
    endpoint,
    deployment,
    apiKey,
    apiVersion,
    timeoutMs: resolveProviderTimeoutMs(env),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function createFoundryImageProvider(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): ImageProvider {
  const endpoint = required(env, 'FOUNDRY_ENDPOINT');
  const apiKey = required(env, 'FOUNDRY_API_KEY');
  const deployment = required(env, 'FOUNDRY_IMAGE_MODEL');
  const apiVersion = env.FOUNDRY_API_VERSION ?? DEFAULT_AZURE_API_VERSION;
  return new AzureOpenAIImageProvider({
    endpoint,
    deployment,
    apiKey,
    apiVersion,
    timeoutMs: resolveProviderTimeoutMs(env),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function createLocalA1111ImageProvider(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): ImageProvider {
  const endpoint = env.LOCAL_A1111_ENDPOINT ?? 'http://localhost:7860';
  const model = required(env, 'LOCAL_A1111_MODEL');
  const steps = env.LOCAL_A1111_STEPS ? parseInt(env.LOCAL_A1111_STEPS, 10) : undefined;
  const cfgScale = env.LOCAL_A1111_CFG_SCALE ? parseFloat(env.LOCAL_A1111_CFG_SCALE) : undefined;
  const sampler = env.LOCAL_A1111_SAMPLER;
  const seed = env.LOCAL_A1111_SEED ? parseInt(env.LOCAL_A1111_SEED, 10) : undefined;
  const negativePrompt = env.LOCAL_A1111_NEGATIVE_PROMPT;
  return new LocalA1111ImageProvider({
    endpoint,
    model,
    timeoutMs: resolveProviderTimeoutMs(env),
    steps,
    cfgScale,
    sampler,
    seed,
    negativePrompt,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function createAzureChatProvider(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
  fetchImpl?: typeof fetch,
): TextProvider | null {
  // Chat deployment is the gate: if the user hasn't named one (and
  // there's no vision-deployment alias to fall back to), treat text
  // expansion as unavailable rather than failing the whole run.
  const resolved = resolveChatDeployment(env, warn);
  if (!resolved) return null;
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) return null;
  const apiVersion = env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION;
  return new AzureOpenAIChatProvider({
    endpoint,
    deployment: resolved.deployment,
    apiKey,
    apiVersion,
    timeoutMs: resolveProviderTimeoutMs(env),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/**
 * Build a {@link SynthProvider} for brief synthesis. Unlike the
 * variation-expansion text provider this one THROWS when the chat
 * deployment is missing — synthesis is the entire point of the
 * `sprites:synth` command, so a missing deployment is a configuration
 * error the user must fix, not a graceful-degrade scenario.
 */
export function createSynthProvider(options: CreateProviderOptions = {}): SynthProvider {
  const config = resolveAzureChatConfig(options);
  return new AzureOpenAISynthProvider({
    endpoint: config.endpoint,
    deployment: config.deployment,
    apiKey: config.apiKey,
    apiVersion: config.apiVersion,
    timeoutMs: config.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export interface AzureChatConfig {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
}

/**
 * Resolve the Azure OpenAI chat-completions connection used by every
 * structured-text caller (brief synthesis, theme roster proposal).
 * Throws with an actionable message when the environment is not
 * configured — these callers exist to make chat calls, so a missing
 * deployment is a configuration error, not a degrade-gracefully case.
 */
export function resolveAzureChatConfig(options: CreateProviderOptions = {}): AzureChatConfig {
  const env = options.env ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const which = resolveBackend(
    env.SPRITES_SYNTH_PROVIDER ?? env.SPRITES_TEXT_PROVIDER,
    'SPRITES_SYNTH_PROVIDER',
  );
  if (which === 'foundry') {
    throw new Error(
      'Foundry synthesis is not restored yet; use SPRITES_SYNTH_PROVIDER=azure-openai.',
    );
  }
  if (which === 'local-a1111') {
    throw new Error(
      `local-a1111 does not support synthesis. Set SPRITES_SYNTH_PROVIDER to azure-openai.`,
    );
  }
  const endpoint = required(env, 'AZURE_OPENAI_ENDPOINT');
  const apiKey = required(env, 'AZURE_OPENAI_API_KEY');
  const resolved = resolveChatDeployment(env, warn);
  if (!resolved) {
    throw new Error(
      `Missing required env var 'AZURE_OPENAI_CHAT_DEPLOYMENT' (or its ` +
        `'AZURE_OPENAI_VISION_DEPLOYMENT' alias). Set one of them before ` +
        `running the sprite synthesiser. See docs/agent-os/sprite-style.md ` +
        `for the expected list.`,
    );
  }
  return {
    endpoint,
    deployment: resolved.deployment,
    apiKey,
    apiVersion: env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION,
    timeoutMs: resolveProviderTimeoutMs(env),
  };
}

export function createBriefSelectorProvider(
  options: CreateProviderOptions = {},
): BriefSelectorProvider | null {
  const env = options.env ?? process.env;
  const which = resolveBackend(
    env.SPRITES_SYNTH_PROVIDER ?? env.SPRITES_TEXT_PROVIDER,
    'SPRITES_SYNTH_PROVIDER',
  );
  if (which === 'foundry') {
    throw new Error(
      'Foundry brief selection is not restored yet; use SPRITES_SYNTH_PROVIDER=azure-openai.',
    );
  }
  if (which === 'local-a1111') return null;
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  const selectorDeployment = env.AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT;
  if (!endpoint || !apiKey || !selectorDeployment) return null;
  const apiVersion = env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION;
  return new AzureOpenAIBriefSelectorProvider({
    endpoint,
    deployment: selectorDeployment,
    apiKey,
    apiVersion,
    timeoutMs: resolveProviderTimeoutMs(env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

function createAzureVisionProvider(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): VisionProvider | null {
  // Vision deployment is the gate: if the user hasn't named one, the
  // judge is unavailable. Endpoint/key check matches the chat provider —
  // we don't want to throw at factory time just because someone is
  // running a brief that doesn't even use the judge.
  const deployment = env.AZURE_OPENAI_VISION_DEPLOYMENT;
  if (!deployment) return null;
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) return null;
  const apiVersion = env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION;
  return new AzureOpenAIVisionProvider({
    endpoint,
    deployment,
    apiKey,
    apiVersion,
    timeoutMs: resolveProviderTimeoutMs(env),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `Missing required env var '${name}'. Set it before running the sprite generator. ` +
        `See docs/agent-os/personas/graphics-designer.md for the expected list.`,
    );
  }
  return v;
}

function defaultWarn(message: string): void {
  console.warn(message);
}
