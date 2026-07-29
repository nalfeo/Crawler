import { describe, expect, it, vi } from 'vitest';

import { generatedManifestPlugin } from '../../../tools/vite-plugin-generated-manifest.js';

type Middleware = (req: { url?: string }, res: FakeRes, next: (err?: unknown) => void) => void;

interface FakeRes {
  headers: Record<string, string>;
  body?: string;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function fakeRes(): FakeRes {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** Capture the dev middleware the plugin registers via configureServer. */
function captureMiddleware(): Middleware {
  const plugin = generatedManifestPlugin();
  let captured: Middleware | undefined;
  const server = {
    middlewares: {
      use(mw: Middleware) {
        captured = mw;
      },
    },
  };
  // configureServer is typed against Vite's ViteDevServer; the plugin only
  // touches `middlewares.use`, so a structural stub is sufficient.
  (plugin.configureServer as unknown as (s: typeof server) => void)(server);
  if (!captured) throw new Error('plugin did not register a middleware');
  return captured;
}

describe('generatedManifestPlugin dev middleware', () => {
  it('serves a valid, non-empty aggregate manifest for the manifest URL', () => {
    const mw = captureMiddleware();
    const res = fakeRes();
    const next = vi.fn();

    mw({ url: '/assets/generated/manifest.json' }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(res.headers['Cache-Control']).toBe('no-store');
    const parsed = JSON.parse(res.body ?? '') as {
      version: number;
      entries: Record<string, unknown>;
    };
    expect(parsed.version).toBe(1);
    // The shipped shards should compose to a non-empty manifest.
    expect(Object.keys(parsed.entries).length).toBeGreaterThan(0);
  });

  it('honors a query string on the manifest URL', () => {
    const mw = captureMiddleware();
    const res = fakeRes();
    const next = vi.fn();
    mw({ url: '/assets/generated/manifest.json?t=123' }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toBeDefined();
  });

  it('passes through unrelated URLs untouched', () => {
    const mw = captureMiddleware();
    const res = fakeRes();
    const next = vi.fn();
    mw({ url: '/index.html' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeUndefined();
  });
});
