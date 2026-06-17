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
import type { GenerateSheetRequest, ImageProvider } from './types.js';
export interface AzureOpenAIImageProviderOptions {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
  /**
   * Injectable fetch implementation. Defaults to global fetch (Node 18+).
   * Tests pass a stub to avoid network IO.
   */
  readonly fetch?: typeof fetch;
}
export declare class AzureOpenAIImageProvider implements ImageProvider {
  private readonly endpoint;
  private readonly deployment;
  private readonly apiKey;
  private readonly apiVersion;
  private readonly fetchImpl;
  constructor(opts: AzureOpenAIImageProviderOptions);
  generateSheet(request: GenerateSheetRequest): Promise<Buffer>;
}
//# sourceMappingURL=azure-openai.d.ts.map
