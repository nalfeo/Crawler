/**
 * Azure OpenAI `images/generations` adapter for terrain-pack MATERIAL art.
 *
 * Deliberately separate from `scripts/sprites/provider/azure-openai.ts`, which
 * targets `images/edits` (multipart, reference PNGs, brief-shaped requests) for
 * the character/item sprite pipeline. Terrain materials are pure text-to-image
 * with no reference art, so they use the simpler JSON `images/generations`
 * route.
 *
 * IMPORTANT (provenance): image generation is NOT byte-reproducible. Raw Azure
 * output is cached under `.cache/terrain-gen/` (gitignored) so recomposition is
 * free and deterministic given a fixed cache; the COMMITTED PNGs under
 * `public/assets/terrain-packs/` remain the source of truth.
 *
 * This module is TRACKED on purpose: the original Floor 2 generation harness was
 * left untracked and was lost, which is why this had to be rebuilt from scratch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/** Sizes gpt-image-1 accepts. Materials are always square. */
export type MaterialSize = '1024x1024';

export interface AzureImageConfig {
  readonly endpoint: string;
  readonly deployment: string;
  readonly apiKey: string;
  readonly apiVersion: string;
}

/**
 * Read Azure config from the environment (populated by `.env.local`, written by
 * `npm run setup:azure:env`). Throws with an actionable message rather than
 * silently falling back to a local/noop backend.
 */
export function azureImageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AzureImageConfig {
  const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
  const deployment = env.AZURE_OPENAI_IMAGE_DEPLOYMENT?.trim();
  const apiKey = env.AZURE_OPENAI_API_KEY?.trim();
  const apiVersion = env.AZURE_OPENAI_API_VERSION?.trim();
  const missing = [
    ['AZURE_OPENAI_ENDPOINT', endpoint],
    ['AZURE_OPENAI_IMAGE_DEPLOYMENT', deployment],
    ['AZURE_OPENAI_API_KEY', apiKey],
    ['AZURE_OPENAI_API_VERSION', apiVersion],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Missing Azure image-generation env var(s): ${missing.join(', ')}. ` +
        'Run `npm run setup:azure:env` (requires `az login`) to write .env.local.',
    );
  }
  return {
    endpoint: endpoint!.replace(/\/$/, ''),
    deployment: deployment!,
    apiKey: apiKey!,
    apiVersion: apiVersion!,
  };
}

/** Load `.env.local` KEY=VALUE pairs into `process.env` without clobbering existing values. */
export function loadEnvLocal(repoRoot: string): void {
  const envPath = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 6;
/** Floor for 429 backoff — the S0 image tier commonly asks for ~15s. */
const RATE_LIMIT_BASE_DELAY_MS = 20_000;

interface AzureImagesResponse {
  readonly data?: ReadonlyArray<{ readonly b64_json?: string }>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait after a throttled/failed attempt. Prefers the service's own
 * `Retry-After` (seconds or HTTP-date), then the "retry after N seconds" hint
 * Azure embeds in the error body, and finally a linear backoff.
 */
function retryDelayMs(attempt: number, response?: Response, body?: string): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000 + 1_000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(1_000, date - Date.now() + 1_000);
  }
  const hinted = body?.match(/retry after (\d+) seconds?/i)?.[1];
  if (hinted) return Number(hinted) * 1000 + 1_000;
  return RATE_LIMIT_BASE_DELAY_MS * attempt;
}

/** POST one text-to-image request and return the decode-checked PNG bytes. */
async function requestMaterialPng(
  config: AzureImageConfig,
  prompt: string,
  size: MaterialSize,
): Promise<Buffer> {
  const url =
    `${config.endpoint}/openai/deployments/${encodeURIComponent(config.deployment)}` +
    `/images/generations?api-version=${encodeURIComponent(config.apiVersion)}`;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': config.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, size, n: 1, quality: 'high' }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = new Error(`network error calling Azure images/generations: ${String(err)}`);
      await sleep(retryDelayMs(attempt));
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '<no body>');
      const message = `Azure images/generations returned ${response.status}: ${body.slice(0, 500)}`;
      // Non-429 4xx are deterministic (bad prompt / auth) — retrying cannot help.
      if (response.status !== 429 && response.status < 500) {
        throw new Error(message);
      }
      lastError = new Error(message);
      const waitMs = retryDelayMs(attempt, response, body);
      console.warn(
        `  throttled (${response.status}); retrying in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      await sleep(waitMs);
      continue;
    }

    const payload = (await response.json()) as AzureImagesResponse;
    if (payload.error) {
      throw new Error(
        `Azure error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }
    const b64 = payload.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error('Azure response missing data[0].b64_json');
    }
    const png = Buffer.from(b64, 'base64');
    PNG.sync.read(png); // decode-check: fail loudly on a non-PNG payload
    return png;
  }
  throw lastError ?? new Error('Azure images/generations failed with no recorded error');
}

export interface GenerateMaterialOptions {
  readonly repoRoot: string;
  /** Stable cache key — the raw Azure PNG is stored as `.cache/terrain-gen/<key>.png`. */
  readonly cacheKey: string;
  readonly prompt: string;
  readonly size?: MaterialSize;
  /** Re-request from Azure even when a cached PNG exists. */
  readonly force?: boolean;
  readonly config?: AzureImageConfig;
}

export interface GeneratedMaterial {
  readonly png: Buffer;
  readonly fromCache: boolean;
  readonly cachePath: string;
}

/**
 * Generate (or reuse the cached) raw material PNG for one cache key.
 *
 * Caching is what makes iterating on COMPOSITION free: only the first run pays
 * for Azure, every later compose run reads the same bytes from `.cache/`.
 */
export async function generateMaterial(
  options: GenerateMaterialOptions,
): Promise<GeneratedMaterial> {
  const cacheDir = path.join(options.repoRoot, '.cache', 'terrain-gen');
  const cachePath = path.join(cacheDir, `${options.cacheKey}.png`);
  if (!options.force && fs.existsSync(cachePath)) {
    return { png: fs.readFileSync(cachePath), fromCache: true, cachePath };
  }
  const config = options.config ?? azureImageConfigFromEnv();
  const png = await requestMaterialPng(config, options.prompt, options.size ?? '1024x1024');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, png);
  return { png, fromCache: false, cachePath };
}
