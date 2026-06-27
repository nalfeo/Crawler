/**
 * Unit tests for the sidecar backend-selection policy (backend-config.ts) and
 * the shared `.env.local` loader (env-local.ts).
 *
 * The sidecar defaults to the Azure backends; local/noop are opt-in for tests
 * and offline runs. No Azure SDK is constructed here — only the pure selector +
 * credential-detection logic is exercised with stub env maps.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hasAzureStorageCreds,
  resolveSidecarBackends,
  SidecarAzureCredentialsError,
} from '../../../scripts/sprites/sidecar/backend-config.js';
import { loadEnvLocal } from '../../../scripts/sprites/sidecar/env-local.js';

const AZURE_CREDS = {
  AZURE_STORAGE_ACCOUNT: 'crawlersprites',
  AZURE_STORAGE_KEY: 'dGVzdA==',
} as const;

describe('resolveSidecarBackends', () => {
  it('defaults to Azure backends when selectors are unset (creds present)', () => {
    const result = resolveSidecarBackends({ ...AZURE_CREDS });
    expect(result.runStore).toBe('azure-blob');
    expect(result.assetQueue).toBe('azure-queue');
    expect(result.usesAzure).toBe(true);
  });

  it('accepts a connection string as Azure credentials', () => {
    const result = resolveSidecarBackends({
      AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
    });
    expect(result.usesAzure).toBe(true);
  });

  it('throws actionable error when Azure is the default but no creds present', () => {
    expect(() => resolveSidecarBackends({})).toThrow(SidecarAzureCredentialsError);
    expect(() => resolveSidecarBackends({})).toThrow(/npm run setup:azure/);
    expect(() => resolveSidecarBackends({})).toThrow(
      /SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop/,
    );
  });

  it('throws when account is set but key is missing (incomplete creds)', () => {
    expect(() => resolveSidecarBackends({ AZURE_STORAGE_ACCOUNT: 'crawlersprites' })).toThrow(
      SidecarAzureCredentialsError,
    );
  });

  it('allows fully-local opt-in without any Azure credentials', () => {
    const result = resolveSidecarBackends({
      SPRITES_RUN_STORE: 'local',
      SPRITES_ASSET_QUEUE: 'noop',
    });
    expect(result.runStore).toBe('local');
    expect(result.assetQueue).toBe('noop');
    expect(result.usesAzure).toBe(false);
  });

  it('still requires creds when only the store is set local (queue defaults to azure)', () => {
    expect(() => resolveSidecarBackends({ SPRITES_RUN_STORE: 'local' })).toThrow(
      SidecarAzureCredentialsError,
    );
  });

  it('lowercases and trims selectors', () => {
    const result = resolveSidecarBackends({
      SPRITES_RUN_STORE: '  LOCAL ',
      SPRITES_ASSET_QUEUE: 'NOOP',
    });
    expect(result.runStore).toBe('local');
    expect(result.assetQueue).toBe('noop');
    expect(result.usesAzure).toBe(false);
  });

  it('treats an empty selector as unset (Azure default)', () => {
    const result = resolveSidecarBackends({ SPRITES_RUN_STORE: '', ...AZURE_CREDS });
    expect(result.runStore).toBe('azure-blob');
  });

  it('passes unknown values through (factory validates them downstream)', () => {
    const result = resolveSidecarBackends({
      SPRITES_RUN_STORE: 'local',
      SPRITES_ASSET_QUEUE: 'kafka',
    });
    // 'kafka' is not azure-queue, so no creds are demanded here; the queue
    // factory raises the "Unknown ..." error later.
    expect(result.assetQueue).toBe('kafka');
    expect(result.usesAzure).toBe(false);
  });
});

describe('hasAzureStorageCreds', () => {
  it('is true with account + key', () => {
    expect(hasAzureStorageCreds({ ...AZURE_CREDS })).toBe(true);
  });

  it('is true with a connection string', () => {
    expect(hasAzureStorageCreds({ AZURE_STORAGE_CONNECTION_STRING: 'x' })).toBe(true);
  });

  it('is false with neither', () => {
    expect(hasAzureStorageCreds({})).toBe(false);
  });

  it('is false with account but no key', () => {
    expect(hasAzureStorageCreds({ AZURE_STORAGE_ACCOUNT: 'a' })).toBe(false);
  });
});

describe('loadEnvLocal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'crawler-envlocal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when .env.local is absent', () => {
    const env: Record<string, string | undefined> = {};
    loadEnvLocal(dir, env);
    expect(env).toEqual({});
  });

  it('merges key=value pairs and skips comments/blank lines', () => {
    writeFileSync(
      path.join(dir, '.env.local'),
      [
        '# comment',
        '',
        'AZURE_STORAGE_ACCOUNT=crawlersprites',
        'SPRITES_RUN_STORE=azure-blob',
      ].join('\n'),
    );
    const env: Record<string, string | undefined> = {};
    loadEnvLocal(dir, env);
    expect(env['AZURE_STORAGE_ACCOUNT']).toBe('crawlersprites');
    expect(env['SPRITES_RUN_STORE']).toBe('azure-blob');
  });

  it('does not overwrite values already set in the environment', () => {
    writeFileSync(path.join(dir, '.env.local'), 'SPRITES_RUN_STORE=azure-blob');
    const env: Record<string, string | undefined> = { SPRITES_RUN_STORE: 'local' };
    loadEnvLocal(dir, env);
    expect(env['SPRITES_RUN_STORE']).toBe('local');
  });

  it('keeps "=" characters in the value (e.g. base64 keys)', () => {
    writeFileSync(path.join(dir, '.env.local'), 'AZURE_STORAGE_KEY=ab==cd==');
    const env: Record<string, string | undefined> = {};
    loadEnvLocal(dir, env);
    expect(env['AZURE_STORAGE_KEY']).toBe('ab==cd==');
  });
});
