import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assetPlanSchema,
  buildAssetPlanReport,
  collectCommittedBriefs,
  collectDraftBriefs,
  loadApprovedSprites,
  type AssetPlan,
} from '../../../scripts/sprites/asset-plan.js';

describe('asset-plan report', () => {
  it('derives statuses from brief, approval, integration, and placeholder axes', () => {
    const plan = assetPlanSchema.parse({
      id: 'rat-floor',
      title: 'Rat Floor',
      summary: 'status test',
      assets: [
        {
          id: 'rat-bruiser',
          type: 'enemy',
          label: 'Rat Bruiser',
          brief: 'A bruiser rat enemy',
          placeholderInUse: true,
          integration: { kind: 'sprite-registry', id: 'enemy.rat-bruiser' },
        },
        {
          id: 'rat-mage',
          type: 'enemy',
          label: 'Rat Mage',
          brief: 'A mage rat enemy',
          placeholderInUse: true,
          integration: { kind: 'sprite-registry', id: 'enemy.rat-mage' },
        },
        {
          id: 'rat-king',
          type: 'enemy',
          label: 'Rat King',
          brief: 'A boss rat enemy',
          placeholderInUse: true,
        },
        {
          id: 'rat-trash',
          type: 'enemy',
          label: 'Rat Trash',
          brief: 'A tiny rat',
          placeholderInUse: false,
        },
      ],
    }) as AssetPlan;

    const report = buildAssetPlanReport(plan, {
      briefIndex: new Map([
        ['enemy::rat-bruiser', 'briefs/enemies/rat-bruiser.yaml'],
        ['enemy::rat-king', 'briefs/enemies/rat-king.yaml'],
        ['enemy::rat-trash', 'briefs/enemies/rat-trash.yaml'],
      ]),
      draftBriefIndex: new Map([['enemy::rat-mage', 'briefs/draft/enemies/rat-mage.yaml']]),
      approvedSprites: new Map([
        [
          'rat-bruiser',
          {
            briefId: 'rat-bruiser',
            manifest: {
              briefId: 'rat-bruiser',
              spriteName: 'rat-bruiser',
              assetPath: 'generated/rat-bruiser.png',
              approvedAt: '2026-06-08T00:00:00.000Z',
              sourceRun: 'generated/runs/rat-bruiser/run',
              variantIndex: 0,
              anchor: null,
              sensorScore: '7/7',
              judgeScore: '4',
            },
            assetExists: true,
          },
        ],
        [
          'rat-mage',
          {
            briefId: 'rat-mage',
            manifest: {
              briefId: 'rat-mage',
              spriteName: 'rat-mage',
              assetPath: 'generated/rat-mage.png',
              approvedAt: '2026-06-08T00:00:00.000Z',
              sourceRun: 'generated/runs/rat-mage/run',
              variantIndex: 0,
              anchor: null,
              sensorScore: '7/7',
              judgeScore: '4',
            },
            assetExists: false,
          },
        ],
      ]),
      spriteRegistryIds: new Set(['enemy.rat-bruiser']),
      itemCatalogIds: new Set(),
    });

    const byId = new Map(report.assets.map((asset) => [asset.id, asset]));
    expect(byId.get('rat-bruiser')?.status).toBe('ready');
    expect(byId.get('rat-bruiser')?.sourceRun).toBe('generated/runs/rat-bruiser/run');
    expect(byId.get('rat-bruiser')?.variantIndex).toBe(0);
    expect(byId.get('rat-mage')?.status).toBe('approved-missing-file');
    expect(byId.get('rat-king')?.status).toBe('brief-ready-placeholder');
    expect(byId.get('rat-trash')?.status).toBe('brief-ready');
    expect(report.unresolvedPlaceholders).toBe(2);
  });

  it('reports approved-but-not-integrated when art exists but runtime target is missing', () => {
    const plan = assetPlanSchema.parse({
      id: 'rat-floor',
      title: 'Rat Floor',
      assets: [
        {
          id: 'rat-man-mage',
          type: 'enemy',
          label: 'Rat Man Mage',
          brief: 'Rat mage brief',
          placeholderInUse: true,
          integration: { kind: 'sprite-registry', id: 'enemy.rat-man-mage' },
        },
      ],
    }) as AssetPlan;

    const report = buildAssetPlanReport(plan, {
      briefIndex: new Map(),
      draftBriefIndex: new Map(),
      approvedSprites: new Map([
        [
          'rat-man-mage',
          {
            briefId: 'rat-man-mage',
            manifest: {
              briefId: 'rat-man-mage',
              spriteName: 'rat-man-mage',
              assetPath: 'generated/rat-man-mage.png',
              approvedAt: '2026-06-08T00:00:00.000Z',
              sourceRun: 'generated/runs/rat-man-mage/run',
              variantIndex: 0,
              anchor: null,
              sensorScore: '7/7',
              judgeScore: '4',
            },
            assetExists: true,
          },
        ],
      ]),
      spriteRegistryIds: new Set(),
      itemCatalogIds: new Set(),
    });

    expect(report.assets[0]?.status).toBe('approved-not-integrated');
  });

  it('reports draft-ready statuses when only a draft brief exists', () => {
    const plan = assetPlanSchema.parse({
      id: 'rat-floor',
      title: 'Rat Floor',
      assets: [
        {
          id: 'rat-flash',
          type: 'vfx',
          label: 'Rat Flash',
          brief: 'A quick scamper burst',
          placeholderInUse: true,
        },
      ],
    }) as AssetPlan;

    const report = buildAssetPlanReport(plan, {
      briefIndex: new Map(),
      draftBriefIndex: new Map([['vfx::rat-flash', 'briefs/draft/vfx/rat-flash.yaml']]),
      approvedSprites: new Map(),
      spriteRegistryIds: new Set(),
      itemCatalogIds: new Set(),
    });

    expect(report.assets[0]?.status).toBe('draft-ready-placeholder');
  });
});

describe('asset-plan discovery', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'crawler-asset-plan-'));
    mkdirSync(path.join(root, 'briefs', 'weapons'), { recursive: true });
    mkdirSync(path.join(root, 'briefs', 'floors'), { recursive: true });
    mkdirSync(path.join(root, 'public', 'assets', 'generated'), { recursive: true });
  });

  it('collects only sprite briefs from briefs/ and ignores non-brief yaml files', () => {
    writeFileSync(
      path.join(root, 'briefs', 'weapons', 'iron-sword.yaml'),
      ['type: weapon', 'name: iron-sword', 'description: Iron sword brief'].join('\n'),
    );
    writeFileSync(
      path.join(root, 'briefs', 'floors', 'rat-themed-dungeon-floor.art.yaml'),
      ['id: rat-floor', 'title: Rat floor', 'assets: []'].join('\n'),
    );

    const index = collectCommittedBriefs(root);
    expect(index.has('weapon::iron-sword')).toBe(true);
    expect(index.size).toBe(1);
  });

  it('collects only draft briefs from briefs/draft/', () => {
    mkdirSync(path.join(root, 'briefs', 'draft', 'enemies'), { recursive: true });
    writeFileSync(
      path.join(root, 'briefs', 'draft', 'enemies', 'rat-bruiser.yaml'),
      ['type: enemy', 'name: rat-bruiser', 'description: Rat bruiser brief'].join('\n'),
    );
    writeFileSync(
      path.join(root, 'briefs', 'weapons', 'iron-sword.yaml'),
      ['type: weapon', 'name: iron-sword', 'description: Iron sword brief'].join('\n'),
    );

    const index = collectDraftBriefs(root);
    expect(index.has('enemy::rat-bruiser')).toBe(true);
    expect(index.size).toBe(1);
  });

  it('loads approved sprites and marks missing image files', () => {
    writeFileSync(
      path.join(root, 'public', 'assets', 'generated', 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          entries: {
            'iron-sword': {
              briefId: 'iron-sword',
              spriteName: 'iron-sword',
              assetPath: 'generated/iron-sword.png',
              approvedAt: '2026-06-08T00:00:00.000Z',
              sourceRun: 'generated/runs/iron-sword/run',
              variantIndex: 0,
              anchor: null,
              sensorScore: '7/7',
              judgeScore: '4',
            },
          },
        },
        null,
        2,
      ),
    );
    const approved = loadApprovedSprites(root);
    expect(approved.get('iron-sword')?.assetExists).toBe(false);

    writeFileSync(path.join(root, 'public', 'assets', 'generated', 'iron-sword.png'), 'png');
    const approvedAfterFile = loadApprovedSprites(root);
    expect(approvedAfterFile.get('iron-sword')?.assetExists).toBe(true);
  });

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
