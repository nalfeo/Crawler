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

describe('Foundry image backend', () => {
  it('builds from FOUNDRY_* when SPRITES_PROVIDER=foundry', () => {
    const provider = createImageProvider({
      env: {
        SPRITES_PROVIDER: 'foundry',
        FOUNDRY_ENDPOINT: 'https://swedencentral.api.cognitive.microsoft.com',
        FOUNDRY_API_KEY: 'foundry-key',
        FOUNDRY_IMAGE_MODEL: 'bench-gpt-image-2',
      },
    });
    expect(provider).not.toBeNull();
  });

  it('requires the Foundry image deployment alias', () => {
    expect(() =>
      createImageProvider({
        env: {
          SPRITES_PROVIDER: 'foundry',
          FOUNDRY_ENDPOINT: 'https://swedencentral.api.cognitive.microsoft.com',
          FOUNDRY_API_KEY: 'foundry-key',
        },
      }),
    ).toThrow(/FOUNDRY_IMAGE_MODEL/);
  });
});

describe('unknown backend rejection', () => {
  it('rejects foundry for text providers until their API contract is restored', () => {
    expect(() => createTextProvider({ env: { SPRITES_TEXT_PROVIDER: 'foundry' } })).toThrow(
      /Unknown SPRITES_TEXT_PROVIDER/,
    );
  });

  it('rejects foundry for vision providers until their API contract is restored', () => {
    expect(() => createVisionProvider({ env: { SPRITES_VISION_PROVIDER: 'foundry' } })).toThrow(
      /Unknown SPRITES_VISION_PROVIDER/,
    );
  });

  it('rejects foundry for synthesis providers until their API contract is restored', () => {
    expect(() => createSynthProvider({ env: { SPRITES_SYNTH_PROVIDER: 'foundry' } })).toThrow(
      /Foundry synthesis is not restored/,
    );
  });

  it('rejects foundry for brief selector providers until their API contract is restored', () => {
    expect(() =>
      createBriefSelectorProvider({ env: { SPRITES_SYNTH_PROVIDER: 'foundry' } }),
    ).toThrow(/Foundry brief selection is not restored/);
  });

  it('rejects other unknown backend values too', () => {
    expect(() => createImageProvider({ env: { SPRITES_PROVIDER: 'bedrock' } })).toThrow(
      /Unknown SPRITES_PROVIDER/,
    );
  });
});

describe('local-a1111 backend', () => {
  it('createImageProvider builds when SPRITES_PROVIDER=local-a1111 and LOCAL_A1111_MODEL is set', () => {
    const p = createImageProvider({
      env: { SPRITES_PROVIDER: 'local-a1111', LOCAL_A1111_MODEL: 'sd_xl_turbo' },
    });
    expect(p).not.toBeNull();
  });

  it('createImageProvider throws when LOCAL_A1111_MODEL is missing', () => {
    expect(() => createImageProvider({ env: { SPRITES_PROVIDER: 'local-a1111' } })).toThrow(
      /LOCAL_A1111_MODEL/,
    );
  });
});
