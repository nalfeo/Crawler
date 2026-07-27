import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';

const MAX_BODY_BYTES = 32 * 1024;
const MUTATING_PATHS = new Set([
  '/api/review-item',
  '/api/review-set',
  '/api/advance',
  '/api/approve-remaining',
  '/api/save-and-approve-brief',
  '/api/dispatch',
  '/api/select',
  '/api/synth-roster',
  '/api/save-plan',
]);

export async function startThemeEquipmentReviewServer(options) {
  const {
    instanceId,
    setId: initialSetId,
    repoRoot,
    renderHtml,
    runCommand,
    dispatchWorkflow,
    log = () => {},
  } = options;
  const token = randomBytes(32).toString('base64url');
  const clients = new Set();
  let port = 0;
  let setId = null;

  /**
   * Resolve a client-supplied set id against a server-computed allowlist
   * (authored plans plus sets that already have durable state). The
   * client never influences a filesystem or store path directly.
   */
  async function selectSet(requested) {
    if (typeof requested !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requested)) {
      throw new HttpError(400, 'invalid-set-id');
    }
    const index = await runCommand({ action: 'list' });
    const known = new Set((index.sets ?? []).map((entry) => entry.id));
    if (!known.has(requested)) throw new HttpError(404, `unknown-set:${requested}`);
    setId = requested;
    return { selected: setId };
  }

  /**
   * Node puts absolute filesystem paths into errors like ENOENT. The log
   * keeps the raw message; the browser gets a repo-relative one so a canvas
   * page never learns the machine's directory layout.
   */
  function scrubPaths(message) {
    let text = String(message ?? '');
    const roots = [repoRoot, homedir()].filter((root) => typeof root === 'string' && root.length);
    for (const root of roots) {
      for (const variant of new Set([root, root.split('\\').join('/')])) {
        text = text.split(variant).join('<repo>');
      }
    }
    return text;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`request failed: ${error?.message ?? error}`, 'warn');
      if (!res.headersSent)
        writeJson(res, statusForError(error), {
          error: scrubPaths(error?.message ?? String(error)),
        });
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
    if (method === 'GET' && url.pathname === '/api/sets') {
      writeJson(res, 200, { ...(await runCommand({ action: 'list' })), currentSetId: setId });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/state') {
      if (!setId) {
        writeJson(res, 409, { error: 'no-set-selected' });
        return;
      }
      writeJson(res, 200, await runCommand({ action: 'state', setId }));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/artifact') {
      if (!setId) {
        writeJson(res, 409, { error: 'no-set-selected' });
        return;
      }
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
      if (url.pathname === '/api/select') {
        writeJson(res, 200, await selectSet(body.setId));
        return;
      }
      if (url.pathname === '/api/synth-roster') {
        // Only the four brief fields cross the boundary; nothing here
        // can select a path, a set, or a store key.
        writeJson(
          res,
          200,
          await runCommand({
            action: 'synth-roster',
            setId: body.setId,
            displayName: body.displayName,
            themeDesignLanguage: body.themeDesignLanguage,
            ...(body.notes ? { notes: body.notes } : {}),
          }),
        );
        return;
      }
      if (url.pathname === '/api/save-plan') {
        // The destination file is derived downstream from the validated
        // `plan.id`; no path is accepted from the client.
        const result = await runCommand({
          action: 'save-plan',
          plan: body.plan,
          overwrite: body.overwrite === true,
        });
        writeJson(res, 200, result);
        return;
      }
      if (url.pathname === '/api/dispatch') {
        if (!setId) {
          writeJson(res, 409, { error: 'no-set-selected' });
          return;
        }
        writeJson(res, 200, await dispatchWorkflow(body.action, setId));
        return;
      }
      if (!setId) {
        writeJson(res, 409, { error: 'no-set-selected' });
        return;
      }
      if (!setId) {
        writeJson(res, 409, { error: 'no-set-selected' });
        return;
      }
      if (url.pathname === '/api/approve-remaining') {
        const bulk = await runCommand({
          action: 'approve-remaining',
          setId,
          expectedRevision: body.expectedRevision,
        });
        writeJson(res, 200, bulk);
        broadcast(bulk);
        return;
      }
      if (url.pathname === '/api/save-and-approve-brief') {
        const edited = await runCommand({
          action: 'save-and-approve-brief',
          setId,
          itemId: body.itemId,
          briefText: body.briefText,
          expectedRevision: body.expectedRevision,
        });
        writeJson(res, 200, edited);
        broadcast(edited);
        return;
      }
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
            : await runCommand({
                action: 'advance',
                setId,
                expectedRevision: body.expectedRevision,
              });
      writeJson(res, 200, result);
      broadcast(result);
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

  // A caller-supplied initial set id is untrusted input, exactly like one
  // POSTed to /api/select, so it is bound only if it survives the same
  // server-computed allowlist. This runs *before* listen(): if the command
  // bridge fails or hangs, no socket has been opened, so an abandoned
  // startup cannot leak a listening server the caller has no handle to.
  if (initialSetId != null) {
    try {
      await selectSet(initialSetId);
    } catch (error) {
      log(`ignoring unknown initial set "${initialSetId}": ${error?.message ?? error}`, 'warn');
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
    getSetId: () => setId,
    pushState: async (state) => {
      if (state) return broadcast(state);
      if (!setId) return;
      broadcast(await runCommand({ action: 'state', setId }));
    },
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
  if (error instanceof HttpError) return error.status;
  const message = error?.message ?? String(error);
  if (message.includes('revision-conflict')) return 409;
  if (message.includes('exceeds')) return 413;
  if (message.includes('must be valid JSON')) return 400;
  return 422;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
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
