/**
 * Azure OpenAI chat caller for theme roster proposals.
 *
 * Deliberately thin: roster synthesis needs one structured-JSON
 * completion, not the candidate-shaped response the brief synthesiser
 * negotiates. Rather than widen `AzureOpenAISynthProvider` with a
 * second response shape, this returns the raw assistant text and lets
 * `theme-roster-synth.ts` own all parsing and validation — so the
 * deterministic coverage gate stays the single judge.
 */

import { resolveAzureChatConfig, type CreateProviderOptions } from './factory.js';
import { isTimeoutAbortError, providerTimeoutMessage } from './fetch-timeout.js';
import { fetchWithProviderRetry } from './provider-retry.js';
import type { ThemeRosterChatCaller } from '../theme-roster-synth.js';

/** Roster proposals are ~20 short objects; 2000 tokens is ample headroom. */
const MAX_TOKENS = 2000;
/** Lower than brief synthesis (0.85): we want plausible gear, not novelty. */
const TEMPERATURE = 0.6;

export function createAzureThemeRosterChatCaller(
  options: CreateProviderOptions = {},
): ThemeRosterChatCaller {
  const config = resolveAzureChatConfig(options);
  const fetchImpl = options.fetch ?? fetch;
  const url =
    `${config.endpoint.replace(/\/+$/, '')}/openai/deployments/` +
    `${encodeURIComponent(config.deployment)}/chat/completions` +
    `?api-version=${encodeURIComponent(config.apiVersion)}`;

  return async ({ system, user }) => {
    let response: Response;
    try {
      response = await fetchWithProviderRetry(
        () =>
          fetchImpl(url, {
            method: 'POST',
            headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              temperature: TEMPERATURE,
              max_tokens: MAX_TOKENS,
              response_format: { type: 'json_object' },
            }),
            signal: AbortSignal.timeout(config.timeoutMs),
          }),
        {},
      );
    } catch (error) {
      if (isTimeoutAbortError(error)) {
        throw new Error(providerTimeoutMessage('theme roster synthesis', config.timeoutMs), {
          cause: error,
        });
      }
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Azure chat completion failed with ${response.status} ${response.statusText}${
          detail ? `: ${detail.slice(0, 500)}` : ''
        }`,
      );
    }

    const payload = (await response.json()) as {
      choices?: ReadonlyArray<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Azure chat completion returned no message content.');
    }
    return content;
  };
}
