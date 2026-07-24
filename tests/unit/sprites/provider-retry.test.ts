import { describe, expect, it, vi } from 'vitest';
import {
  fetchWithProviderRetry,
  parseRetryAfterMs,
} from '../../../scripts/sprites/provider/provider-retry.js';

describe('fetchWithProviderRetry', () => {
  it('honors retry-after-ms before retrying a 429', async () => {
    const sleep = vi.fn(async () => {});
    const request = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after-ms': '250', 'retry-after': '9' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await fetchWithProviderRetry(request, {
      maxAttempts: 2,
      sleep,
      random: () => 0,
    });

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('retries network failures with injected jittered backoff', async () => {
    const sleep = vi.fn(async () => {});
    const request = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await expect(
      fetchWithProviderRetry(request, {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        sleep,
        random: () => 0.5,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it('retries 5xx responses with bounded jittered backoff', async () => {
    const sleep = vi.fn(async () => {});
    const request = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await fetchWithProviderRetry(request, {
      maxAttempts: 2,
      baseDelayMs: 200,
      sleep,
      random: () => 0,
    });

    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '1.5' }))).toBe(1_500);
    expect(
      parseRetryAfterMs(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:02 GMT' }), () => 500),
    ).toBe(1_500);
  });

  it('does not retry deterministic 4xx responses', async () => {
    const sleep = vi.fn(async () => {});
    const request = vi.fn(async () => new Response('bad request', { status: 400 }));

    const response = await fetchWithProviderRetry(request, { sleep });

    expect(response.status).toBe(400);
    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns the terminal response when the retry hint exceeds the total wait budget', async () => {
    const request = vi.fn(
      async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after-ms': '5000' },
        }),
    );

    const response = await fetchWithProviderRetry(request, {
      maxAttempts: 3,
      maxTotalDelayMs: 1_000,
    });

    expect(response.status).toBe(429);
    expect(request).toHaveBeenCalledOnce();
    expect(parseRetryAfterMs(response.headers)).toBe(5_000);
  });
});
