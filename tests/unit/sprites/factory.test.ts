/**
 * Tests for the chat-deployment alias fallback in the provider factory.
 *
 * Background: developer `.env` files for the sprite pipeline frequently
 * set only `AZURE_OPENAI_VISION_DEPLOYMENT` (the judge uses it) but
 * point at a gpt-4o-class deployment that also serves chat completions.
 * The factory falls back to that vision deployment when
 * `AZURE_OPENAI_CHAT_DEPLOYMENT` is missing so synth and variation
 * expansion don't break with a confusing "missing env var" error.
 *
 * These tests stub `fetch` and pull the warning sink through
 * `CreateProviderOptions.warn` so we never touch the real console or
 * the real Azure endpoint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetChatDeploymentFallbackWarnings,
  createBriefSelectorProvider,
  createImageProvider,
  createSynthProvider,
  createTextProvider,
  createVisionProvider,
} from '../../../scripts/sprites/provider/factory.js';

const BASE_ENV = {
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_API_KEY: 'k',
} as const;

const FOUNDRY_ENV = {
  FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com',
  FOUNDRY_API_KEY: 'fk',
} as const;

afterEach(() => {
  __resetChatDeploymentFallbackWarnings();
});

describe('createTextProvider — chat deployment fallback', () => {
  it('uses AZURE_OPENAI_CHAT_DEPLOYMENT when present and does NOT warn', () => {
    const warn = vi.fn<(message: string) => void>();
    const p = createTextProvider({
      env: {
        ...BASE_ENV,
        AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat-prod',
        AZURE_OPENAI_VISION_DEPLOYMENT: 'vision-prod',
      },
      warn,
    });
    expect(p).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to AZURE_OPENAI_VISION_DEPLOYMENT when CHAT is missing and warns once', () => {
    const warn = vi.fn<(message: string) => void>();
    const p = createTextProvider({
      env: { ...BASE_ENV, AZURE_OPENAI_VISION_DEPLOYMENT: 'gpt-4o' },
      warn,
    });
    expect(p).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toMatch(/AZURE_OPENAI_CHAT_DEPLOYMENT/);
    expect(message).toMatch(/AZURE_OPENAI_VISION_DEPLOYMENT/);
    expect(message).toMatch(/gpt-4o/);
  });

  it('only warns once for the same deployment across repeated factory calls', () => {
    const warn = vi.fn<(message: string) => void>();
    const env = { ...BASE_ENV, AZURE_OPENAI_VISION_DEPLOYMENT: 'gpt-4o' };
    createTextProvider({ env, warn });
    createTextProvider({ env, warn });
    createTextProvider({ env, warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null when neither CHAT nor VISION deployment is set', () => {
    const warn = vi.fn<(message: string) => void>();
    const p = createTextProvider({ env: BASE_ENV, warn });
    expect(p).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('createSynthProvider — chat deployment fallback', () => {
  it('uses AZURE_OPENAI_CHAT_DEPLOYMENT when present and does NOT warn', () => {
    const warn = vi.fn<(message: string) => void>();
    expect(() =>
      createSynthProvider({
        env: {
          ...BASE_ENV,
          AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat-prod',
          AZURE_OPENAI_VISION_DEPLOYMENT: 'vision-prod',
        },
        warn,
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  describe('createBriefSelectorProvider', () => {
    it('allows selector deployment to match synth deployment', () => {
      const provider = createBriefSelectorProvider({
        env: {
          ...BASE_ENV,
          AZURE_OPENAI_CHAT_DEPLOYMENT: 'same-deploy',
          AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT: 'same-deploy',
        },
      });
      expect(provider).not.toBeNull();
    });
  });

  it('falls back to AZURE_OPENAI_VISION_DEPLOYMENT when CHAT is missing and warns', () => {
    const warn = vi.fn<(message: string) => void>();
    expect(() =>
      createSynthProvider({
        env: { ...BASE_ENV, AZURE_OPENAI_VISION_DEPLOYMENT: 'gpt-4o' },
        warn,
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when neither CHAT nor VISION deployment is set', () => {
    const warn = vi.fn<(message: string) => void>();
    expect(() => createSynthProvider({ env: BASE_ENV, warn })).toThrow(
      /AZURE_OPENAI_CHAT_DEPLOYMENT.*AZURE_OPENAI_VISION_DEPLOYMENT/s,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('foundry backend (ADR 0033)', () => {
  it('createImageProvider builds from FOUNDRY_* when SPRITES_PROVIDER=foundry', () => {
    const p = createImageProvider({
      env: { ...FOUNDRY_ENV, SPRITES_PROVIDER: 'foundry', FOUNDRY_IMAGE_MODEL: 'FLUX.1' },
    });
    expect(p).not.toBeNull();
  });

  it('createImageProvider throws when foundry connection is incomplete', () => {
    expect(() =>
      createImageProvider({ env: { SPRITES_PROVIDER: 'foundry', FOUNDRY_IMAGE_MODEL: 'FLUX.1' } }),
    ).toThrow(/FOUNDRY_ENDPOINT/);
  });

  it('createTextProvider builds a foundry chat provider when FOUNDRY_TEXT_MODEL is set', () => {
    const p = createTextProvider({
      env: {
        ...FOUNDRY_ENV,
        SPRITES_TEXT_PROVIDER: 'foundry',
        FOUNDRY_TEXT_MODEL: 'Llama-3.3-70B',
      },
    });
    expect(p).not.toBeNull();
  });

  it('createTextProvider returns null when foundry text model is unconfigured', () => {
    expect(
      createTextProvider({ env: { ...FOUNDRY_ENV, SPRITES_TEXT_PROVIDER: 'foundry' } }),
    ).toBeNull();
  });

  it('createVisionProvider returns null when foundry vision model is unconfigured', () => {
    expect(
      createVisionProvider({ env: { ...FOUNDRY_ENV, SPRITES_VISION_PROVIDER: 'foundry' } }),
    ).toBeNull();
  });

  it('createSynthProvider labels candidates with the foundry prefix', () => {
    const p = createSynthProvider({
      env: { ...FOUNDRY_ENV, SPRITES_SYNTH_PROVIDER: 'foundry', FOUNDRY_TEXT_MODEL: 'Mistral' },
    });
    expect(p.providerLabel).toBe('foundry:Mistral');
  });

  it('createBriefSelectorProvider throws when selector model equals synth model', () => {
    expect(() =>
      createBriefSelectorProvider({
        env: {
          ...FOUNDRY_ENV,
          SPRITES_SYNTH_PROVIDER: 'foundry',
          FOUNDRY_TEXT_MODEL: 'same',
          FOUNDRY_BRIEF_SELECTOR_MODEL: 'same',
        },
      }),
    ).toThrow(/must differ/);
  });

  it('rejects an unknown backend value', () => {
    expect(() => createImageProvider({ env: { SPRITES_PROVIDER: 'bedrock' } })).toThrow(
      /Unknown SPRITES_PROVIDER/,
    );
  });
});
