import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LocalStorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

describe('global controls config', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).window = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      } as LocalStorageMock,
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  it('defaults to joystick mode', async () => {
    vi.resetModules();
    const { getGlobalControlsConfig } = await import('../../src/engine/controls-config.js');
    expect(getGlobalControlsConfig().mobileMoveMode).toBe('joystick');
  });

  it('persists follow mode updates', async () => {
    vi.resetModules();
    const { getGlobalControlsConfig, setGlobalControlsConfig } =
      await import('../../src/engine/controls-config.js');

    setGlobalControlsConfig({ mobileMoveMode: 'follow' });
    expect(getGlobalControlsConfig().mobileMoveMode).toBe('follow');
    expect(storage.get('crawler:global-controls-config')).toContain('"mobileMoveMode":"follow"');
  });
});
