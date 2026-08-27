import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion } from '../../src/engine/reduced-motion.js';

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails closed to false when window is undefined (headless/Node)', () => {
    vi.stubGlobal('window', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('fails closed to false when window.matchMedia is not a function (jsdom without matchMedia)', () => {
    vi.stubGlobal('window', {});
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns true when the media query matches', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn((query: string) => ({ media: query, matches: true })),
    });
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when the media query does not match', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false })),
    });
    expect(prefersReducedMotion()).toBe(false);
  });

  it('fails closed to false when matchMedia throws', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => {
        throw new Error('matchMedia unsupported');
      }),
    });
    expect(prefersReducedMotion()).toBe(false);
  });
});
