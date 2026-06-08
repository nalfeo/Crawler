import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseArgs } from '../../../scripts/sprites/asset-plan-cli.js';

describe('asset-plan-cli parseArgs', () => {
  it('accepts positional plan path and defaults', () => {
    expect(parseArgs(['plans/floor-art/rat-themed-dungeon-floor.art.yaml'])).toEqual({
      planPath: 'plans/floor-art/rat-themed-dungeon-floor.art.yaml',
      manifestPath: path.join('public', 'assets', 'generated', 'manifest.json'),
      format: 'table',
      failOnPlaceholder: false,
    });
  });

  it('parses explicit flags', () => {
    expect(
      parseArgs([
        '--plan',
        'plans/floor-art/rat-themed-dungeon-floor.art.yaml',
        '--manifest',
        'tmp/manifest.json',
        '--format',
        'json',
        '--fail-on-placeholder',
      ]),
    ).toEqual({
      planPath: 'plans/floor-art/rat-themed-dungeon-floor.art.yaml',
      manifestPath: 'tmp/manifest.json',
      format: 'json',
      failOnPlaceholder: true,
    });
  });

  it('rejects unknown flags and missing plan path', () => {
    expect(() => parseArgs(['--unknown'])).toThrow(/Unknown flag/);
    expect(() => parseArgs([])).toThrow(/Missing plan path/);
  });

  it('rejects invalid format values', () => {
    expect(() => parseArgs(['plan.yaml', '--format', 'xml'])).toThrow(/--format must be/);
  });
});
