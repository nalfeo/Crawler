import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 32 * 1024;
const MUTATING_PATHS = new Set([
  '/api/review-item',
  '/api/review-set',
  '/api/advance',
  '/api/dispatch',
]);

export async function startThemeEquipmentReviewServer(options) {
  const { instanceId, setId, renderHtml, runCommand, dispatchWorkflow, log = () => {} } = options;
  const token = randomBytes(32).toString('base64url');
  const clients = new Set();
  let port = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`request failed: ${error?.message ?? error}`, 'warn');
      if (!res.headersSent)
        writeJson(res, statusForError(error), { error: error?.message ?? String(error) });
      else res.destroy();
    });
  });

  async function handle(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (method === 'GET' && url.pathname === '/') {
      writeText(res, 200, renderHtml({ instanceId, setId, token }));
      return;
    }
    if (method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }
    if (!hasToken(req, url, token)) {
      writeJson(res, 403, { error: 'invalid-canvas-token' });
      return;
    }
    if (MUTATING_PATHS.has(url.pathname)) {
      if (method !== 'POST') {
        writeJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      if (!isSelfOrigin(req.headers.origin, port)) {
        writeJson(res, 403, { error: 'forbidden-origin' });
        return;
      }
      if (!isJsonContentType(req.headers['content-type'])) {
        writeJson(res, 415, { error: 'application-json-required' });
        return;
      }
    }
    if (method === 'GET' && url.pathname === '/api/state') {
      writeJson(res, 200, await runCommand({ action: 'state', setId }));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/artifact') {
      const result = await runCommand({
        action: 'artifact',
        setId,
        itemId: requiredQuery(url, 'itemId'),
        artifactId: requiredQuery(url, 'artifactId'),
      });
      const bytes = Buffer.from(result.base64, 'base64');
      res.writeHead(200, {
        'Content-Type': result.contentType,
        'Content-Length': bytes.length,
        'Cache-Control': 'private, max-age=300',
      });
      res.end(bytes);
      return;
    }
    if (method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      res.write(': connected\n\n');
      return;
    }
    if (method === 'POST' && MUTATING_PATHS.has(url.pathname)) {
      const body = await readJsonBody(req);
      const result =
        url.pathname === '/api/review-item'
          ? await runCommand({
              action: 'item-review',
              setId,
              itemId: body.itemId,
              review: body.review,
              expectedRevision: body.expectedRevision,
            })
          : url.pathname === '/api/review-set'
            ? await runCommand({
                action: 'set-review',
                setId,
                review: body.review,
                expectedRevision: body.expectedRevision,
              })
            : url.pathname === '/api/advance'
              ? await runCommand({
                  action: 'advance',
                  setId,
                  expectedRevision: body.expectedRevision,
                })
              : await dispatchWorkflow(body.action);
      writeJson(res, 200, result);
      if (url.pathname !== '/api/dispatch') broadcast(result);
      return;
    }
    writeJson(res, 404, { error: 'not-found' });
  }

  function broadcast(state) {
    const payload = `data: ${JSON.stringify({ type: 'state', state })}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    pushState: async (state) => broadcast(state ?? (await runCommand({ action: 'state', setId }))),
    close: () =>
      new Promise((resolve) => {
        for (const client of clients) client.end();
        clients.clear();
        server.close(() => resolve());
      }),
  };
}

function hasToken(req, url, expected) {
  const supplied = req.headers['x-canvas-token'] ?? url.searchParams.get('token') ?? '';
  if (typeof supplied !== 'string') return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isSelfOrigin(origin, port) {
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) === port
    );
  } catch {
    return false;
  }
}

function isJsonContentType(value) {
  return (
    typeof value === 'string' && value.toLowerCase().split(';', 1)[0].trim() === 'application/json'
  );
}

function requiredQuery(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Missing query parameter "${name}".`);
  return value;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function statusForError(error) {
  const message = error?.message ?? String(error);
  if (message.includes('revision-conflict')) return 409;
  if (message.includes('exceeds')) return 413;
  if (message.includes('must be valid JSON')) return 400;
  return 422;
}

function writeJson(res, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store',
  });
  res.end(encoded);
}

function writeText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
