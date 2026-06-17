/**
 * Azure OpenAI `images/edits` adapter.
 *
 * Hits the Azure-hosted gpt-image-1 deployment with a multipart request that
 * contains the prompt text and the reference PNGs from the brief. Returns
 * the raw multi-variant sheet PNG as a Buffer.
 *
 * Design notes:
 *
 * - Constructor takes `fetch` so unit tests can stub the network without
 *   monkey-patching globals.
 * - No retry / backoff in this layer. The orchestrator owns retries because
 *   the right recovery depends on the failure mode (sterner prompt for
 *   bad-grid, exponential backoff for rate-limit, fail-fast for auth).
 * - Uses Node 22's native FormData + Blob — no `form-data` package needed.
 *   If we ever drop to <18 we'll need a polyfill.
 *
 * TODO (provider swap): once MAI image-gen is accessible, add an
 * `MaiImageProvider` in this folder and have `factory.ts` switch on a
 * `SPRITES_PROVIDER` env var. The contract in `./types.ts` is the seam;
 * the MAI implementation can reuse the same `GenerateSheetRequest` and
 * `ImageProvider` interface. The Azure-specific bits (api-key header,
 * `images/edits` route, response shape parsing) all live below in this file.
 */
import { PNG } from 'pngjs';
import { ProviderError } from './types.js';
export class AzureOpenAIImageProvider {
  endpoint;
  deployment;
  apiKey;
  apiVersion;
  fetchImpl;
  constructor(opts) {
    this.endpoint = stripTrailingSlash(opts.endpoint);
    this.deployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetch ?? fetch;
  }
  async generateSheet(request) {
    const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}/images/edits?api-version=${encodeURIComponent(this.apiVersion)}`;
    const size = request.size ?? request.brief.generation.sheet.nativeCanvas;
    const form = new FormData();
    form.set('prompt', request.prompt);
    form.set('size', `${size}x${size}`);
    form.set('n', '1');
    // gpt-image-1 always returns base64 and rejects `response_format`; do
    // not send it. (The original code targeted dall-e-3, which required it.)
    // Each reference image is attached as a separate `image[]` part.
    request.referencePngs.forEach((png, idx) => {
      form.append(
        'image[]',
        new Blob([new Uint8Array(png)], { type: 'image/png' }),
        `ref-${idx}.png`,
      );
    });
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'api-key': this.apiKey },
        body: form,
      });
    } catch (err) {
      throw new ProviderError('network', `network error calling Azure: ${err.message}`, {
        cause: err,
      });
    }
    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new ProviderError(
        kind,
        `Azure images/edits returned ${response.status}: ${truncate(bodyText, 500)}`,
      );
    }
    // The response is JSON with a base64-encoded PNG in data[0].b64_json.
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ProviderError(
        'provider-error',
        `Azure response was not valid JSON: ${err.message}`,
        { cause: err },
      );
    }
    if (payload.error) {
      throw new ProviderError(
        'provider-error',
        `Azure error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }
    const b64 = payload.data?.[0]?.b64_json;
    if (!b64) {
      throw new ProviderError(
        'non-png',
        `Azure response missing data[0].b64_json (got keys: ${Object.keys(payload).join(', ')})`,
      );
    }
    const sheet = Buffer.from(b64, 'base64');
    // Decode-check so the orchestrator gets a clear non-png error before
    // it tries to slice.
    try {
      PNG.sync.read(sheet);
    } catch (err) {
      throw new ProviderError('non-png', `provider returned undecodable PNG: ${err.message}`, {
        cause: err,
      });
    }
    return sheet;
  }
}
function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
function httpStatusToKind(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500 && status < 600) return 'provider-error';
  return 'provider-error';
}
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
//# sourceMappingURL=azure-openai.js.map
