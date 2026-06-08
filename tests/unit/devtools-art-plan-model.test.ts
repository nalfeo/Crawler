import { describe, expect, it } from 'vitest';
import {
  buildFloorArtPlanReport,
  parseApprovedSprites,
  parseCommittedBriefKeys,
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
      approvedSprites: new Map([
        ['rat-bruiser', { briefId: 'rat-bruiser', assetPath: 'generated/rat-bruiser.png', exists: true }],
      ]),
      spriteRegistryIds: new Set(['enemy.rat-bruiser']),
      itemCatalogIds: new Set(),
    });

    const byId = new Map(report.assets.map((asset) => [asset.id, asset]));
    expect(byId.get('rat-bruiser')?.status).toBe('ready');
    expect(byId.get('rat-mage')?.status).toBe('brief-ready-placeholder');
    expect(report.unresolvedPlaceholders).toBe(1);
  });

  it('parses brief keys and approved sprites', () => {
    const briefKeys = parseCommittedBriefKeys({
      '../briefs/enemies/rat-bruiser.yaml': 'type: enemy\nname: rat-bruiser\ndescription: foo',
      '../briefs/floors/rat-plan.art.yaml': 'id: rat-floor\ntitle: Rat\nassets: []',
    });
    expect(briefKeys.has('enemy::rat-bruiser')).toBe(true);
    expect(briefKeys.size).toBe(1);

    const approved = parseApprovedSprites(
      {
        version: 1,
        entries: {
          'rat-bruiser': {
            briefId: 'rat-bruiser',
            assetPath: 'generated/rat-bruiser.png',
          },
        },
      },
      { existingAssets: new Set(['generated/rat-bruiser.png']) },
    );
    expect(approved.get('rat-bruiser')?.exists).toBe(true);
  });
});
