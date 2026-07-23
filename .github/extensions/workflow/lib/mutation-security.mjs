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
 * Thrown by `readJsonBody` when the request body exceeds `limitBytes`.
 * Carries `statusCode`/`code` so callers can send a structured 413 JSON
 * response instead of pattern-matching `error.message`.
 */
export class PayloadTooLargeError extends Error {
  constructor(limitBytes) {
    super(`request body too large (limit ${limitBytes} bytes)`);
    this.name = 'PayloadTooLargeError';
    this.statusCode = 413;
    this.code = 'body-too-large';
  }
}

/**
 * Read + JSON-parse a bounded request body.
 *
 * On overflow this must NOT call `req.destroy()` — for an `IncomingMessage`,
 * destroying the request destroys the underlying socket it shares with the
 * paired `res`, so any 413 the route handler tries to write afterward never
 * reaches the client (the connection is already reset; the caller sees a
 * socket error, not a clean 413). Instead: stop buffering once over the
 * limit (bounding memory), keep draining the stream so it doesn't stall
 * mid-request, and reject exactly once — with `PayloadTooLargeError` — after
 * the body finishes arriving, so the socket is still healthy for the caller
 * to write a real HTTP response on.
 */
export function readJsonBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return; // already over the limit — keep draining, don't buffer
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0; // release the buffered prefix early
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new PayloadTooLargeError(limitBytes));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const value = text ? JSON.parse(text) : {};
        resolve(value && typeof value === 'object' ? value : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
