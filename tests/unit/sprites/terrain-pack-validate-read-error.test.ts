/**
 * Isolated read-failure tests for validate.ts using vi.mock to simulate EACCES
 * without any platform-specific permission changes.
 *
 * Kept in a separate file so `vi.mock('node:fs')` hoisting does not interfere
 * with the real-file integration tests in terrain-pack-build.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { Stats } from 'node:fs';

// ── Hoisted mock functions ─────────────────────────────────────────────────
const { mockStatSync, mockReadFileSync } = vi.hoisted(() => ({
  mockStatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

// Intercept node:fs so that validate.ts's named imports use these mocks.
// build-industrial-cave.ts uses a default import (pure build fn, no disk IO),
// so actual.default is unaffected and buildIndustrialCavePack() still works.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    statSync: mockStatSync,
    readFileSync: mockReadFileSync,
  };
});

import {
  validatePoolAndDoorImages,
  validateWallAutotileImagePath,
} from '../../../scripts/sprites/terrain-packs/validate.js';
import { buildIndustrialCavePack } from '../../../scripts/sprites/terrain-packs/build-industrial-cave.js';

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

function fakeFileStat(): Stats {
  return { isFile: () => true } as unknown as Stats;
}

const eaccesError = Object.assign(new Error('EACCES: permission denied, read ...'), {
  code: 'EACCES',
});

describe('validateWallAutotileImagePath — readFileSync EACCES produces image-read-error', () => {
  afterEach(() => vi.resetAllMocks());

  it('reports image-read-error (not throw) when readFileSync throws after a valid stat', () => {
    const { manifest } = buildIndustrialCavePack();
    const opts = { repoRoot: repoRoot() };

    // Two identical runs — one consumed by the not.toThrow check, one for assertions.
    const run = (): ReturnType<typeof validateWallAutotileImagePath> => {
      mockStatSync.mockReturnValueOnce(fakeFileStat());
      mockReadFileSync.mockImplementationOnce(() => {
        throw eaccesError;
      });
      return validateWallAutotileImagePath(manifest, opts);
    };

    expect(run).not.toThrow();
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'image-read-error')).toBe(true);
    expect(result.issues.every((i) => i.code !== 'image-missing')).toBe(true);
  });
});

describe('validatePoolAndDoorImages — readFileSync EACCES produces image-read-error', () => {
  afterEach(() => vi.resetAllMocks());

  it('reports image-read-error (not throw) on every pool/door entry when readFileSync throws', () => {
    const { manifest } = buildIndustrialCavePack();
    const entryCount = manifest.floorPool.length + manifest.corridorPool.length;
    const opts = { repoRoot: repoRoot() };

    // All stats succeed; all reads fail.
    mockStatSync.mockReturnValue(fakeFileStat());
    mockReadFileSync.mockImplementation(() => {
      throw eaccesError;
    });

    expect(() => validatePoolAndDoorImages(manifest, opts)).not.toThrow();

    mockStatSync.mockReturnValue(fakeFileStat());
    mockReadFileSync.mockImplementation(() => {
      throw eaccesError;
    });

    const result = validatePoolAndDoorImages(manifest, opts);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(entryCount);
    expect(result.issues.every((i) => i.code === 'image-read-error')).toBe(true);
  });
});
