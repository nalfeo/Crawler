/**
 * Tests for the YAML brief loader. The loader is one of the rare modules that
 * actually touches the disk, so the test writes small fixtures to a temp dir
 * to exercise palette resolution end-to-end without a fake-fs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadBrief,
  loadBriefFromYaml,
  mergeMinimalIntoDefaults,
  validateBriefYaml,
} from '../../../scripts/sprites/load-brief.js';

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

  describe('sprite-type sensor defaults (PR #44)', () => {
    function setupBriefAndPalette(): string {
      const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
      writeFileSync(briefPath, SAMPLE_BRIEF_YAML);
      writeFileSync(
        path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
        JSON.stringify([
          [0, 0, 0],
          [255, 255, 255],
        ]),
      );
      return briefPath;
    }

    it('merges sensors.anchor defaults from data/sprite-types/<type>.json when present', () => {
      const briefPath = setupBriefAndPalette();
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      writeFileSync(
        path.join(root, 'data', 'sprite-types', 'weapon.json'),
        JSON.stringify({
          sensors: { anchor: { derive: true, bandRows: 4, centerToleranceX: 3 } },
        }),
      );

      const { brief } = loadBrief(briefPath, { projectRoot: root });
      expect(brief.sensors.anchor).toEqual({
        derive: true,
        mode: 'static',
        bandRows: 4,
        centerToleranceX: 3,
      });
    });

    it('lets the brief override individual sensor sub-keys without restating the rest', () => {
      const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
      writeFileSync(
        briefPath,
        `${SAMPLE_BRIEF_YAML}\nsensors:\n  anchor: { centerToleranceX: 8 }\n`,
      );
      writeFileSync(
        path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
        JSON.stringify([
          [0, 0, 0],
          [255, 255, 255],
        ]),
      );
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      writeFileSync(
        path.join(root, 'data', 'sprite-types', 'weapon.json'),
        JSON.stringify({
          sensors: { anchor: { derive: true, bandRows: 4, centerToleranceX: 3 } },
        }),
      );

      const { brief } = loadBrief(briefPath, { projectRoot: root });
      // Brief overrides only centerToleranceX; derive + bandRows come from defaults.
      expect(brief.sensors.anchor).toEqual({
        derive: true,
        mode: 'static',
        bandRows: 4,
        centerToleranceX: 8,
      });
    });

    it('leaves the brief untouched when no defaults file exists', () => {
      const briefPath = setupBriefAndPalette();
      const { brief } = loadBrief(briefPath, { projectRoot: root });
      expect(brief.sensors.anchor).toBeUndefined();
    });

    it('lets tests inject sprite-type defaults via the loadTypeDefaults hook', () => {
      const briefPath = setupBriefAndPalette();
      const { brief } = loadBrief(briefPath, {
        projectRoot: root,
        loadTypeDefaults: (type) => {
          expect(type).toBe('weapon');
          return { sensors: { anchor: { derive: true } } } as never;
        },
      });
      expect(brief.sensors.anchor?.derive).toBe(true);
    });

    it('throws a useful error when the defaults JSON is malformed', () => {
      const briefPath = setupBriefAndPalette();
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      writeFileSync(path.join(root, 'data', 'sprite-types', 'weapon.json'), '{ not valid json');
      expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(/parsing sprite-type/);
    });

    it('does not mask a malformed brief sensors block by replacing it with defaults', () => {
      // If the brief author wrote `sensors: null` or `sensors: "oops"`, we
      // must NOT quietly replace it with sprite-type defaults — that would
      // hide their error. Leave it untouched so Zod reports the real issue.
      const briefPath = path.join(root, 'briefs', 'iron-sword.yaml');
      writeFileSync(briefPath, `${SAMPLE_BRIEF_YAML}\nsensors: "oops"\n`);
      writeFileSync(
        path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
        JSON.stringify([
          [0, 0, 0],
          [255, 255, 255],
        ]),
      );
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      writeFileSync(
        path.join(root, 'data', 'sprite-types', 'weapon.json'),
        JSON.stringify({
          sensors: { anchor: { derive: true, bandRows: 4, centerToleranceX: 3 } },
        }),
      );

      // The brief must fail Zod (because sensors is a string, not an object),
      // not silently succeed by inheriting the sprite-type defaults.
      expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(/sensors/);
    });
  });
});

describe('mergeMinimalIntoDefaults — size variants', () => {
  type Dim = { width: number; height: number };
  type Anchor = { x: number; y: number };
  const nativeCanvasOf = (v: unknown): number =>
    (v as { sheet: { nativeCanvas: number } }).sheet.nativeCanvas;
  const sheetOf = (v: unknown): { rows: number; cols: number; nativeCanvas: number } =>
    (v as { sheet: { rows: number; cols: number; nativeCanvas: number } }).sheet;

  function enemyDefaults(): Record<string, unknown> {
    return {
      type: 'enemy',
      size: { width: 64, height: 64 },
      palette: { id: 'kenney-roguelike' },
      anchor: { x: 32, y: 32 },
      tags: ['enemy'],
      generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
    };
  }

  it('leaves the per-type defaults untouched for the default variant', () => {
    const merged = mergeMinimalIntoDefaults(
      { name: 'slime', description: 'a green slime', sizeVariant: 'default' },
      enemyDefaults() as never,
    );
    expect(merged.size).toEqual({ width: 64, height: 64 });
    expect(merged.anchor).toEqual({ x: 32, y: 32 });
    expect(nativeCanvasOf(merged.generation)).toBe(1024);
    expect(merged.sizeVariant).toBeUndefined();
  });

  it('scales width and reshapes the grid for wide', () => {
    const merged = mergeMinimalIntoDefaults(
      { name: 'slime', description: 'a wide slime', sizeVariant: 'wide' },
      enemyDefaults() as never,
    );
    expect(merged.size).toEqual({ width: 128, height: 64 });
    expect(merged.anchor).toEqual({ x: 64, y: 32 });
    expect(sheetOf(merged.generation)).toMatchObject({ rows: 4, cols: 2, nativeCanvas: 1024 });
  });

  it('scales height and reshapes the grid for tall', () => {
    const merged = mergeMinimalIntoDefaults(
      { name: 'slime', description: 'a tall slime', sizeVariant: 'tall' },
      enemyDefaults() as never,
    );
    expect(merged.size).toEqual({ width: 64, height: 128 });
    expect(merged.anchor).toEqual({ x: 32, y: 64 });
    expect(sheetOf(merged.generation)).toMatchObject({ rows: 2, cols: 4, nativeCanvas: 1024 });
  });

  it('scales both axes and reshapes the grid for large', () => {
    const merged = mergeMinimalIntoDefaults(
      { name: 'slime', description: 'a large slime', sizeVariant: 'large' },
      enemyDefaults() as never,
    );
    expect(merged.size).toEqual({ width: 128, height: 128 });
    expect(merged.anchor).toEqual({ x: 64, y: 64 });
    expect(sheetOf(merged.generation)).toMatchObject({ rows: 2, cols: 2, nativeCanvas: 1024 });
  });

  it('lets an explicit author size/anchor win over the variant scaling', () => {
    const merged = mergeMinimalIntoDefaults(
      {
        name: 'slime',
        description: 'a pinned slime',
        sizeVariant: 'large',
        size: { width: 100, height: 40 },
        anchor: { x: 10, y: 20 },
      },
      enemyDefaults() as never,
    );
    // Author wins on size/anchor; the inherited grid still reshapes (large → 2×2)
    // and nativeCanvas (never inflated) stays at the base 1024.
    expect(merged.size).toEqual({ width: 100, height: 40 });
    expect(merged.anchor).toEqual({ x: 10, y: 20 });
    expect(sheetOf(merged.generation)).toMatchObject({ rows: 2, cols: 2, nativeCanvas: 1024 });
  });

  it('keeps the anchor strictly inside the scaled size', () => {
    const characterDefaults = {
      type: 'character',
      size: { width: 64, height: 64 },
      palette: { id: 'kenney-roguelike' },
      anchor: { x: 32, y: 63 },
      generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
    };
    const merged = mergeMinimalIntoDefaults(
      { name: 'hero', description: 'a tall hero', sizeVariant: 'tall' },
      characterDefaults as never,
    );
    expect((merged.anchor as Anchor).y).toBeLessThan((merged.size as Dim).height);
    expect(merged.anchor).toEqual({ x: 32, y: 126 });
    expect(merged.size).toEqual({ width: 64, height: 128 });
  });

  it('strips sizeVariant so the strict schema never sees it', () => {
    const merged = mergeMinimalIntoDefaults(
      { name: 'slime', description: 'a slime', sizeVariant: 'wide' },
      enemyDefaults() as never,
    );
    expect('sizeVariant' in merged).toBe(false);
  });

  it('no-ops scaling when the type has no defaults file (null defaults)', () => {
    const merged = mergeMinimalIntoDefaults(
      {
        name: 'x',
        description: 'no defaults',
        sizeVariant: 'wide',
        size: { width: 10, height: 10 },
      },
      null,
    );
    expect(merged.size).toEqual({ width: 10, height: 10 });
    expect('sizeVariant' in merged).toBe(false);
  });

  it('throws a clear error for an unknown variant', () => {
    expect(() =>
      mergeMinimalIntoDefaults(
        { name: 'x', description: 'bad', sizeVariant: 'huge' },
        enemyDefaults() as never,
      ),
    ).toThrow(/Invalid sizeVariant/);
  });
});

describe('loadBriefFromYaml', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-loadbriefyaml-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses a valid YAML string and returns a Brief without touching the disk', () => {
    const brief = loadBriefFromYaml(SAMPLE_BRIEF_YAML, {
      projectRoot: root,
      loadPalette: () => [
        [0, 0, 0],
        [255, 255, 255],
      ],
    });
    expect(brief.name).toBe('iron-sword');
    expect(brief.type).toBe('weapon');
    expect(brief.generation.sheet.rows).toBe(4);
  });

  it('merges type-defaults via loadTypeDefaults when provided', () => {
    const minimalYaml = [
      'type: weapon',
      'name: dagger',
      'description: A short stabbing dagger.',
    ].join('\n');
    const brief = loadBriefFromYaml(minimalYaml, {
      projectRoot: root,
      loadPalette: () => [
        [0, 0, 0],
        [255, 255, 255],
      ],
      loadTypeDefaults: () => ({
        size: { width: 8, height: 16 },
        palette: { id: 'test-palette' },
        anchor: { x: 4, y: 14 },
        references: [{ path: 'public/assets/ref.png' }],
      }),
    });
    expect(brief.size).toEqual({ width: 8, height: 16 });
    expect(brief.anchor).toEqual({ x: 4, y: 14 });
  });

  it('throws a structured error when minimal validation fails (missing name)', () => {
    expect(() =>
      loadBriefFromYaml('type: weapon\ndescription: "some desc"', { projectRoot: root }),
    ).toThrow(/failed minimal validation/);
  });

  it('throws when the merged brief fails strict schema validation', () => {
    // All required fields present but anchor.x is a string — strict schema rejects it.
    const badYaml = [
      'type: weapon',
      'name: bad-brief',
      'description: "A bad brief."',
      'size: { width: 16, height: 16 }',
      'palette: { id: "test-palette" }',
      'anchor: { x: "not-a-number", y: 8 }',
    ].join('\n');
    expect(() =>
      loadBriefFromYaml(badYaml, {
        projectRoot: root,
        loadPalette: () => [[0, 0, 0]],
      }),
    ).toThrow(/failed validation/);
  });

  it('defaults character/enemy/prop/equipment briefs to 256x256 from type defaults', () => {
    const typeCases = ['character', 'enemy', 'prop', 'equipment'] as const;
    for (const type of typeCases) {
      const brief = loadBriefFromYaml(
        [`type: ${type}`, `name: ${type}-default-size`, 'description: "default size check"'].join(
          '\n',
        ),
        {
          projectRoot: process.cwd(),
          loadPalette: () => [
            [0, 0, 0],
            [255, 255, 255],
          ],
        },
      );
      expect(brief.size).toEqual({ width: 256, height: 256 });
    }
  });

  it('keeps explicit per-brief size overrides for enemy defaults', () => {
    const brief = loadBriefFromYaml(
      [
        'type: enemy',
        'name: enemy-size-override',
        'description: "override size check"',
        'size: { width: 96, height: 80 }',
        'anchor: { x: 48, y: 79 }',
      ].join('\n'),
      {
        projectRoot: process.cwd(),
        loadPalette: () => [
          [0, 0, 0],
          [255, 255, 255],
        ],
      },
    );
    expect(brief.size).toEqual({ width: 96, height: 80 });
    expect(brief.anchor).toEqual({ x: 48, y: 79 });
  });
});

describe('validateBriefYaml', () => {
  const palette = (): [number, number, number][] => [
    [0, 0, 0],
    [255, 255, 255],
  ];

  it('accepts a valid brief and returns the parsed brief plus resolved palette', () => {
    const loaded = validateBriefYaml(SAMPLE_BRIEF_YAML, { loadPalette: palette });

    expect(loaded.brief.name).toBe('iron-sword');
    expect(loaded.brief.type).toBe('weapon');
    expect(loaded.palette).toEqual(palette());
    expect(loaded.briefPath).toBe('<in-memory>');
  });

  it('throws on a schema violation without touching the disk', () => {
    expect(() =>
      validateBriefYaml('type: weapon\nname: BAD_NAME\n', { loadPalette: palette }),
    ).toThrow(/failed minimal validation|failed validation/);
  });

  it('throws when the palette id cannot be resolved', () => {
    expect(() =>
      validateBriefYaml(SAMPLE_BRIEF_YAML, {
        loadPalette: (id) => {
          throw new Error(`Palette '${id}' not found`);
        },
      }),
    ).toThrow(/Palette 'kenney-roguelike' not found/);
  });
});
