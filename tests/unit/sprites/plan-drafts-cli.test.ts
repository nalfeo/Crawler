import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseArgs } from '../../../scripts/sprites/plan-drafts-cli.js';

describe('plan-drafts-cli parseArgs', () => {
  it('accepts positional plan path and defaults', () => {
    expect(parseArgs(['plans/floor-art/rat-themed-dungeon-floor.art.yaml'])).toEqual({
      planPath: 'plans/floor-art/rat-themed-dungeon-floor.art.yaml',
      manifestPath: path.join('public', 'assets', 'generated', 'manifest.json'),
      outputRoot: path.join('briefs', 'draft'),
      statuses: ['needs-art-placeholder', 'planned'],
      types: [],
      force: false,
      dryRun: false,
    });
  });

  it('parses repeated and comma-separated status/type filters', () => {
    expect(
      parseArgs([
        '--plan',
        'plans/floor-art/rat-themed-dungeon-floor.art.yaml',
        '--status',
        'planned,draft-ready-placeholder',
        '--status',
        'needs-art-placeholder',
        '--type',
        'enemy,item',
        '--type',
        'tile',
        '--manifest',
        'tmp/manifest.json',
        '--output-root',
        'tmp/drafts',
        '--force',
        '--dry-run',
      ]),
    ).toEqual({
      planPath: 'plans/floor-art/rat-themed-dungeon-floor.art.yaml',
      manifestPath: 'tmp/manifest.json',
      outputRoot: 'tmp/drafts',
      statuses: ['planned', 'draft-ready-placeholder', 'needs-art-placeholder'],
      types: ['enemy', 'item', 'tile'],
      force: true,
      dryRun: true,
    });
  });

  it('rejects invalid flags and missing plan path', () => {
    expect(() => parseArgs(['--unknown'])).toThrow(/Unknown flag/);
    expect(() => parseArgs([])).toThrow(/Missing plan path/);
    expect(() => parseArgs(['plan.yaml', '--type', 'mob'])).toThrow(/not a valid sprite type/);
  });
});
