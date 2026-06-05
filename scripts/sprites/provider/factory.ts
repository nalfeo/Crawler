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
import type { ImageProvider } from './types.js';

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
