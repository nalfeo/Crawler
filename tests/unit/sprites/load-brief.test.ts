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
    expect(loaded.brief.generation.sheet.rows).toBe(3);
    expect(loaded.palette).toHaveLength(3);
    expect(loaded.palette[1]).toEqual([255, 255, 255]);
    expect(loaded.briefPath).toBe(path.resolve(briefPath));
  });

  it('throws a structured error when the brief fails Zod validation', () => {
    const briefPath = path.join(root, 'briefs', 'bad.yaml');
    writeFileSync(briefPath, 'type: weapon\nname: BAD_NAME\n');
    expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(/failed validation/);
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

  describe('sprite-type defaults', () => {
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
      expect(brief.sensors.anchor).toEqual({ derive: true, bandRows: 4, centerToleranceX: 3 });
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
      expect(brief.sensors.anchor).toEqual({ derive: true, bandRows: 4, centerToleranceX: 8 });
    });

    it('leaves the brief untouched when no defaults file exists', () => {
      const briefPath = setupBriefAndPalette();
      const { brief } = loadBrief(briefPath, { projectRoot: root });
      expect(brief.sensors.anchor).toBeUndefined();
    });

    it('lets tests inject sprite-type defaults via the loadSpriteTypeDefaults hook', () => {
      const briefPath = setupBriefAndPalette();
      const { brief } = loadBrief(briefPath, {
        projectRoot: root,
        loadSpriteTypeDefaults: (type) => {
          expect(type).toBe('weapon');
          return { sensors: { anchor: { derive: true } } };
        },
      });
      expect(brief.sensors.anchor?.derive).toBe(true);
    });

    it('throws a useful error when the defaults JSON is malformed', () => {
      const briefPath = setupBriefAndPalette();
      mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
      writeFileSync(path.join(root, 'data', 'sprite-types', 'weapon.json'), '{ not valid json');
      expect(() => loadBrief(briefPath, { projectRoot: root })).toThrow(/not valid JSON/);
    });
  });
});
