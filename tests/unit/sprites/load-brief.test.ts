/**
 * Tests for the YAML brief loader. The loader is one of the rare modules that
 * actually touches the disk, so the test writes small fixtures to a temp dir
 * to exercise palette resolution end-to-end without a fake-fs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBrief } from '../../../scripts/sprites/load-brief.js';

const SAMPLE_BRIEF_YAML = `
type: weapon
name: iron-sword
size: { width: 16, height: 16 }
palette:
  id: kenney-roguelike
anchor: { x: 8, y: 14 }
tags: [sword, melee]
prompt: |
  An iron sword, pixel-art style, blade up-right.
references:
  - { path: 'public/assets/kenney/tiny-dungeon/spritesheet.png' }
  - { path: 'public/assets/kenney/roguelike-rpg-pack/spritesheet.png' }
`.trim();

describe('loadBrief', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-loadbrief-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'briefs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses a YAML brief, validates it, and resolves the palette from disk', () => {
    const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
    writeFileSync(briefPath, SAMPLE_BRIEF_YAML);
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      JSON.stringify([
        [0, 0, 0],
        [255, 255, 255],
        [128, 64, 32],
      ]),
    );

    const loaded = loadBrief(briefPath, { projectRoot: root });
    expect(loaded.brief.name).toBe('iron-sword');
    expect(loaded.brief.type).toBe('weapon');
    expect(loaded.brief.generation.sheet.rows).toBe(4);
    expect(loaded.palette).toHaveLength(3);
    expect(loaded.palette[1]).toEqual([255, 255, 255]);
    expect(loaded.briefPath).toBe(path.resolve(briefPath));
  });

  it('throws a structured error when the brief fails Zod validation', () => {
    const briefPath = path.join(root, 'briefs', 'bad.yaml');
    writeFileSync(briefPath, 'type: weapon\nname: BAD_NAME\n');
    expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(
      /failed minimal validation|failed validation/,
    );
  });

  it('rejects whitespace-only description at the minimal layer', () => {
    const briefPath = path.join(root, 'briefs', 'blank.yaml');
    writeFileSync(briefPath, 'type: weapon\nname: blank\ndescription: "   "\n');
    expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(
      /failed minimal validation|failed validation/,
    );
  });

  it('throws when the referenced palette JSON does not exist', () => {
    const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
    writeFileSync(briefPath, SAMPLE_BRIEF_YAML);
    expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(
      /Palette 'kenney-roguelike' not found/,
    );
  });

  it('throws on malformed palette content', () => {
    const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
    writeFileSync(briefPath, SAMPLE_BRIEF_YAML);
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      JSON.stringify([[300, 0, 0]]),
    );
    expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(/entry 0/);
  });

  it('lets callers inject a palette loader to avoid disk I/O', () => {
    const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
    writeFileSync(briefPath, SAMPLE_BRIEF_YAML);
    const loaded = loadBrief(briefPath, {
      projectRoot: root,
      loadPalette: (id) => {
        expect(id).toBe('kenney-roguelike');
        return [
          [1, 2, 3],
          [4, 5, 6],
        ];
      },
    });
    expect(loaded.palette).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('merges a minimal brief on top of per-type defaults from disk', () => {
    // Brief only supplies type/name/description. Everything else must come
    // from data/sprite-types/<type>.json.
    const briefPath = path.join(root, 'briefs', 'skull-mace.yaml');
    writeFileSync(
      briefPath,
      [
        'type: weapon',
        'name: skull-mace',
        'description: |',
        '  A skull on a stick, vertical, bone-white head, dark wrapped haft.',
      ].join('\n'),
    );
    mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
    writeFileSync(
      path.join(root, 'data', 'sprite-types', 'weapon.json'),
      JSON.stringify({
        size: { width: 16, height: 16 },
        palette: { id: 'test-palette' },
        anchor: { x: 8, y: 14 },
        references: [{ path: 'public/assets/ref-a.png' }, { path: 'public/assets/ref-b.png' }],
        sensors: { weapon: { orientation: 'vertical' } },
      }),
    );

    const loaded = loadBrief(briefPath, {
      projectRoot: root,
      loadPalette: () => [
        [0, 0, 0],
        [255, 255, 255],
      ],
    });
    expect(loaded.brief.name).toBe('skull-mace');
    expect(loaded.brief.size).toEqual({ width: 16, height: 16 });
    expect(loaded.brief.anchor).toEqual({ x: 8, y: 14 });
    expect(loaded.brief.references).toHaveLength(2);
    // description -> prompt
    expect(loaded.brief.prompt).toContain('skull on a stick');
    expect(loaded.brief.sensors.weapon?.orientation).toBe('vertical');
    // 4x4 sheet is the schema default; defaults file omits generation, so
    // the Zod default fills in.
    expect(loaded.brief.generation.sheet.rows).toBe(4);
    expect(loaded.brief.generation.sheet.cols).toBe(4);
  });

  it('lets a minimal brief override a per-type default', () => {
    // Iron-sword wants diagonal orientation even though the type default is
    // vertical.
    const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
    writeFileSync(
      briefPath,
      [
        'type: weapon',
        'name: iron-sword',
        'description: An iron sword in side profile, blade up-right.',
        'sensors:',
        '  weapon:',
        '    orientation: diagonal',
      ].join('\n'),
    );
    const loaded = loadBrief(briefPath, {
      projectRoot: root,
      loadPalette: () => [
        [0, 0, 0],
        [255, 255, 255],
      ],
      loadTypeDefaults: () => ({
        size: { width: 16, height: 16 },
        palette: { id: 'test-palette' },
        anchor: { x: 8, y: 14 },
        references: [{ path: 'public/assets/ref-a.png' }, { path: 'public/assets/ref-b.png' }],
        sensors: { weapon: { orientation: 'vertical' } },
      }),
    });
    expect(loaded.brief.sensors.weapon?.orientation).toBe('diagonal');
  });

  it('treats a minimal-brief references array as a full replacement, not a concat', () => {
    const briefPath = path.join(root, 'briefs', 'r.yaml');
    writeFileSync(
      briefPath,
      [
        'type: weapon',
        'name: replacing',
        'description: A brief that wants only one specific reference set.',
        'references:',
        '  - { path: public/assets/only-one.png }',
        '  - { path: public/assets/only-two.png }',
      ].join('\n'),
    );
    const loaded = loadBrief(briefPath, {
      projectRoot: root,
      loadPalette: () => [
        [0, 0, 0],
        [255, 255, 255],
      ],
      loadTypeDefaults: () => ({
        size: { width: 16, height: 16 },
        palette: { id: 'test-palette' },
        anchor: { x: 8, y: 14 },
        references: [
          { path: 'public/assets/default-a.png' },
          { path: 'public/assets/default-b.png' },
          { path: 'public/assets/default-c.png' },
        ],
      }),
    });
    expect(loaded.brief.references.map((r) => r.path)).toEqual([
      'public/assets/only-one.png',
      'public/assets/only-two.png',
    ]);
  });

  it('still accepts a fully-specified brief with no type defaults file', () => {
    // Backward compat: a brief that supplies every field works even when
    // data/sprite-types/<type>.json is absent.
    const briefPath = path.join(root, 'briefs', 'full.yaml');
    writeFileSync(briefPath, SAMPLE_BRIEF_YAML);
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      JSON.stringify([
        [0, 0, 0],
        [255, 255, 255],
      ]),
    );
    const loaded = loadBrief(briefPath, { projectRoot: root });
    expect(loaded.brief.name).toBe('iron-sword');
  });
});
