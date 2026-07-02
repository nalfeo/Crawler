/**
 * Sidecar backend selection.
 *
 * The sidecar is the surface the team uses to work on sprites against the
 * **shared Azure environment**, so it defaults to the Azure run-store + queue
 * backends. The local filesystem (`local`) and noop (`noop`) backends are not
 * retired from the codebase — they remain the factory defaults used by tests
 * and are still selectable for explicit local runs — but the sidecar never
 * falls back to them silently. To run the sidecar fully local (e.g. in a test
 * or offline), opt in explicitly with:
 *
 *   SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop
 *
 * Environment variables
 * ---------------------
 * | Variable             | Effective default (sidecar) | Values                |
 * |----------------------|-----------------------------|-----------------------|
 * | SPRITES_RUN_STORE    | `azure-blob`                | `local` \| `azure-blob` |
 * | SPRITES_ASSET_QUEUE  | `azure-queue`               | `noop`  \| `azure-queue` |
 *
 * Note this differs from the `createRunStore` / `createAssetQueue` factory
 * defaults (`local` / `noop`): those stay backwards-compatible for direct
 * callers and tests. The Azure-first policy lives here, at the sidecar layer.
 */

export const SIDECAR_AZURE_RUN_STORE = 'azure-blob';
export const SIDECAR_AZURE_ASSET_QUEUE = 'azure-queue';
export const SIDECAR_LOCAL_RUN_STORE = 'local';
export const SIDECAR_LOCAL_ASSET_QUEUE = 'noop';

export interface SidecarBackendSelection {
  /** Effective `SPRITES_RUN_STORE` selector (lowercased). */
  readonly runStore: string;
  /** Effective `SPRITES_ASSET_QUEUE` selector (lowercased). */
  readonly assetQueue: string;
  /** True when either resolved backend is an Azure implementation. */
  readonly usesAzure: boolean;
}

/**
 * Thrown when an Azure backend is selected (explicitly or by the sidecar
 * default) but no Azure Storage credentials are present. Carries an
 * actionable, multi-line message so the sidecar can fail fast instead of
 * silently degrading to local.
 */
export class SidecarAzureCredentialsError extends Error {
  readonly runStore: string;
  readonly assetQueue: string;

  constructor(runStore: string, assetQueue: string) {
    super(
      [
        `Sidecar is configured for Azure backends (run-store=${runStore}, queue=${assetQueue}) ` +
          `but no Azure Storage credentials were found.`,
        '',
        'Set them up once with:',
        '  npm run setup:azure',
        '  (writes .env.local with AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY and the SPRITES_* selectors)',
        '',
        'Or, for local testing only, opt into the local backends explicitly:',
        '  SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop <command>',
      ].join('\n'),
    );
    this.name = 'SidecarAzureCredentialsError';
    this.runStore = runStore;
    this.assetQueue = assetQueue;
  }
}

/**
 * Returns true when the environment carries Azure Storage credentials, via
 * either a full connection string or the account-name + account-key pair.
 *
 * Values are trimmed: a whitespace-only variable is treated as absent, so a
 * partially-populated `.env.local` cannot masquerade as valid credentials and
 * then fail later with a cryptic Azure SDK error.
 */
export function hasAzureStorageCreds(env: Record<string, string | undefined>): boolean {
  const nonBlank = (value: string | undefined): boolean =>
    typeof value === 'string' && value.trim() !== '';
  if (nonBlank(env['AZURE_STORAGE_CONNECTION_STRING'])) return true;
  return nonBlank(env['AZURE_STORAGE_ACCOUNT']) && nonBlank(env['AZURE_STORAGE_KEY']);
}

function normalizeSelector(raw: string | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolves the sidecar's run-store + asset-queue backends, applying the
 * Azure-first default and failing fast when Azure is selected without
 * credentials.
 *
 * Each selector defaults independently: an unset `SPRITES_RUN_STORE` resolves
 * to `azure-blob` and an unset `SPRITES_ASSET_QUEUE` resolves to `azure-queue`.
 * Unknown non-empty values are passed through unchanged so the downstream
 * factory raises its own "Unknown ..." error.
 *
 * @throws {SidecarAzureCredentialsError} when an Azure backend is selected but
 *   no Storage credentials are present.
 */
export function resolveSidecarBackends(
  env: Record<string, string | undefined>,
): SidecarBackendSelection {
  const runStore = normalizeSelector(env['SPRITES_RUN_STORE']) ?? SIDECAR_AZURE_RUN_STORE;
  const assetQueue = normalizeSelector(env['SPRITES_ASSET_QUEUE']) ?? SIDECAR_AZURE_ASSET_QUEUE;
  const usesAzure =
    runStore === SIDECAR_AZURE_RUN_STORE || assetQueue === SIDECAR_AZURE_ASSET_QUEUE;

  if (usesAzure && !hasAzureStorageCreds(env)) {
    throw new SidecarAzureCredentialsError(runStore, assetQueue);
  }

  return { runStore, assetQueue, usesAzure };
}
