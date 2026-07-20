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
