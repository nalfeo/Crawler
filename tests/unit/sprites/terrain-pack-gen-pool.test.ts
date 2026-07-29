/**
 * Regression guard for `discoverPoolIndices` in `scripts/sprites/terrain-packs/gen/cli.ts`.
 *
 * The original `readPackPool` implementation broke at the first missing index, so
 * an interior gap (floor-0 + floor-2 present, floor-1 absent) silently produced a
 * one-variant pool and triggered a destructive rebuild downgrade — instead of
 * failing. This suite exercises that exact scenario and the surrounding invariants.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { discoverPoolIndices } from '../../../scripts/sprites/terrain-packs/gen/cli.js';

describe('discoverPoolIndices — source-pool contiguity guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function touch(name: string): void {
    fs.writeFileSync(path.join(tmpDir, name), '');
  }

  it('returns sorted indices for a complete contiguous pool', () => {
    touch('floor-0.png');
    touch('floor-1.png');
    touch('floor-2.png');
    touch('floor-3.png');
    expect(discoverPoolIndices(tmpDir, 'floor')).toEqual([0, 1, 2, 3]);
  });

  it('returns a single-element pool when only index 0 is present', () => {
    touch('floor-0.png');
    expect(discoverPoolIndices(tmpDir, 'floor')).toEqual([0]);
  });

  it('throws for an interior gap (floor-1.png absent, floor-2 and floor-3 present)', () => {
    touch('floor-0.png');
    // floor-1.png intentionally absent — this is the regression case
    touch('floor-2.png');
    touch('floor-3.png');
    expect(() => discoverPoolIndices(tmpDir, 'floor')).toThrow(/non-contiguous/);
  });

  it('throws when no matching files exist', () => {
    expect(() => discoverPoolIndices(tmpDir, 'floor')).toThrow(/no.*floor/i);
  });

  it('does not cross-contaminate prefixes', () => {
    touch('floor-0.png');
    touch('floor-1.png');
    touch('corridor-0.png');
    touch('corridor-1.png');
    touch('corridor-2.png');
    expect(discoverPoolIndices(tmpDir, 'floor')).toEqual([0, 1]);
    expect(discoverPoolIndices(tmpDir, 'corridor')).toEqual([0, 1, 2]);
  });

  it('ignores non-matching files in the same directory', () => {
    touch('floor-0.png');
    touch('floor-1.png');
    touch('wall-atlas.png');
    touch('wall-material.png');
    touch('door-material.png');
    expect(discoverPoolIndices(tmpDir, 'floor')).toEqual([0, 1]);
  });
});
