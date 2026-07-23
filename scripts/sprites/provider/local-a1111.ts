/**
 * Local A1111/Forge image provider.
 *
 * Hits a local Stable Diffusion WebUI (A1111 fork or lllyasviel/Forge)
 * running at `http://localhost:7860` (or configured endpoint) and generates
 * N sprite variants via the `/sdapi/v1/txt2img` REST endpoint.
 *
 * Unlike Azure (which returns a pre-assembled sheet), A1111 generates images
 * individually, so we stitch them into a rows×cols grid PNG using pngjs.
 *
 * Design notes:
 * - No retry/backoff in this layer (orchestrator owns retry policy)
 * - Uses AbortSignal.timeout for per-request timeout protection
 * - Validates all output PNGs decode-check before stitching
 * - Grid layout uses `brief.generation.sheet` config (rows, cols, emptyCells)
 * - Respects seed for reproducible generation (if provided in env)
 */

import { PNG } from 'pngjs';
import type { GenerateSheetRequest, ImageProvider, ProviderErrorKind } from './types.js';
import { ProviderError } from './types.js';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  isTimeoutAbortError,
  providerTimeoutMessage,
} from './fetch-timeout.js';
import type { SpriteType } from '../../../src/shared/sprite-types.js';

export interface LocalA1111ImageProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  /**
   * Injectable fetch implementation. Defaults to global fetch (Node 18+).
   * Tests pass a stub to avoid network IO.
   */
  readonly fetch?: typeof fetch;
  /**
   * Per-request timeout in ms. Defaults to {@link DEFAULT_PROVIDER_TIMEOUT_MS}
   * (120_000 ms / 2 min). Local SDXL can be slow, so consider overriding this
   * with a larger value (e.g. 600_000 / 10 min) for heavy models.
   */
  readonly timeoutMs?: number;
  /**
   * Optional seed for reproducible generation. If provided, all variants
   * use sequential seeds (seed, seed+1, seed+2, ...).
   */
  readonly seed?: number;
  /**
   * Sampling steps for generation (higher = slower but higher quality).
   * Defaults to 20.
   */
  readonly steps?: number;
  /**
   * CFG scale (classifier-free guidance). Default: 7.
   */
  readonly cfgScale?: number;
  /**
   * Sampler name (e.g., "Euler", "DPM++ 2M Karras"). Defaults to A1111's default.
   */
  readonly sampler?: string;
  /**
   * Negative prompt to append to all generations. Useful for excluding
   * common artifacts (e.g., "blurry, distorted, low quality").
   */
  readonly negativePrompt?: string;
}

interface A1111TxtToImgRequest {
  readonly prompt: string;
  readonly negative_prompt: string;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  readonly cfg_scale: number;
  readonly seed: number;
  readonly sampler_name: string;
  readonly override_settings: {
    readonly sd_model_checkpoint: string;
  };
  readonly override_settings_restore_afterwards: boolean;
}

interface A1111TxtToImgResponse {
  readonly images?: string[];
  readonly info?: string;
  readonly error?: string;
}

export class LocalA1111ImageProvider implements ImageProvider {
  readonly capabilities = {
    referenceImages: false,
  } as const;

  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly seed?: number;
  private readonly steps: number;
  private readonly cfgScale: number;
  private readonly sampler: string;
  private readonly negativePrompt: string;

  constructor(opts: LocalA1111ImageProviderOptions) {
    this.endpoint = stripTrailingSlash(opts.endpoint);
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.seed = opts.seed;
    this.steps = opts.steps ?? 20;
    this.cfgScale = opts.cfgScale ?? 7;
    this.sampler = opts.sampler ?? 'Euler';
    this.negativePrompt = opts.negativePrompt ?? '';
  }

  async generateSheet(request: GenerateSheetRequest): Promise<Buffer> {
    if (!LOCAL_A1111_SUPPORTED_TYPES.has(request.brief.type)) {
      throw new ProviderError(
        'request-error',
        `local-a1111 supports only ${Array.from(LOCAL_A1111_SUPPORTED_TYPES).join(', ')} briefs; got '${request.brief.type}'.`,
      );
    }
    if (!request.singleVariantPrompt) {
      throw new ProviderError(
        'request-error',
        'local-a1111 requires request.singleVariantPrompt (sheet prompts are incompatible with per-cell txt2img generation).',
      );
    }
    if (request.referencePngs.length > 0) {
      throw new ProviderError(
        'request-error',
        'local-a1111 does not consume reference images. Use a provider with reference-image support or disable references for this backend.',
      );
    }

    const { sheet } = request.brief.generation;
    const sheetSize = request.size ?? sheet.nativeCanvas;

    // Grid-slot dimensions within the sheet.
    const slotW = Math.floor(sheetSize / sheet.cols);
    const slotH = Math.floor(sheetSize / sheet.rows);
    // Leave a deterministic background gutter so the content-aware slicer can
    // reliably recover row/column boundaries from the stitched output. Stable
    // Diffusion works in an 8x-downsampled latent space, so txt2img width/height
    // must be multiples of 8 — a backend may otherwise reject the request or
    // silently resize the output, which would misalign the grid. Round the
    // content cell down to the nearest multiple of 8 and center it within the
    // slot; the leftover pixels form the gutter.
    const minGutter = Math.max(2, Math.floor(Math.min(slotW, slotH) * 0.04));
    const cellW = Math.max(8, roundDownToMultiple(slotW - minGutter * 2, 8));
    const cellH = Math.max(8, roundDownToMultiple(slotH - minGutter * 2, 8));
    const offsetX = Math.floor((slotW - cellW) / 2);
    const offsetY = Math.floor((slotH - cellH) / 2);

    // Generate each grid cell individually. We iterate over *every* cell in the
    // rows×cols grid (not `request.variants`) and let the empty-cell check
    // decide whether to generate content or emit a background placeholder.
    // `request.variants` equals `variantCount(brief)` = the number of *content*
    // cells, so iterating it directly would under-fill (and misplace) any grid
    // whose empty cells are not the trailing positions. A separate `contentIdx`
    // counter keeps variation emphasis and seeds contiguous across content cells.
    const images: PNG[] = [];
    const emptyCellSet = new Set(sheet.emptyCells.map(([r, c]) => `${r},${c}`));
    const totalCells = sheet.rows * sheet.cols;
    let contentIdx = 0;

    for (let cellIdx = 0; cellIdx < totalCells; cellIdx++) {
      const row = Math.floor(cellIdx / sheet.cols);
      const col = cellIdx % sheet.cols;
      const isEmpty = emptyCellSet.has(`${row},${col}`);

      let png: PNG;
      if (isEmpty) {
        // Create a background-colored placeholder for empty cells.
        png = new PNG({ width: cellW, height: cellH });
        const data = png.data;
        for (let i = 0; i < data.length; i += 4) {
          data[i] = SHEET_BG_RGB[0];
          data[i + 1] = SHEET_BG_RGB[1];
          data[i + 2] = SHEET_BG_RGB[2];
          data[i + 3] = 255;
        }
      } else {
        const variantPrompt = buildVariantPrompt(request, contentIdx);
        const variantPng = await this.generateVariant(variantPrompt, cellW, cellH, contentIdx);
        png = variantPng;
        contentIdx++;
      }

      images.push(png);
    }

    // Stitch images into a grid.
    const sheet_png = new PNG({
      width: sheetSize,
      height: sheetSize,
      colorType: 6, // RGBA
    });
    fillPng(sheet_png, SHEET_BG_RGB[0], SHEET_BG_RGB[1], SHEET_BG_RGB[2], 255);

    // Copy each image into its grid cell.
    for (let imageIdx = 0; imageIdx < images.length; imageIdx++) {
      const srcImg = images[imageIdx];
      if (!srcImg) break;

      const row = Math.floor(imageIdx / sheet.cols);
      const col = imageIdx % sheet.cols;
      const dstX: number = col * slotW + offsetX;
      const dstY: number = row * slotH + offsetY;

      // Copy srcImg into sheet_png at (dstX, dstY).
      // pngjs data is stored as [R, G, B, A, R, G, B, A, ...] in row-major order.
      const srcImgWidth: number = srcImg.width;
      const srcImgHeight: number = srcImg.height;
      // Defensive backstop: clamp the copy to the content cell (cellW/cellH), not
      // just the sheet edge, so an unexpectedly oversized source can never bleed
      // across the gutter into the adjacent slot even if the dimension check above
      // is bypassed. In the happy path srcImg is exactly cellW×cellH, so this is a
      // no-op.
      for (let y = 0; y < srcImgHeight && y < cellH && dstY + y < sheetSize; y++) {
        for (let x = 0; x < srcImgWidth && x < cellW && dstX + x < sheetSize; x++) {
          const srcIdx: number = (y * srcImgWidth + x) * 4;
          const dstIdx: number = ((dstY + y) * sheetSize + (dstX + x)) * 4;

          const r: number = srcImg.data[srcIdx] as number;
          const g: number = srcImg.data[srcIdx + 1] as number;
          const b: number = srcImg.data[srcIdx + 2] as number;
          const a: number = srcImg.data[srcIdx + 3] as number;

          sheet_png.data[dstIdx as number] = r;
          sheet_png.data[(dstIdx + 1) as number] = g;
          sheet_png.data[(dstIdx + 2) as number] = b;
          sheet_png.data[(dstIdx + 3) as number] = a;
        }
      }
    }

    // Encode and return.
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      sheet_png
        .pack()
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', () => {
          resolve(Buffer.concat(chunks));
        })
        .on('error', (err: Error) => {
          reject(
            new ProviderError('provider-error', `Failed to encode stitched PNG: ${err.message}`, {
              cause: err,
            }),
          );
        });
    });
  }

  private async generateVariant(
    prompt: string,
    width: number,
    height: number,
    variantIndex: number,
  ): Promise<PNG> {
    const seed = this.seed !== undefined ? this.seed + variantIndex : -1;

    const reqBody: A1111TxtToImgRequest = {
      prompt,
      negative_prompt: this.negativePrompt,
      width,
      height,
      steps: this.steps,
      cfg_scale: this.cfgScale,
      seed,
      sampler_name: this.sampler,
      override_settings: {
        sd_model_checkpoint: this.model,
      },
      override_settings_restore_afterwards: true,
    };

    const url = `${this.endpoint}/sdapi/v1/txt2img`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (isTimeoutAbortError(err)) {
        throw new ProviderError(
          'network',
          providerTimeoutMessage(`A1111 txt2img for variant ${variantIndex}`, this.timeoutMs),
          { cause: err },
        );
      }
      throw new ProviderError('network', `network error calling A1111: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new ProviderError(
        kind,
        `A1111 txt2img returned ${response.status}: ${truncate(bodyText, 500)}`,
      );
    }

    let payload: A1111TxtToImgResponse;
    try {
      payload = (await response.json()) as A1111TxtToImgResponse;
    } catch (err) {
      throw new ProviderError(
        'provider-error',
        `A1111 response was not valid JSON: ${(err as Error).message}`,
        { cause: err },
      );
    }

    if (payload.error) {
      throw new ProviderError('request-error', `A1111 error: ${payload.error}`);
    }

    const b64 = payload.images?.[0];
    if (!b64) {
      throw new ProviderError(
        'non-png',
        `A1111 response missing images[0] (got keys: ${Object.keys(payload).join(', ')})`,
      );
    }

    const pngBuffer = Buffer.from(b64, 'base64');

    // Decode-check so we fail fast if the response is not a valid PNG.
    let png: PNG;
    try {
      png = PNG.sync.read(pngBuffer);
    } catch (err) {
      throw new ProviderError(
        'non-png',
        `A1111 returned undecodable PNG: ${(err as Error).message}`,
        { cause: err },
      );
    }

    // The backend may ignore the requested width/height (some samplers/models
    // silently snap to their own resolution). A wrong-sized cell would overflow
    // its slot and corrupt neighbouring cells when stitched, so reject it here.
    if (png.width !== width || png.height !== height) {
      throw new ProviderError(
        'bad-grid',
        `A1111 returned a ${png.width}x${png.height} image but ${width}x${height} was requested ` +
          `for variant ${variantIndex}; the backend ignored the requested dimensions.`,
      );
    }

    return png;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Round `value` down to the nearest multiple of `multiple` (>= 0). */
function roundDownToMultiple(value: number, multiple: number): number {
  return Math.floor(value / multiple) * multiple;
}

function httpStatusToKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'request-error';
  return 'network';
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(unable to read response body)';
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

const SHEET_BG_RGB: readonly [number, number, number] = [255, 0, 255];
const LOCAL_A1111_SUPPORTED_TYPES: ReadonlySet<SpriteType> = new Set([
  'weapon',
  'equipment',
  'item',
  'prop',
  'tile',
  'vfx',
]);

function fillPng(png: PNG, r: number, g: number, b: number, a: number): void {
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
}

function buildVariantPrompt(request: GenerateSheetRequest, variantIndex: number): string {
  const base = request.singleVariantPrompt ?? request.prompt;
  const variations = request.brief.variations;
  if (variations.length === 0) return base;
  const variation = variations[variantIndex % variations.length];
  return `${base}\n\n## Variant emphasis\nApply this one embellishment for this variant: ${variation}.`;
}
