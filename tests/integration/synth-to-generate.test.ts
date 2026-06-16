/**
 * Integration test: synthesise a brief, then run it through the full
 * `generateOne` pipeline.
 *
 * The provider for synthesis returns a single fixed weapon candidate
 * (no real network); the synthesiser writes the YAML; `loadBrief`
 * reads it back; `generateOne` then runs the slicer/postprocess/sensor
 * chain with the mocked image provider used elsewhere in the
 * integration suite.
 *
 * This proves the synthesiser's output is a real, end-to-end-usable
 * brief — not just a YAML that happens to parse.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateOne } from '../../scripts/sprites/generate-one.js';
import { loadBrief } from '../../scripts/sprites/load-brief.js';
import { synthesizeBrief } from '../../scripts/sprites/synthesize-brief.js';
import type { GenerateSheetRequest, ImageProvider } from '../../scripts/sprites/provider/types.js';
import type {
  EvaluateRequest,
  EvaluateResponse,
  VisionProvider,
} from '../../scripts/sprites/provider/vision-types.js';
import type {
  SynthProvider,
  SynthesizeBriefRequest,
  SynthesizeBriefResponse,
} from '../../scripts/sprites/provider/synth-types.js';
import { buildGoodSwordFixture } from '../fixtures/sprites/builders.js';

const STYLE_GUIDE = [
  '# Style guide',
  '',
  '> --- STYLE PREAMBLE (do not deviate) ---',
  '>',
  '> Rule 1: no text.',
  '>',
  '> --- END STYLE PREAMBLE ---',
].join('\n');

function tileVariantsIntoSheet(variants: Buffer[], rows: number, cols: number): Buffer {
  const cellSize = 1024;
  const sheet = new PNG({ width: cols * cellSize, height: rows * cellSize });
  for (let i = 0; i < variants.length; i++) {
    const cell = PNG.sync.read(variants[i]!);
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (let y = 0; y < cellSize; y++) {
      const srcStart = y * cellSize * 4;
      const dstStart = ((r * cellSize + y) * sheet.width + c * cellSize) * 4;
      cell.data.copy(sheet.data, dstStart, srcStart, srcStart + cellSize * 4);
    }
  }
  return PNG.sync.write(sheet);
}

function makeImageProvider(sheet: Buffer): ImageProvider {
  return {
    async generateSheet(_req: GenerateSheetRequest): Promise<Buffer> {
      return sheet;
    },
  };
}

function makeVisionProvider(): VisionProvider {
  return {
    modelDeployment: 'mock-vision-deployment',
    async evaluate(_req: EvaluateRequest): Promise<EvaluateResponse> {
      return {
        json: {
          style_match: { score: 5, rationale: 'mocked for integration coverage' },
          brief_match: { score: 5, rationale: 'mocked for integration coverage' },
          readability: { score: 5, rationale: 'mocked for integration coverage' },
        },
        modelDeployment: 'mock-vision-deployment',
        usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580 },
      };
    },
  };
}

function makeSynthProvider(): SynthProvider {
  return {
    providerLabel: 'azure-openai:gpt-4o-test',
    async synthesizeBrief(_req: SynthesizeBriefRequest): Promise<SynthesizeBriefResponse> {
      return {
        inferredType: 'weapon',
        typeConfidence: 0.97,
        candidates: [
          {
            description:
              'A long curved scythe blade pointing up-left, narrow wooden snath running diagonal, ' +
              'with iron rivets at the join and a darkened steel edge.',
            references: [
              { id: 'roguelike-rpg-pack', note: 'silhouette anchor for slender weapons' },
              { id: 'tiny-battle', note: 'secondary palette for steel/wood mix' },
            ],
            embellishmentSeeds: [
              'shorter wider blade',
              'wrapped leather grip',
              'segmented snath',
              'brass ferrule at grip end',
            ],
            rationale: 'Curved blade silhouette versus the straight-blade alternatives.',
          },
        ],
      };
    },
  };
}

describe('sprites:synth → loadBrief → generateOne (integration)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-synth-integration-'));
    mkdirSync(path.join(root, 'data', 'palettes'), { recursive: true });
    mkdirSync(path.join(root, 'data', 'sprite-types'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'agent-os'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'draft', 'weapons'), { recursive: true });
    mkdirSync(path.join(root, 'public', 'assets', 'kenney', 'roguelike-rpg-pack'), {
      recursive: true,
    });
    mkdirSync(path.join(root, 'public', 'assets', 'kenney', 'tiny-battle'), {
      recursive: true,
    });

    // Style guide + palette + weapon defaults so loadBrief succeeds against
    // the synthesised YAML.
    writeFileSync(path.join(root, 'docs', 'agent-os', 'sprite-style.md'), STYLE_GUIDE);
    writeFileSync(
      path.join(root, 'data', 'palettes', 'kenney-roguelike.json'),
      JSON.stringify([
        [0, 0, 0],
        [160, 192, 192],
        [192, 192, 200],
        [255, 255, 255],
      ]),
    );
    // Real per-type defaults — we use the same content as the repo's
    // weapon defaults so the integration is meaningful.
    cpSync(
      path.join(process.cwd(), 'data', 'sprite-types', 'weapon.json'),
      path.join(root, 'data', 'sprite-types', 'weapon.json'),
    );

    // Stub reference PNGs so the catalog's fileExists guard passes and
    // generate-one can read the reference bytes.
    const fakePng = buildGoodSwordFixture();
    writeFileSync(
      path.join(root, 'public', 'assets', 'kenney', 'roguelike-rpg-pack', 'spritesheet.png'),
      fakePng,
    );
    writeFileSync(
      path.join(root, 'public', 'assets', 'kenney', 'tiny-battle', 'spritesheet.png'),
      fakePng,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('synthesises a weapon brief and runs it end-to-end through generateOne', async () => {
    // 1. Synthesise into generated/brief-candidates/scythe/.
    const synth = await synthesizeBrief({
      name: 'scythe',
      type: 'weapon',
      candidates: 1,
      provider: makeSynthProvider(),
      repoRoot: root,
      env: {},
    });
    expect(synth.written).toHaveLength(1);
    const candidate = synth.written[0]!;
    expect(existsSync(candidate.yamlPath)).toBe(true);
    expect(existsSync(synth.sidecarPath)).toBe(true);

    // 2. Promote into briefs/draft/weapons/scythe.yaml. This is the
    //    step a human would do by hand.
    const draftPath = path.join(root, 'briefs', 'draft', 'weapons', 'scythe.yaml');
    cpSync(candidate.yamlPath, draftPath);

    // 3. Load + validate.
    const loaded = loadBrief(draftPath, { projectRoot: root });
    expect(loaded.brief.type).toBe('weapon');
    expect(loaded.brief.name).toBe('scythe-v1');
    expect(loaded.brief.prompt).toContain('scythe blade');
    // References from the synth's allow-list pick survived the merge.
    expect(loaded.brief.references.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        'public/assets/kenney/roguelike-rpg-pack/spritesheet.png',
        'public/assets/kenney/tiny-battle/spritesheet.png',
      ]),
    );

    // 4. Run the generate-one pipeline with a mock image provider. A
    //    4x4 sheet of `buildGoodSwordFixture` variants is enough to
    //    prove the synth → run path works end-to-end; we don't require
    //    sensor pass since the fixture is diagonal and the synthesised
    //    brief inherits the vertical orientation default. The
    //    integration we're validating is "synth output is usable", not
    //    "scythe sprite passes weapon sensors".
    const sheet = tileVariantsIntoSheet(
      Array.from({ length: 16 }, () => buildGoodSwordFixture()),
      4,
      4,
    );
    const result = await generateOne({
      briefPath: draftPath,
      preloaded: loaded,
      provider: makeImageProvider(sheet),
      visionProvider: makeVisionProvider(),
      repoRoot: root,
      outputRoot: path.join(root, 'generated'),
      now: () => new Date('2026-06-05T12:00:00.000Z'),
    });
    // Pipeline completed and wrote artifacts.
    expect(result.summary.candidates.length).toBe(16);
    expect(existsSync(result.summaryPath)).toBe(true);
    for (const c of result.summary.candidates) {
      expect(existsSync(c.rawPath)).toBe(true);
      expect(existsSync(c.scorecardPath)).toBe(true);
    }
  }, 240_000);
});
