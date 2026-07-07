import { describe, expect, it } from 'vitest';
import {
  buildFloorArtPlanReport,
  parseApprovedSprites,
  parseCommittedBriefKeys,
  parseDraftBriefKeys,
  parseFloorArtPlans,
} from '../../src/devtools/art-plan-model.js';

describe('devtools art-plan model', () => {
  it('parses valid floor art plans and ignores invalid ones', () => {
    const plans = parseFloorArtPlans({
      a: [
        'id: rat-floor',
        'title: Rat floor',
        'summary: Rat plan',
        'assets:',
        '  - id: rat-bruiser',
        '    type: enemy',
        '    label: Rat Bruiser',
        '    brief: Rat bruiser brief',
      ].join('\n'),
      b: ['id: broken', 'title: Broken', 'assets: []'].join('\n'),
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe('rat-floor');
  });

  it('builds report statuses from brief/approval/integration axes', () => {
    const plan = parseFloorArtPlans({
      p: [
        'id: rat-floor',
        'title: Rat floor',
        'assets:',
        '  - id: rat-bruiser',
        '    type: enemy',
        '    label: Rat Bruiser',
        '    brief: Rat bruiser brief',
        '    placeholderInUse: true',
        '    integration:',
        '      kind: sprite-registry',
        '      id: enemy.rat-bruiser',
        '  - id: rat-mage',
        '    type: enemy',
        '    label: Rat Mage',
        '    brief: Rat mage brief',
        '    placeholderInUse: true',
      ].join('\n'),
    })[0]!;

    const report = buildFloorArtPlanReport(plan, {
      briefKeys: new Set(['enemy::rat-mage']),
      draftBriefKeys: new Set(),
      approvedSprites: new Map([
        [
          'rat-bruiser',
          {
            briefId: 'rat-bruiser',
            assetPath: 'generated/rat-bruiser.png',
            sourceRun: 'runs/rat-bruiser/run-1',
            variantIndex: 0,
            exists: true,
          },
        ],
      ]),
      spriteRegistryIds: new Set(['enemy.rat-bruiser']),
      itemCatalogIds: new Set(),
    });

    const byId = new Map(report.assets.map((asset) => [asset.id, asset]));
    expect(byId.get('rat-bruiser')?.status).toBe('ready');
    expect(byId.get('rat-bruiser')?.sourceRun).toBe('runs/rat-bruiser/run-1');
    expect(byId.get('rat-bruiser')?.variantIndex).toBe(0);
    expect(byId.get('rat-mage')?.status).toBe('brief-ready-placeholder');
    expect(report.unresolvedPlaceholders).toBe(1);
  });

  it('reports draft-ready-placeholder when only a draft brief exists', () => {
    const plan = parseFloorArtPlans({
      p: [
        'id: rat-floor',
        'title: Rat floor',
        'assets:',
        '  - id: rat-flash',
        '    type: vfx',
        '    label: Rat Flash',
        '    brief: Quick burst',
        '    placeholderInUse: true',
      ].join('\n'),
    })[0]!;

    const report = buildFloorArtPlanReport(plan, {
      briefKeys: new Set(),
      draftBriefKeys: new Set(['vfx::rat-flash']),
      approvedSprites: new Map(),
      spriteRegistryIds: new Set(),
      itemCatalogIds: new Set(),
    });

    expect(report.assets[0]?.status).toBe('draft-ready-placeholder');
  });

  it('parses brief keys and approved sprites', () => {
    const briefKeys = parseCommittedBriefKeys({
      '../briefs/enemies/rat-bruiser.yaml': 'type: enemy\nname: rat-bruiser\ndescription: foo',
      '../briefs/floors/rat-plan.art.yaml': 'id: rat-floor\ntitle: Rat\nassets: []',
    });
    expect(briefKeys.has('enemy::rat-bruiser')).toBe(true);
    expect(briefKeys.size).toBe(1);

    const draftKeys = parseDraftBriefKeys({
      '../briefs/draft/enemies/rat-bruiser.yaml':
        'type: enemy\nname: rat-bruiser\ndescription: foo',
      '../briefs/enemies/rat-king.yaml': 'type: enemy\nname: rat-king\ndescription: foo',
    });
    expect(draftKeys.has('enemy::rat-bruiser')).toBe(true);
    expect(draftKeys.size).toBe(1);

    const approved = parseApprovedSprites(
      {
        version: 1,
        entries: {
          'rat-bruiser': {
            briefId: 'rat-bruiser',
            assetPath: 'generated/rat-bruiser.png',
            sourceRun: 'runs/rat-bruiser/run-1',
            variantIndex: 0,
          },
        },
      },
      { existingAssets: new Set(['generated/rat-bruiser.png']) },
    );
    expect(approved.get('rat-bruiser')?.exists).toBe(true);
  });

  it('ignores placeholder manifest entries when parsing approved sprites', () => {
    const approved = parseApprovedSprites(
      {
        version: 1,
        entries: {
          'rat-placeholder': {
            briefId: 'rat-placeholder',
            assetPath: 'generated/rat-placeholder.png',
            sourceRun: 'placeholder',
            variantIndex: 0,
          },
          'rat-real': {
            briefId: 'rat-real',
            assetPath: 'generated/rat-real.png',
            sourceRun: 'runs/rat-real/run-1',
            variantIndex: 1,
          },
        },
      },
      { existingAssets: new Set(['generated/rat-real.png']) },
    );

    expect(approved.has('rat-placeholder')).toBe(false);
    expect(approved.get('rat-real')?.exists).toBe(true);
  });
});
