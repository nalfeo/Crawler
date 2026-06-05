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

import { AzureOpenAIImageProvider } from './azure-openai.js';
import { AzureOpenAIChatProvider } from './azure-chat.js';
import type { ImageProvider } from './types.js';
import type { TextProvider } from './text-types.js';

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
}

const DEFAULT_AZURE_API_VERSION = '2025-04-01-preview';
const DEFAULT_AZURE_DEPLOYMENT = 'gpt-image-1';

export function createImageProvider(options: CreateProviderOptions = {}): ImageProvider {
  const env = options.env ?? process.env;
  const which = (env.SPRITES_PROVIDER ?? 'azure-openai').toLowerCase();

  if (which === 'azure-openai') {
    return createAzureProvider(env, options.fetch);
  }
  throw new Error(
    `Unknown SPRITES_PROVIDER '${which}'. Supported values: azure-openai. ` +
      `(MAI provider is planned — see scripts/sprites/provider/azure-openai.ts TODO.)`,
  );
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
  const which = (env.SPRITES_TEXT_PROVIDER ?? 'azure-openai').toLowerCase();
  if (which === 'none') return null;
  if (which === 'azure-openai') {
    return createAzureChatProvider(env, options.fetch);
  }
  throw new Error(
    `Unknown SPRITES_TEXT_PROVIDER '${which}'. Supported values: azure-openai, none.`,
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
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function createAzureChatProvider(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): TextProvider | null {
  // Chat deployment is the gate: if the user hasn't named one, treat
  // text expansion as unavailable rather than failing the whole run.
  const deployment = env.AZURE_OPENAI_CHAT_DEPLOYMENT;
  if (!deployment) return null;
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  const apiKey = env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) return null;
  const apiVersion = env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION;
  return new AzureOpenAIChatProvider({
    endpoint,
    deployment,
    apiKey,
    apiVersion,
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
