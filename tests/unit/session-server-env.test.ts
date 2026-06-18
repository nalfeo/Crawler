import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSpriteSidecarBaseUrl } from '../../src/shared/session-server-env.js';

const ORIGINAL_SIDE_CAR = process.env.VITE_SPRITES_SIDECAR_BASE_URL;

afterEach(() => {
  if (ORIGINAL_SIDE_CAR === undefined) {
    delete process.env.VITE_SPRITES_SIDECAR_BASE_URL;
  } else {
    process.env.VITE_SPRITES_SIDECAR_BASE_URL = ORIGINAL_SIDE_CAR;
  }
  vi.restoreAllMocks();
});

describe('getSpriteSidecarBaseUrl', () => {
  it('uses VITE_SPRITES_SIDECAR_BASE_URL from process env when set', () => {
    process.env.VITE_SPRITES_SIDECAR_BASE_URL = 'http://127.0.0.1:20230';
    expect(getSpriteSidecarBaseUrl()).toBe('http://127.0.0.1:20230');
  });

  it('falls back to the legacy local sidecar URL when env is missing', () => {
    delete process.env.VITE_SPRITES_SIDECAR_BASE_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getSpriteSidecarBaseUrl()).toBe('http://127.0.0.1:3010');
    expect(warn).toHaveBeenCalled();
  });
});
