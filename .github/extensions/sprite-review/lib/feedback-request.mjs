export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > 16 * 1024) {
      const error = new Error('feedback payload exceeds 16 KiB');
      error.code = 'body-too-large';
      throw error;
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('feedback payload must be valid JSON');
    error.code = 'invalid-json';
    throw error;
  }
}
