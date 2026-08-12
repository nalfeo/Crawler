/**
 * Unit tests for the sidecar `.env.local` bootstrap (env-bootstrap.ts).
 *
 * These exercise the PURE decision logic (`needsAzureEnvBootstrap`,
 * `hasAzureOpenAiCreds`, `isCloudEnv`, `imageProviderIsAzureOpenAi`,
 * `missingAzureRequirements`) plus the side-effecting orchestrator
 * (`ensureAzureEnvLocal`) with every external dependency injected — no `pwsh`,
 * filesystem, or real `process.env` is touched. The goal is that the launcher's
 * "bootstrap or skip?" decision provably matches the sidecar's real
 * Azure-backend success condition, and that no failure path silently degrades to
 * the local backends.
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  ensureAzureEnvLocal,
  EnvBootstrapError,
  hasAzureOpenAiCreds,
  hasFoundryImageCreds,
  imageProviderIsAzureOpenAi,
  imageProviderIsFoundry,
  isCloudEnv,
  missingAzureRequirements,
  needsAzureEnvBootstrap,
} from '../../../scripts/sprites/sidecar/env-bootstrap.js';

const STORAGE = {
  AZURE_STORAGE_ACCOUNT: 'crawlersprites',
  AZURE_STORAGE_KEY: 'dGVzdA==',
} as const;

const OPENAI = {
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com/',
  AZURE_OPENAI_API_KEY: 'sk-test',
} as const;

const FOUNDRY = {
  FOUNDRY_ENDPOINT: 'https://swedencentral.api.cognitive.microsoft.com',
  FOUNDRY_API_KEY: 'foundry-key',
  FOUNDRY_IMAGE_MODEL: 'bench-gpt-image-2',
} as const;

/** A complete set of creds for the default Azure backends (worker can start). */
const FULL_AZURE = { ...STORAGE, ...OPENAI } as const;

const REPO = '/repo';
const ENV_FILE = path.join(REPO, '.env.local');
const SCRIPT_PATH = path.join(REPO, 'scripts', 'setup-azure-env.ps1');

describe('hasAzureOpenAiCreds', () => {
  it('is true with endpoint + key', () => {
    expect(hasAzureOpenAiCreds({ ...OPENAI })).toBe(true);
  });

  it('is false when either is missing', () => {
    expect(hasAzureOpenAiCreds({ AZURE_OPENAI_ENDPOINT: OPENAI.AZURE_OPENAI_ENDPOINT })).toBe(
      false,
    );
    expect(hasAzureOpenAiCreds({ AZURE_OPENAI_API_KEY: OPENAI.AZURE_OPENAI_API_KEY })).toBe(false);
  });

  it('treats whitespace-only values as missing', () => {
    expect(hasAzureOpenAiCreds({ AZURE_OPENAI_ENDPOINT: '   ', AZURE_OPENAI_API_KEY: '\t' })).toBe(
      false,
    );
  });
});

describe('isCloudEnv', () => {
  it('detects CI / GITHUB_ACTIONS / CODESPACES', () => {
    expect(isCloudEnv({ CI: 'true' })).toBe(true);
    expect(isCloudEnv({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCloudEnv({ CODESPACES: 'true' })).toBe(true);
  });

  it('is false on a bare local env', () => {
    expect(isCloudEnv({})).toBe(false);
  });

  it('treats an empty string as unset (matches the ps1 truthiness)', () => {
    expect(isCloudEnv({ CI: '' })).toBe(false);
  });
});

describe('imageProviderIsAzureOpenAi', () => {
  it('defaults to azure-openai when unset', () => {
    expect(imageProviderIsAzureOpenAi({})).toBe(true);
  });

  it('is false for non-Azure-OpenAI image providers (case/space-insensitive)', () => {
    expect(imageProviderIsAzureOpenAi({ SPRITES_PROVIDER: 'local-a1111' })).toBe(false);
    expect(imageProviderIsAzureOpenAi({ SPRITES_PROVIDER: '  LOCAL-A1111 ' })).toBe(false);
    expect(imageProviderIsAzureOpenAi({ SPRITES_PROVIDER: 'foundry' })).toBe(false);
    expect(imageProviderIsAzureOpenAi({ SPRITES_PROVIDER: '  FOUNDRY ' })).toBe(false);
    expect(imageProviderIsAzureOpenAi({ SPRITES_PROVIDER: 'azure-openai' })).toBe(true);
  });
});

describe('imageProviderIsFoundry', () => {
  it('is true only for the foundry image provider', () => {
    expect(imageProviderIsFoundry({ SPRITES_PROVIDER: 'foundry' })).toBe(true);
    expect(imageProviderIsFoundry({ SPRITES_PROVIDER: '  FOUNDRY ' })).toBe(true);
    expect(imageProviderIsFoundry({})).toBe(false);
    expect(imageProviderIsFoundry({ SPRITES_PROVIDER: 'azure-openai' })).toBe(false);
  });
});

describe('hasFoundryImageCreds', () => {
  it('is true with endpoint + key + image deployment alias', () => {
    expect(hasFoundryImageCreds({ ...FOUNDRY })).toBe(true);
  });

  it('is false when any required Foundry image credential is missing', () => {
    expect(hasFoundryImageCreds({ FOUNDRY_API_KEY: 'key', FOUNDRY_IMAGE_MODEL: 'model' })).toBe(
      false,
    );
    expect(
      hasFoundryImageCreds({
        FOUNDRY_ENDPOINT: FOUNDRY.FOUNDRY_ENDPOINT,
        FOUNDRY_IMAGE_MODEL: 'model',
      }),
    ).toBe(false);
    expect(
      hasFoundryImageCreds({ FOUNDRY_ENDPOINT: FOUNDRY.FOUNDRY_ENDPOINT, FOUNDRY_API_KEY: 'key' }),
    ).toBe(false);
  });
});

describe('needsAzureEnvBootstrap', () => {
  it('needs bootstrap on a bare env (Azure default, no creds)', () => {
    expect(needsAzureEnvBootstrap({})).toBe(true);
  });

  it('skips when full Azure creds are present', () => {
    expect(needsAzureEnvBootstrap({ ...FULL_AZURE })).toBe(false);
  });

  it('accepts a storage connection string in place of account + key', () => {
    expect(
      needsAzureEnvBootstrap({
        AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
        ...OPENAI,
      }),
    ).toBe(false);
  });

  it('respects the fully-local opt-in without any creds', () => {
    expect(
      needsAzureEnvBootstrap({ SPRITES_RUN_STORE: 'local', SPRITES_ASSET_QUEUE: 'noop' }),
    ).toBe(false);
  });

  it('azure-blob store + noop queue needs storage only (worker not started → no OpenAI)', () => {
    // Storage present, no OpenAI creds: the queue is noop so no worker starts,
    // meaning the OpenAI image provider is never built. Must NOT demand OpenAI.
    expect(needsAzureEnvBootstrap({ SPRITES_ASSET_QUEUE: 'noop', ...STORAGE })).toBe(false);
    // ...but if even storage is missing, the azure-blob store still needs it.
    expect(needsAzureEnvBootstrap({ SPRITES_ASSET_QUEUE: 'noop' })).toBe(true);
  });

  it('azure-queue with storage but no OpenAI creds needs bootstrap (worker image provider)', () => {
    expect(needsAzureEnvBootstrap({ ...STORAGE })).toBe(true);
  });

  it('OpenAI creds but no storage still needs bootstrap (queue/store need storage)', () => {
    expect(needsAzureEnvBootstrap({ ...OPENAI })).toBe(true);
  });

  it('treats whitespace-only storage values as missing', () => {
    expect(
      needsAzureEnvBootstrap({
        AZURE_STORAGE_ACCOUNT: '   ',
        AZURE_STORAGE_KEY: '  ',
        ...OPENAI,
      }),
    ).toBe(true);
  });

  it('shell-provided creds (already in env) short-circuit to skip', () => {
    // Simulates the operator exporting creds in the shell; loadEnvLocal would
    // not overwrite them, and bootstrap must add ~0 latency here.
    expect(needsAzureEnvBootstrap({ ...FULL_AZURE, SOME_OTHER: 'x' })).toBe(false);
  });

  it('does not require AZURE_OPENAI_CHAT_DEPLOYMENT (worker starts without it)', () => {
    // The synth provider (which needs a chat deployment) is optional; a missing
    // chat deployment must not force a bootstrap when endpoint+key+storage exist.
    expect(needsAzureEnvBootstrap({ ...FULL_AZURE })).toBe(false);
  });

  it('local-a1111 image provider + storage skips the Azure OpenAI requirement', () => {
    // SPRITES_PROVIDER=local-a1111 reads its own local endpoint, which this
    // bootstrap cannot write, so we must not hard-fail for missing OpenAI.
    expect(needsAzureEnvBootstrap({ SPRITES_PROVIDER: 'local-a1111', ...STORAGE })).toBe(false);
    // Storage is still required (the queue/store are Azure Storage).
    expect(needsAzureEnvBootstrap({ SPRITES_PROVIDER: 'local-a1111' })).toBe(true);
  });

  it('foundry image provider + storage + Foundry creds skips the Azure OpenAI requirement', () => {
    expect(needsAzureEnvBootstrap({ SPRITES_PROVIDER: 'foundry', ...STORAGE, ...FOUNDRY })).toBe(
      false,
    );
    // Storage is still required (the queue/store are Azure Storage).
    expect(needsAzureEnvBootstrap({ SPRITES_PROVIDER: 'foundry', ...FOUNDRY })).toBe(true);
  });

  it('foundry image provider + storage still needs Foundry image creds', () => {
    expect(needsAzureEnvBootstrap({ SPRITES_PROVIDER: 'foundry', ...STORAGE })).toBe(true);
  });
});

describe('missingAzureRequirements', () => {
  it('is empty when nothing is missing', () => {
    expect(missingAzureRequirements({ ...FULL_AZURE })).toEqual([]);
  });

  it('is empty for the fully-local opt-in', () => {
    expect(
      missingAzureRequirements({ SPRITES_RUN_STORE: 'local', SPRITES_ASSET_QUEUE: 'noop' }),
    ).toEqual([]);
  });

  it('lists storage and OpenAI when both are missing', () => {
    const missing = missingAzureRequirements({});
    expect(missing.some((m) => m.includes('Azure Storage'))).toBe(true);
    expect(missing.some((m) => m.includes('Azure OpenAI'))).toBe(true);
  });

  it('lists only OpenAI when storage is present but OpenAI is not', () => {
    const missing = missingAzureRequirements({ ...STORAGE });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('Azure OpenAI');
  });

  it('lists no OpenAI requirement for foundry when Foundry image creds are present', () => {
    expect(
      missingAzureRequirements({ SPRITES_PROVIDER: 'foundry', ...STORAGE, ...FOUNDRY }),
    ).toEqual([]);
  });

  it('lists Foundry image credentials when foundry is selected without them', () => {
    const missing = missingAzureRequirements({ SPRITES_PROVIDER: 'foundry', ...STORAGE });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('Foundry image credentials');
  });
});

describe('ensureAzureEnvLocal', () => {
  /** Build injected deps with sensible defaults; override per test. */
  function harness(
    env: Record<string, string | undefined>,
    overrides: {
      fileExists?: boolean;
      spawnResult?: { status: number | null; error?: (Error & { code?: string }) | undefined };
      reloadWrites?: Record<string, string>;
    } = {},
  ) {
    const log = vi.fn();
    const spawn = vi.fn(
      (_command: string, _args: readonly string[], _options: unknown) =>
        overrides.spawnResult ?? { status: 0 },
    );
    const reload = vi.fn((_repoRoot: string, target: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(overrides.reloadWrites ?? {})) {
        if (!(k in target)) target[k] = v;
      }
    });
    const fileExists = vi.fn(() => overrides.fileExists ?? false);
    const run = () => ensureAzureEnvLocal({ repoRoot: REPO, env, log, spawn, reload, fileExists });
    return { log, spawn, reload, fileExists, run };
  }

  it('skips (no spawn) when creds are already present', () => {
    const h = harness({ ...FULL_AZURE });
    expect(h.run()).toBe('skipped');
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.fileExists).not.toHaveBeenCalled();
  });

  it('bootstraps on a fresh worktree: spawns pwsh WITHOUT -Force, reloads, succeeds', () => {
    const env: Record<string, string | undefined> = {};
    const h = harness(env, { fileExists: false, reloadWrites: FULL_AZURE });
    expect(h.run()).toBe('bootstrapped');

    expect(h.spawn).toHaveBeenCalledTimes(1);
    const call = h.spawn.mock.calls[0];
    if (!call) throw new Error('expected spawn to have been called');
    const [cmd, args, opts] = call;
    expect(cmd).toBe('pwsh');
    expect(args).toContain('-IncludeStorage');
    expect(args).not.toContain('-Force');
    expect(args).toContain(SCRIPT_PATH);
    expect(opts).toMatchObject({ cwd: REPO, stdio: 'inherit' });
    // Reload populated the injected env map.
    expect(env.AZURE_STORAGE_ACCOUNT).toBe(STORAGE.AZURE_STORAGE_ACCOUNT);
  });

  it('refuses to overwrite an existing-but-incomplete .env.local (no spawn)', () => {
    const h = harness({ ...STORAGE }, { fileExists: true });
    expect(() => h.run()).toThrow(EnvBootstrapError);
    try {
      h.run();
    } catch (err) {
      expect((err as Error).message).toContain('setup:azure:env:force');
      expect((err as Error).message).toContain('will NOT');
    }
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.fileExists).toHaveBeenCalledWith(ENV_FILE);
  });

  it('throws a cloud-specific error in CI without running pwsh', () => {
    const h = harness({ CI: 'true' });
    expect(() => h.run()).toThrow(/cloud\/CI environment/i);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.fileExists).not.toHaveBeenCalled();
  });

  it('reports a missing pwsh (ENOENT) with an install hint', () => {
    const enoent = Object.assign(new Error('spawn pwsh ENOENT'), { code: 'ENOENT' });
    const h = harness({}, { fileExists: false, spawnResult: { status: null, error: enoent } });
    expect(() => h.run()).toThrow(/PowerShell 7\+/);
  });

  it('surfaces a non-zero pwsh exit with "see output above" guidance', () => {
    const h = harness({}, { fileExists: false, spawnResult: { status: 1 } });
    expect(() => h.run()).toThrow(/exited 1/);
    try {
      h.run();
    } catch (err) {
      expect((err as Error).message).toContain('az login');
      expect((err as Error).message).toContain('setup-azure-env.ps1 output above');
    }
  });

  it('throws when bootstrap ran but creds are still missing after reload', () => {
    // pwsh exits 0 but writes nothing useful (reloadWrites empty).
    const h = harness({}, { fileExists: false, spawnResult: { status: 0 }, reloadWrites: {} });
    expect(() => h.run()).toThrow(/still missing/i);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('never silently falls back to local (all failure paths throw)', () => {
    const h = harness({}, { fileExists: false, spawnResult: { status: 2 } });
    expect(() => h.run()).toThrow(EnvBootstrapError);
  });
});
