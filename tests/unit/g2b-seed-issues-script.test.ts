import { describe, expect, it } from 'vitest';
import {
  FLOOR2_EQUIPMENT_ART_DEFINITIONS,
  FLOOR2_EQUIPMENT_PRODUCTION_WAVES,
} from '../../src/shared/data/floor2-equipment-art';
import {
  buildExpectedIssueSpecs,
  buildIssueBody,
  planExistingIssueSync,
  validateIssueSet,
} from '../../.github/scripts/g2b-seed-issues/run';

describe('g2b seed issue spec generation', () => {
  it('pins the expected 70 identities across 15 production waves', () => {
    const specs = buildExpectedIssueSpecs(FLOOR2_EQUIPMENT_ART_DEFINITIONS);
    expect(specs).toHaveLength(70);
    expect(FLOOR2_EQUIPMENT_PRODUCTION_WAVES).toHaveLength(15);
  });

  it('mirrors the existing issue body shape including blank floor and size fields', () => {
    const stoneMaul = FLOOR2_EQUIPMENT_ART_DEFINITIONS.find(
      (definition) => definition.stableId === 'weapon.stone-maul',
    );
    expect(stoneMaul).toBeDefined();
    expect(buildIssueBody(stoneMaul!)).toBe(
      [
        '### Name',
        'stone-maul',
        '',
        '### Brief',
        'Stone Maul Floor 2 equipment icon for stable runtime key equipment/weapon/stone-maul. Create one centered, silhouette-readable bludgeon weapon on a transparent background; preserve the runtime key exactly.',
        '',
        '### Type (optional)',
        'weapon',
        '',
        '### Floor (optional)',
        '',
        '_No response_',
        '',
        '### Size (optional)',
        '',
        '_No response_',
        '',
        '---',
        '**Floor 2 equipment manifest metadata** (generated from `FLOOR2_EQUIPMENT_ART_DEFINITIONS`, do not edit):',
        '- Stable ID: `weapon.stone-maul`',
        '- Runtime key: `equipment/weapon/stone-maul`',
        '- Production wave: `floor2-equipment-weapon-bludgeon`',
        '- Aggregate tracking issue: #1303',
      ].join('\n'),
    );
  });

  it('fails validation on duplicate titles or metadata mismatches', () => {
    const [first] = buildExpectedIssueSpecs(FLOOR2_EQUIPMENT_ART_DEFINITIONS);
    const duplicateIssues = [
      { number: 1, title: first!.title, body: first!.body, labels: [{ name: 'asset-request' }] },
      { number: 2, title: first!.title, body: first!.body, labels: [{ name: 'asset-request' }] },
    ];
    const duplicateValidation = validateIssueSet(duplicateIssues, [first!]);
    expect(duplicateValidation.problems).toContain(
      `Duplicate open issues for ${first!.title}: #1, #2`,
    );

    const mismatchValidation = validateIssueSet(
      [{ number: 3, title: first!.title, body: 'bad body', labels: [{ name: 'asset-request' }] }],
      [first!],
    );
    expect(mismatchValidation.problems).toContain(
      `Metadata/body mismatch for ${first!.title} (#3)`,
    );
  });

  it('plans to repair stale existing issues before final validation', () => {
    const [first] = buildExpectedIssueSpecs(FLOOR2_EQUIPMENT_ART_DEFINITIONS);
    const syncPlan = planExistingIssueSync(
      {
        number: 7,
        title: first!.title,
        body: 'old body',
        labels: [],
      },
      first!,
    );
    expect(syncPlan).toEqual({
      needsLabel: true,
      needsBodyUpdate: true,
    });
  });
});
