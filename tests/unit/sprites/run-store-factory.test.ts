/**
 * Unit tests for the RunStore factory (createRunStore).
 *
 * The Azure implementation is not constructed here because it would require
 * valid Azure credentials. The factory logic (env-var dispatch, error messages)
 * is tested with a stub env map instead.
 */

import { describe, expect, it } from 'vitest';
import { createRunStore } from '../../../scripts/sprites/store/index.js';

const REPO_ROOT = '/fake/repo';

describe('createRunStore factory', () => {
  it('returns LocalRunStore by default (no env)', () => {
    const store = createRunStore({ env: {}, repoRoot: REPO_ROOT });
    expect(store.backend).toBe('local');
  });

  it('returns LocalRunStore when SPRITES_RUN_STORE=local', () => {
    const store = createRunStore({ env: { SPRITES_RUN_STORE: 'local' }, repoRoot: REPO_ROOT });
    expect(store.backend).toBe('local');
  });

  it('throws on unknown backend value', () => {
    expect(() => createRunStore({ env: { SPRITES_RUN_STORE: 's3' }, repoRoot: REPO_ROOT })).toThrow(
      "Unknown SPRITES_RUN_STORE 's3'",
    );
  });

  it('throws on missing AZURE_STORAGE_ACCOUNT when azure-blob requested', () => {
    expect(() =>
      createRunStore({
        env: { SPRITES_RUN_STORE: 'azure-blob' },
        repoRoot: REPO_ROOT,
      }),
    ).toThrow("Missing required env var 'AZURE_STORAGE_ACCOUNT'");
  });

  it('throws on missing AZURE_STORAGE_KEY when azure-blob requested', () => {
    expect(() =>
      createRunStore({
        env: {
          SPRITES_RUN_STORE: 'azure-blob',
          AZURE_STORAGE_ACCOUNT: 'myaccount',
        },
        repoRoot: REPO_ROOT,
      }),
    ).toThrow("Missing required env var 'AZURE_STORAGE_KEY'");
  });

  it('constructs AzureBlobRunStore when all required vars present', () => {
    const store = createRunStore({
      env: {
        SPRITES_RUN_STORE: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'myaccount',
        AZURE_STORAGE_KEY: 'dGVzdA==',
        SPRITES_AZURE_CACHE: 'off',
      },
      repoRoot: REPO_ROOT,
    });
    expect(store.backend).toBe('azure-blob');
  });

  it('wraps the Azure store in the local sheet cache by default', () => {
    const store = createRunStore({
      env: {
        SPRITES_RUN_STORE: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'myaccount',
        AZURE_STORAGE_KEY: 'dGVzdA==',
      },
      repoRoot: REPO_ROOT,
    });
    // Proxied backend tag stays the same; the wrapper is transparent.
    expect(store.backend).toBe('azure-blob');
    expect(store.constructor.name).toBe('CachingRunStore');
  });

  it('skips the cache wrapper when SPRITES_AZURE_CACHE=off', () => {
    const store = createRunStore({
      env: {
        SPRITES_RUN_STORE: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'myaccount',
        AZURE_STORAGE_KEY: 'dGVzdA==',
        SPRITES_AZURE_CACHE: 'off',
      },
      repoRoot: REPO_ROOT,
    });
    expect(store.constructor.name).toBe('AzureBlobRunStore');
  });

  it('defaults the cache size cap to 2 GiB', () => {
    const store = createRunStore({
      env: {
        SPRITES_RUN_STORE: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'myaccount',
        AZURE_STORAGE_KEY: 'dGVzdA==',
      },
      repoRoot: REPO_ROOT,
    });
    // White-box: the factory must pass the parsed byte budget to the wrapper.
    expect((store as unknown as { maxCacheBytes: number }).maxCacheBytes).toBe(
      2 * 1024 * 1024 * 1024,
    );
  });

  it('wires SPRITES_AZURE_CACHE_MAX_BYTES through to the cache size cap', () => {
    const store = createRunStore({
      env: {
        SPRITES_RUN_STORE: 'azure-blob',
        AZURE_STORAGE_ACCOUNT: 'myaccount',
        AZURE_STORAGE_KEY: 'dGVzdA==',
        SPRITES_AZURE_CACHE_MAX_BYTES: '5242880',
      },
      repoRoot: REPO_ROOT,
    });
    expect((store as unknown as { maxCacheBytes: number }).maxCacheBytes).toBe(5242880);
  });

  it('resolve() on LocalRunStore returns path inside generated/runs', () => {
    const store = createRunStore({ env: {}, repoRoot: REPO_ROOT });
    const resolved = store.resolve('iron-sword/run-001/summary.json');
    expect(resolved).toContain('generated');
    expect(resolved).toContain('iron-sword');
  });
});
