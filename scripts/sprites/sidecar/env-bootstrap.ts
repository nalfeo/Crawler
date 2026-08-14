/**
 * Fast, safe `.env.local` bootstrap for `npm run sprites:gallery`.
 *
 * The sidecar defaults to the shared **Azure** backends (see `backend-config.ts`),
 * so on a genuinely fresh worktree — where `.env.local` does not exist yet — it
 * would otherwise fail fast with "Azure credentials missing" and force the
 * operator to know the manual setup step. This module makes the launcher a true
 * one command: when (and only when) the sidecar needs Azure credentials it does
 * not already have, it runs the **fast, env-only** setup path
 * (`pwsh scripts/setup-azure-env.ps1 -IncludeStorage`, ~18s) to write
 * `.env.local`, then re-reads it. The full `npm run setup:azure`
 * (`-ProvisionResources`, ~228s) is reserved for first-time resource provisioning.
 *
 * Safety invariants (do not regress — see the plan-review ledger):
 *  - **Hot path is free.** If the required credentials are already present
 *    (shell env or an existing complete `.env.local`), bootstrap is skipped with
 *    ~0 latency.
 *  - **Never clobber a user's file.** Auto-generation only happens when
 *    `.env.local` is *absent*. An existing-but-incomplete file raises an
 *    actionable error pointing at `npm run setup:azure:env:force` — it is never
 *    overwritten (the ps1 rewrites the whole file, so a blind `-Force` would drop
 *    hand-edited keys).
 *  - **No stale shadow.** Because auto-write only runs when the file was absent,
 *    the launcher's earlier `loadEnvLocal` loaded nothing, so no stale value can
 *    shadow the freshly written credentials on reload. Explicit shell overrides
 *    intentionally stay authoritative.
 *  - **Cloud/CI is not a fresh worktree.** In CI/Codespaces the ps1 no-ops, so we
 *    detect the cloud env up front and raise a cloud-specific error instead of
 *    "successfully" running a script that writes nothing.
 *  - **Never silently fall back to local/noop.** Respecting the Azure-required
 *    policy, every failure path is a hard error; the only way to local backends is
 *    the explicit `SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop` opt-in, which
 *    short-circuits the whole check.
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  hasAzureStorageCreds,
  SIDECAR_AZURE_ASSET_QUEUE,
  SIDECAR_AZURE_RUN_STORE,
} from './backend-config.js';
import { loadEnvLocal } from './env-local.js';

type EnvMap = Record<string, string | undefined>;

const nonBlank = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Mirrors `setup-azure-env.ps1`'s `[bool]($env:CI -or $env:GITHUB_ACTIONS -or
 * $env:CODESPACES)`: any non-empty value marks a cloud/CI environment.
 */
const present = (value: string | undefined): boolean => typeof value === 'string' && value !== '';

/**
 * True when the environment carries Azure OpenAI credentials (endpoint + key).
 *
 * These are the hard requirement for the worker's default `azure-openai` image
 * provider — `createImageProvider` throws without them, so the auto-started
 * worker would report `running=false`. The chat/vision/image *deployment* names
 * are NOT required for the worker to start (the synth provider is optional and
 * the image deployment defaults to `gpt-image-1`), so they are intentionally not
 * part of this predicate.
 */
export function hasAzureOpenAiCreds(env: EnvMap): boolean {
  return nonBlank(env['AZURE_OPENAI_ENDPOINT']) && nonBlank(env['AZURE_OPENAI_API_KEY']);
}

/** True in CI / GitHub Actions / Codespaces, where local `.env.local` bootstrap is disabled. */
export function isCloudEnv(env: EnvMap): boolean {
  return present(env['CI']) || present(env['GITHUB_ACTIONS']) || present(env['CODESPACES']);
}

/**
 * True when the image provider is the Azure OpenAI path (the default). When the
 * operator opts into `SPRITES_PROVIDER=local-a1111` or `SPRITES_PROVIDER=foundry`,
 * the image provider reads different credentials — which the Azure env bootstrap
 * cannot write — so we must NOT demand (or try to bootstrap) `AZURE_OPENAI_*` on
 * those paths.
 */
export function imageProviderIsAzureOpenAi(env: EnvMap): boolean {
  const which = (env['SPRITES_PROVIDER'] ?? '').trim().toLowerCase() || 'azure-openai';
  return which !== 'local-a1111' && which !== 'foundry';
}

export function imageProviderIsFoundry(env: EnvMap): boolean {
  return (env['SPRITES_PROVIDER'] ?? '').trim().toLowerCase() === 'foundry';
}

export function hasFoundryImageCreds(env: EnvMap): boolean {
  return (
    nonBlank(env['FOUNDRY_ENDPOINT']) &&
    nonBlank(env['FOUNDRY_API_KEY']) &&
    nonBlank(env['FOUNDRY_IMAGE_MODEL'])
  );
}

function normalizeSelector(raw: string | undefined, fallback: string): string {
  if (raw == null) return fallback;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Pure, tiered predicate: does the sidecar need Azure credentials it does not
 * currently have? Mirrors `resolveSidecarBackends` defaulting so the launcher's
 * bootstrap decision matches the runtime's success/fail condition exactly.
 *
 *  - Fully-local opt-in (`local` + `noop`) → false (respect it; adds ~0 latency).
 *  - Any Azure backend selected but no Azure Storage creds → true (queue + blob
 *    store both live in Azure Storage).
 *  - Azure queue selected (which auto-starts the worker) on the azure-openai
 *    image provider but no Azure OpenAI creds → true.
 *  - Azure queue selected on the foundry image provider but no Foundry image
 *    creds → true.
 *  - Otherwise → false.
 */
export function needsAzureEnvBootstrap(env: EnvMap): boolean {
  const runStore = normalizeSelector(env['SPRITES_RUN_STORE'], SIDECAR_AZURE_RUN_STORE);
  const assetQueue = normalizeSelector(env['SPRITES_ASSET_QUEUE'], SIDECAR_AZURE_ASSET_QUEUE);
  const usesAzureStore = runStore === SIDECAR_AZURE_RUN_STORE;
  const usesAzureQueue = assetQueue === SIDECAR_AZURE_ASSET_QUEUE;

  if (!usesAzureStore && !usesAzureQueue) return false;
  if (!hasAzureStorageCreds(env)) return true;
  if (usesAzureQueue && imageProviderIsAzureOpenAi(env) && !hasAzureOpenAiCreds(env)) return true;
  if (usesAzureQueue && imageProviderIsFoundry(env) && !hasFoundryImageCreds(env)) return true;
  return false;
}

/**
 * Human-readable list of the Azure requirements the environment is missing, for
 * error messages and tests. Empty when nothing is missing (or fully-local).
 */
export function missingAzureRequirements(env: EnvMap): string[] {
  const runStore = normalizeSelector(env['SPRITES_RUN_STORE'], SIDECAR_AZURE_RUN_STORE);
  const assetQueue = normalizeSelector(env['SPRITES_ASSET_QUEUE'], SIDECAR_AZURE_ASSET_QUEUE);
  const usesAzureStore = runStore === SIDECAR_AZURE_RUN_STORE;
  const usesAzureQueue = assetQueue === SIDECAR_AZURE_ASSET_QUEUE;

  const missing: string[] = [];
  if (!usesAzureStore && !usesAzureQueue) return missing;
  if (!hasAzureStorageCreds(env)) {
    missing.push(
      'Azure Storage credentials (AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT + AZURE_STORAGE_KEY)',
    );
  }
  if (usesAzureQueue && imageProviderIsAzureOpenAi(env) && !hasAzureOpenAiCreds(env)) {
    missing.push('Azure OpenAI credentials (AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY)');
  }
  if (usesAzureQueue && imageProviderIsFoundry(env) && !hasFoundryImageCreds(env)) {
    missing.push(
      'Foundry image credentials (FOUNDRY_ENDPOINT + FOUNDRY_API_KEY + FOUNDRY_IMAGE_MODEL)',
    );
  }
  return missing;
}

/** Raised for every bootstrap failure; carries a multi-line, actionable message. */
export class EnvBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvBootstrapError';
  }
}

export type EnvBootstrapResult = 'skipped' | 'bootstrapped';

/** Minimal `spawnSync` shape used here — narrowed so tests can inject a stub. */
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => { status: number | null; error?: (Error & { code?: string }) | undefined };

const defaultSpawn: SpawnFn = (command, args, options) => {
  const result = spawnSync(command, args, options);
  return { status: result.status, error: result.error as (Error & { code?: string }) | undefined };
};

export interface EnsureAzureEnvLocalOptions {
  readonly repoRoot: string;
  readonly env?: EnvMap;
  readonly log?: (message: string) => void;
  readonly spawn?: SpawnFn;
  readonly reload?: (repoRoot: string, env: EnvMap) => void;
  readonly fileExists?: (filePath: string) => boolean;
}

const LOCAL_OPT_IN_HINT =
  '  SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop npm run sprites:gallery';

/**
 * Ensure the Azure credentials the sidecar needs are available, bootstrapping
 * `.env.local` via the fast env-only setup path on a fresh worktree. Returns
 * `'skipped'` when nothing was needed and `'bootstrapped'` when it generated the
 * file. Throws {@link EnvBootstrapError} (never silently degrades) on any failure.
 */
export function ensureAzureEnvLocal(options: EnsureAzureEnvLocalOptions): EnvBootstrapResult {
  const {
    repoRoot,
    env = process.env,
    log = (message: string) => process.stderr.write(`${message}\n`),
    spawn = defaultSpawn,
    reload = loadEnvLocal,
    fileExists = existsSync,
  } = options;

  if (!needsAzureEnvBootstrap(env)) return 'skipped';

  const missing = missingAzureRequirements(env);

  if (isCloudEnv(env)) {
    throw new EnvBootstrapError(
      [
        'Sidecar needs provider credentials but this is a cloud/CI environment',
        '(CI / GITHUB_ACTIONS / CODESPACES set), where local `.env.local` bootstrap is disabled.',
        '',
        `Missing: ${missing.join('; ')}`,
        '',
        'Inject these via environment variables / secrets. For an explicit offline run:',
        LOCAL_OPT_IN_HINT,
      ].join('\n'),
    );
  }

  const envFile = path.join(repoRoot, '.env.local');

  if (fileExists(envFile)) {
    throw new EnvBootstrapError(
      [
        '`.env.local` exists but is missing required provider credentials, so the sidecar',
        'cannot start on the selected backends.',
        '',
        `Missing: ${missing.join('; ')}`,
        '',
        'To avoid clobbering settings you may have hand-edited, the launcher will NOT',
        'overwrite an existing `.env.local` automatically. Choose one:',
        '  - Regenerate it from Azure (fast, env-only):  npm run setup:azure:env:force',
        '  - Add the missing keys to `.env.local` by hand.',
        `  - Run fully local (offline):\n${LOCAL_OPT_IN_HINT}`,
      ].join('\n'),
    );
  }

  // Fresh worktree: `.env.local` is absent. Generate it via the fast, env-only
  // setup path — no `-Force` (the file does not exist) and no resource
  // provisioning (that is `npm run setup:azure`).
  log(
    '[launcher] .env.local not found - bootstrapping Azure credentials via the fast env-only path...',
  );
  log(
    '[launcher]   pwsh scripts/setup-azure-env.ps1 -IncludeStorage ' +
      '(run `npm run setup:azure` once for first-time resource provisioning)',
  );

  const scriptPath = path.join(repoRoot, 'scripts', 'setup-azure-env.ps1');
  const result = spawn('pwsh', ['-NoProfile', '-File', scriptPath, '-IncludeStorage'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new EnvBootstrapError(
        [
          'Could not run the Azure env bootstrap: `pwsh` (PowerShell 7+) was not found on PATH.',
          '',
          'Install PowerShell 7 (https://aka.ms/powershell) so `pwsh` is on PATH and retry, set up',
          'credentials another way (`npm run setup:azure:env`), or run fully local:',
          LOCAL_OPT_IN_HINT,
        ].join('\n'),
      );
    }
    throw new EnvBootstrapError(
      `Could not run the Azure env bootstrap (pwsh scripts/setup-azure-env.ps1): ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new EnvBootstrapError(
      [
        `Azure env bootstrap failed (pwsh scripts/setup-azure-env.ps1 -IncludeStorage exited ${result.status}).`,
        'See the setup-azure-env.ps1 output above for the specific error. Common causes:',
        '  - Not logged in / stale session - run `az login` (then `az account set --subscription <id>`).',
        '  - Wrong subscription or tenant selected.',
        '  - Azure CLI (`az`) not installed or not on PATH.',
        '  - Transient failure fetching storage keys / the OpenAI endpoint.',
        '',
        'Fix the above and retry `npm run sprites:gallery`, or run fully local:',
        LOCAL_OPT_IN_HINT,
      ].join('\n'),
    );
  }

  // Re-read the freshly written file into env and confirm the creds landed.
  reload(repoRoot, env);
  if (needsAzureEnvBootstrap(env)) {
    throw new EnvBootstrapError(
      [
        'Azure env bootstrap ran but the required credentials are still missing:',
        `  ${missingAzureRequirements(env).join('; ')}`,
        '',
        'The setup script may have skipped writing or produced a partial file. Inspect',
        '`.env.local`, run `npm run setup:azure:env:force`, or run fully local:',
        LOCAL_OPT_IN_HINT,
      ].join('\n'),
    );
  }

  return 'bootstrapped';
}
