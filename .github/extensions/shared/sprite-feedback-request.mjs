/**
 * sprite-feedback-request.mjs — HTTP request guards for the mutating
 * `POST /api/feedback` route: bounded body reads and the trusted-origin /
 * content-type checks that route enforces alongside its per-instance mutation
 * token.
 *
 * SHARED (not per-extension): consumed by both the Workflow canvas's
 * `/api/feedback` route and (while it still exists) the standalone Sprite
 * Review canvas's own route, so the two surfaces enforce byte-identical
 * security semantics against the same durable feedback file.
 *
 * @module shared/sprite-feedback-request
 */
import { timingSafeEqual } from 'node:crypto';

export function tokensMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/**
 * True only when the request's `Origin` header matches the loopback server's
 * OWN origin (derived from `entry.url`). A mutating route must never trust a
 * cross-origin browser request even if it happens to carry a valid token —
 * this is the second, independent leg of the mutation guard.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ url: string }} entry
 * @returns {boolean}
 */
export function isTrustedMutationOrigin(req, entry) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.trim().length === 0) return false;
  try {
    return origin === new URL(entry.url).origin;
  } catch {
    return false;
  }
}

/** True only for an (optionally-parametrized) `application/json` Content-Type. */
export function isJsonContentType(req) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string') return false;
  const normalized = contentType.toLowerCase();
  return normalized === 'application/json' || normalized.startsWith('application/json;');
}

/**
 * Read + JSON-parse a bounded request body. Rejects with `error.code ===
 * 'body-too-large'` on overflow and `'invalid-json'` on an empty or malformed
 * body — the feedback route maps those to 413/400 respectively.
 */
export function readJsonBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error(`feedback payload exceeds ${limitBytes} bytes`);
        error.code = 'body-too-large';
        error.statusCode = 413;
        reject(error);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim().length === 0) {
          const error = new Error('feedback payload must not be empty');
          error.code = 'invalid-json';
          reject(error);
          return;
        }
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          const error = new Error('feedback payload must be a JSON object');
          error.code = 'invalid-json';
          reject(error);
          return;
        }
        resolve(value);
      } catch {
        const error = new Error('feedback payload must be valid JSON');
        error.code = 'invalid-json';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
