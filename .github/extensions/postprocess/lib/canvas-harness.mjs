/**
 * canvas-harness — the ONE generic loopback HTTP server every Crawler DevTool
 * canvas extension is built on. It has ZERO domain knowledge (no sidecar, no
 * YAML, no sprite/achievement/storage specifics). Each tool injects its own
 * `renderHtml`, `buildState`, and an allowlisted route table.
 *
 * This file is the SINGLE SOURCE OF TRUTH. It is vendored (byte-copied) into
 * each extension's `lib/canvas-harness.mjs` by `scripts/canvas-harness/sync.mjs`
 * and a drift test asserts the copies stay identical. DO NOT edit a vendored
 * copy — edit this file, then re-run the sync. See `scripts/canvas-harness/README.md`.
 *
 * Responsibilities (and nothing more):
 *   - one `http.Server` bound to 127.0.0.1:0 (loopback only — the host embeds
 *     only loopback URLs in the canvas iframe),
 *   - `GET /`          → renderHtml(instanceId) as text/html,
 *   - `GET /events`    → Server-Sent Events; pushState() broadcasts new state,
 *   - `GET /api/state` → JSON of buildState(),
 *   - allowlisted JSON routes (return `{ json, status? }`),
 *   - allowlisted BINARY routes that relay an upstream `fetch` Response by
 *     STREAMING its body and preserving upstream status + Content-Type,
 *   - never crashing the extension process: a throwing/timing-out handler is
 *     caught and turned into a controlled 5xx, logged via the injected `log`.
 *
 * @module canvas-harness
 */

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { setInterval, clearInterval } from 'node:timers';

/** Bumped when the harness contract changes so vendored copies are auditable. */
export const CANVAS_HARNESS_VERSION = '1.0.0';

const noopLog = () => {};

/**
 * @typedef {Object} HarnessRoute
 * @property {string} [method]            HTTP method (default 'GET').
 * @property {string|RegExp} path         Exact pathname (string) or RegExp tested against pathname.
 * @property {(ctx: RouteCtx) => unknown} handler  Route handler (see below).
 *
 * JSON route handler resolves to:
 *   - `{ json, status?, headers? }` → serialized as application/json, or
 *   - `undefined`/`null`            → 404.
 * BINARY route handler resolves to:
 *   - a web `Response` (e.g. the result of `fetch`) → streamed with upstream
 *     status + Content-Type preserved, or
 *   - `{ status, headers?, body }`  (body: Buffer | string | web ReadableStream), or
 *   - `undefined`/`null`            → 404.
 * A handler that throws becomes a controlled 502 and is logged — the process
 * never crashes.
 *
 * @typedef {Object} RouteCtx
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse}  res    (usually leave the harness to write)
 * @property {URL} url                                     parsed request URL
 * @property {string} instanceId
 */

function methodOf(route) {
  return (route.method ?? 'GET').toUpperCase();
}

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (methodOf(route) !== method) continue;
    const { path } = route;
    if (typeof path === 'string' && path === pathname) return route;
    if (path instanceof RegExp && path.test(pathname)) return route;
  }
  return null;
}

/** HTTP methods that can mutate state — subject to the CSRF origin guard. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Loopback hostnames a same-origin canvas fetch may present (URL.hostname forms). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * True iff `origin` is this harness server's OWN loopback origin (same port).
 * An attacker page cannot bind the ephemeral port this server already holds, so
 * "loopback host + exact same port" uniquely identifies the same-origin canvas
 * page served from this server. Anything else (a different port, a non-loopback
 * host, an unparseable value, a non-http scheme) is rejected.
 */
function isSelfOrigin(origin, port) {
  if (!(port > 0)) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (Number(parsed.port) !== port) return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
}

function writeJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function writeText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(text);
}

function looksLikeWebResponse(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.status === 'number' &&
    'body' in value &&
    !!value.headers &&
    typeof value.headers.get === 'function'
  );
}

/**
 * Relay a web `Response` to the node response, STREAMING the body and
 * preserving the upstream status + Content-Type (never buffers the whole
 * payload in memory). On an error status or missing body it forwards the
 * status with a small text body so the iframe can render a controlled state.
 */
async function relayWebResponse(res, upstream, log) {
  const status = upstream.status;
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  if (!upstream.body) {
    // No stream to relay (e.g. HEAD-like or empty error). Preserve the upstream
    // Content-Type when present so structured error payloads survive; only fall
    // back to text/plain when the upstream declared nothing.
    const detail = await upstream.text().catch(() => '');
    const ct = upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8';
    writeText(res, status, detail || `upstream responded ${status}`, ct);
    return;
  }
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store' };
  const len = upstream.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  res.writeHead(status, headers);
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on('error', (err) => {
    log(`binary relay stream error: ${err?.message ?? err}`, 'warn');
    res.destroy();
  });
  nodeStream.pipe(res);
}

async function relayPlainBinary(res, value, log) {
  const status = value.status ?? 200;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    ...(value.headers ?? {}),
  };
  const { body } = value;
  if (body == null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  // Assume a web ReadableStream. Attach an error listener BEFORE piping so a
  // stream that errors mid-relay is converted into a controlled teardown
  // instead of an unhandled 'error' event that would crash the process.
  res.writeHead(status, headers);
  const nodeStream = Readable.fromWeb(body);
  nodeStream.on('error', (err) => {
    log(`binary relay stream error: ${err?.message ?? err}`, 'warn');
    res.destroy();
  });
  nodeStream.pipe(res);
}

/**
 * Start a loopback canvas server for one instance.
 *
 * @param {Object} options
 * @param {string} options.instanceId
 * @param {(instanceId: string) => string} options.renderHtml  full HTML document for `GET /`.
 * @param {() => (Promise<unknown>|unknown)} [options.buildState]  state for `/api/state` + SSE.
 * @param {HarnessRoute[]} [options.jsonRoutes]    allowlisted JSON routes.
 * @param {HarnessRoute[]} [options.binaryRoutes]  allowlisted binary (streamed) routes.
 * @param {(message: string, level?: 'info'|'warn'|'error') => void} [options.log]
 * @returns {Promise<{ url: string, port: number, server: import('node:http').Server,
 *   pushState: (state?: unknown) => Promise<unknown>, close: () => Promise<void> }>}
 */
export async function startCanvasServer(options) {
  const {
    instanceId,
    renderHtml,
    buildState = () => ({}),
    jsonRoutes = [],
    binaryRoutes = [],
    log = noopLog,
  } = options;

  if (typeof renderHtml !== 'function') {
    throw new TypeError('startCanvasServer requires a renderHtml(instanceId) function');
  }

  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set();

  // The server's own listen port, filled in after `listen` resolves. Used by the
  // CSRF origin guard to recognize this harness's own same-origin canvas page.
  let selfPort = 0;

  async function safeBuildState() {
    try {
      return await buildState();
    } catch (err) {
      log(`buildState failed: ${err?.message ?? err}`, 'error');
      return { error: String(err?.message ?? err) };
    }
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`unhandled request error: ${err?.message ?? err}`, 'error');
      if (!res.headersSent) writeJson(res, 500, { error: String(err?.message ?? err) });
      else res.destroy();
    });
  });

  async function handleRequest(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    // CSRF guard: a canvas extension may register mutating routes (POST/PUT/
    // PATCH/DELETE) whose handlers have real side effects (disk writes, an
    // authenticated push, etc.), so a forged cross-origin request must not be
    // able to drive them. Browsers attach an Origin header to every non-GET
    // request and a page cannot forge it, so reject any mutating request whose
    // Origin is present and is NOT this server's own loopback origin.
    // Server-side callers send no Origin and stay trusted; the same-origin
    // canvas page (served from this very port) sends the matching loopback
    // Origin.
    if (MUTATING_METHODS.has(method)) {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && !isSelfOrigin(origin, selfPort)) {
        writeJson(res, 403, {
          error: 'forbidden-origin',
          message: 'This browser origin is not allowed to perform this request.',
        });
        return;
      }
    }

    if (method === 'GET' && pathname === '/') {
      writeText(res, 200, renderHtml(instanceId), 'text/html; charset=utf-8');
      return;
    }
    if (method === 'GET' && pathname === '/events') {
      await handleSse(req, res);
      return;
    }
    if (method === 'GET' && pathname === '/api/state') {
      writeJson(res, 200, await safeBuildState());
      return;
    }

    const jsonRoute = matchRoute(jsonRoutes, method, pathname);
    if (jsonRoute) {
      await runJsonRoute(jsonRoute, req, res, url);
      return;
    }
    const binaryRoute = matchRoute(binaryRoutes, method, pathname);
    if (binaryRoute) {
      await runBinaryRoute(binaryRoute, req, res, url);
      return;
    }

    writeJson(res, 404, { error: `no route for ${method} ${pathname}` });
  }

  async function runJsonRoute(route, req, res, url) {
    try {
      const result = await route.handler({ req, res, url, instanceId });
      if (res.headersSent || res.writableEnded) return; // handler wrote directly
      if (result == null) {
        writeJson(res, 404, { error: 'not found' });
        return;
      }
      writeJson(res, result.status ?? 200, result.json ?? result, result.headers ?? {});
    } catch (err) {
      log(`json route ${route.path} failed: ${err?.message ?? err}`, 'warn');
      if (!res.headersSent) writeJson(res, 502, { error: String(err?.message ?? err) });
    }
  }

  async function runBinaryRoute(route, req, res, url) {
    try {
      const result = await route.handler({ req, res, url, instanceId });
      if (res.headersSent || res.writableEnded) return;
      if (result == null) {
        writeJson(res, 404, { error: 'not found' });
        return;
      }
      if (looksLikeWebResponse(result)) {
        await relayWebResponse(res, result, log);
        return;
      }
      await relayPlainBinary(res, result, log);
    } catch (err) {
      log(`binary route ${route.path} failed: ${err?.message ?? err}`, 'warn');
      if (!res.headersSent) writeJson(res, 502, { error: String(err?.message ?? err) });
    }
  }

  async function handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const initial = await safeBuildState();
    res.write(`data: ${JSON.stringify({ type: 'state', state: initial })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 25000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }

  /** Broadcast fresh (or supplied) state to every connected SSE client. */
  async function pushState(state) {
    const resolved = state ?? (await safeBuildState());
    const payload = `data: ${JSON.stringify({ type: 'state', state: resolved })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
    return resolved;
  }

  async function close() {
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // ignore — client already gone
      }
    }
    sseClients.clear();
    // Force-close lingering (keep-alive) sockets so an ephemeral per-instance
    // server tears down deterministically on canvas close — otherwise pooled
    // client connections keep the port (and the event loop) alive.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  selfPort = port;
  const url = `http://127.0.0.1:${port}/`;
  log(`canvas server for instance ${instanceId} listening on ${url}`);

  return { url, port, server, pushState, close };
}
