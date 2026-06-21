import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  getGlobalLogLevel,
  setGlobalLogLevel,
  type LogLevel,
} from '../../src/shared/logger';

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];

describe('logger', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore a predictable level for any later tests in the suite.
    setGlobalLogLevel('warn');
  });

  it('createLogger returns a logger with the expected methods', () => {
    const logger = createLogger('test-scope');
    for (const method of [
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'setLevel',
      'getLevel',
    ] as const) {
      expect(typeof logger[method]).toBe('function');
    }
  });

  it('setGlobalLogLevel round-trips through getGlobalLogLevel for every level', () => {
    for (const level of LEVELS) {
      setGlobalLogLevel(level);
      expect(getGlobalLogLevel()).toBe(level);
    }
  });

  it('propagates the global level to scoped loggers created earlier', () => {
    const logger = createLogger('propagation');
    setGlobalLogLevel('error');
    // loglevel encodes error as numeric level 4.
    expect(logger.getLevel()).toBe(4);
  });

  it('persists the level to window.localStorage when available', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
    });
    setGlobalLogLevel('debug');
    expect(store.get('crawler.logLevel')).toBe('debug');
  });

  it('ignores localStorage write failures (e.g. private-mode quota errors)', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    });
    expect(() => setGlobalLogLevel('info')).not.toThrow();
  });

  it('reads the initial level from the logLevel query param at import time', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {
      location: { search: '?logLevel=error' },
      localStorage: { getItem: () => null, setItem: () => {} },
    });
    const mod = await import('../../src/shared/logger');
    expect(mod.getGlobalLogLevel()).toBe('error');
  });

  it('falls back to the stored localStorage level when no query param is set', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: { getItem: () => 'debug', setItem: () => {} },
    });
    const mod = await import('../../src/shared/logger');
    expect(mod.getGlobalLogLevel()).toBe('debug');
  });

  it('tolerates a throwing localStorage.getItem during init', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {},
      },
    });
    const mod = await import('../../src/shared/logger');
    // No query param / readable storage → quiet-env fallback (VITEST=true) → warn.
    expect(LEVELS).toContain(mod.getGlobalLogLevel());
  });
});
