/**
 * Unit tests for the shared provider request-timeout helpers.
 *
 * These are pure functions, so the tests cover env parsing (including the
 * "never silently disable the timeout" fallback rules), abort-error detection,
 * and the operator-facing message.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  MIN_PROVIDER_TIMEOUT_MS,
  isTimeoutAbortError,
  providerTimeoutMessage,
  resolveProviderTimeoutMs,
} from '../../../scripts/sprites/provider/fetch-timeout.js';

describe('resolveProviderTimeoutMs', () => {
  it('returns the default when the env var is unset', () => {
    expect(resolveProviderTimeoutMs({})).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
  });

  it('returns the provided fallback when the env var is unset', () => {
    expect(resolveProviderTimeoutMs({}, 5_000)).toBe(5_000);
  });

  it('parses a valid numeric override and floors it to an integer', () => {
    expect(resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: '30000' })).toBe(30_000);
    expect(resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: '1500.9' })).toBe(1_500);
  });

  it('falls back when the value is blank, non-numeric, or NaN', () => {
    expect(resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: '' })).toBe(
      DEFAULT_PROVIDER_TIMEOUT_MS,
    );
    expect(resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: '   ' })).toBe(
      DEFAULT_PROVIDER_TIMEOUT_MS,
    );
    expect(resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: 'soon' })).toBe(
      DEFAULT_PROVIDER_TIMEOUT_MS,
    );
  });

  it('falls back when the value is below the floor (never disables the timeout)', () => {
    expect(resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: '0' })).toBe(
      DEFAULT_PROVIDER_TIMEOUT_MS,
    );
    expect(
      resolveProviderTimeoutMs({
        SPRITES_PROVIDER_TIMEOUT_MS: String(MIN_PROVIDER_TIMEOUT_MS - 1),
      }),
    ).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: '-5000' })).toBe(
      DEFAULT_PROVIDER_TIMEOUT_MS,
    );
  });

  it('accepts a value exactly at the floor', () => {
    expect(
      resolveProviderTimeoutMs({ SPRITES_PROVIDER_TIMEOUT_MS: String(MIN_PROVIDER_TIMEOUT_MS) }),
    ).toBe(MIN_PROVIDER_TIMEOUT_MS);
  });
});

describe('isTimeoutAbortError', () => {
  it('is true for a TimeoutError (AbortSignal.timeout) and AbortError', () => {
    expect(isTimeoutAbortError({ name: 'TimeoutError' })).toBe(true);
    expect(isTimeoutAbortError({ name: 'AbortError' })).toBe(true);
    const domLike = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(isTimeoutAbortError(domLike)).toBe(true);
  });

  it('is false for unrelated errors and non-objects', () => {
    expect(isTimeoutAbortError(new Error('socket hangup'))).toBe(false);
    expect(isTimeoutAbortError({ name: 'TypeError' })).toBe(false);
    expect(isTimeoutAbortError(null)).toBe(false);
    expect(isTimeoutAbortError('TimeoutError')).toBe(false);
    expect(isTimeoutAbortError(undefined)).toBe(false);
  });
});

describe('providerTimeoutMessage', () => {
  it('names the call site, the timeout, and the env override knob', () => {
    const msg = providerTimeoutMessage('Azure images/edits', 120_000);
    expect(msg).toContain('Azure images/edits');
    expect(msg).toContain('120000ms');
    expect(msg).toContain('timed out');
    expect(msg).toContain('SPRITES_PROVIDER_TIMEOUT_MS');
  });
});
