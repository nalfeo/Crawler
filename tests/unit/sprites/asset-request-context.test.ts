import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseAssetRequestIssueBody } from '../../../scripts/sprites/asset-request.js';
import {
  getAssetRequestContextCapabilities,
  resolveAssetRequestContext,
} from '../../../scripts/sprites/asset-request-context.js';
import { getFloorManifest } from '../../../src/shared/floor-registry.js';
import { getFloorEnemyPack } from '../../../src/shared/enemy-packs.js';

describe('asset request context capabilities', () => {
  it('derives floor, family, and role choices from registered game manifests and packs', () => {
    const capabilities = getAssetRequestContextCapabilities();
    expect(capabilities.map((capability) => capability.floorId)).toEqual([
      'floor1',
      'floor2',
      'floor3',
    ]);

    for (const capability of capabilities) {
      const manifest = getFloorManifest(capability.floorId);
      expect(manifest?.enemyPackId).toBe(capability.enemyPackId);
      const pack = getFloorEnemyPack(capability.enemyPackId);
      for (const family of capability.families) {
        expect(pack?.archetypes.some((archetype) => archetype.familyId === family.id)).toBe(true);
      }
    }
  });

  it('keeps GitHub floor-id choices synchronized with local game-derived capabilities', () => {
    const issueForm = readFileSync(
      resolve(process.cwd(), '.github/ISSUE_TEMPLATE/asset-request.yml'),
      'utf8',
    );
    const issueFloorIds = [...issueForm.matchAll(/^\s+- (floor\d+)\s*$/gm)].map(
      (match) => match[1],
    );
    const localFloorIds = getAssetRequestContextCapabilities().map(
      (capability) => capability.floorId,
    );

    expect(issueFloorIds).toEqual(localFloorIds);
  });

  it('parses every shared authoring capability and snapshots overrides without changing canonical data', () => {
    const body = [
      '### Name',
      'goblin-elite-scout',
      '',
      '### Brief',
      'A quick goblin scout wearing patched leathers and carrying a scavenged spyglass.',
      '',
      '### Type (optional)',
      'enemy',
      '',
      '### Floor (optional)',
      '2',
      '',
      '### Floor ID (optional)',
      'floor2',
      '',
      '### Family ID (optional)',
      'goblins',
      '',
      '### Mob Role (optional)',
      'elite',
      '',
      '### Floor Injection Override (optional)',
      'OVERRIDDEN FLOOR DIRECTION',
      '',
      '### Family Injection Override (optional)',
      'OVERRIDDEN FAMILY DIRECTION',
    ].join('\n');

    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.assetRequestContext).toEqual(
      expect.objectContaining({
        sourceIds: expect.objectContaining({
          floorId: 'floor2',
          enemyPackId: 'floor2-families',
          familyId: 'goblins',
        }),
        mobRole: 'elite',
        injections: {
          floor: 'OVERRIDDEN FLOOR DIRECTION',
          family: 'OVERRIDDEN FAMILY DIRECTION',
        },
        injectionOverrides: {
          floor: 'OVERRIDDEN FLOOR DIRECTION',
          family: 'OVERRIDDEN FAMILY DIRECTION',
        },
      }),
    );
  });

  it('rejects a family not provided by the selected game enemy pack', () => {
    expect(() =>
      resolveAssetRequestContext({
        floor: 2,
        floorId: 'floor2',
        familyId: 'unicorns',
        mobRole: 'boss',
      }),
    ).toThrow("Family 'unicorns' is not bound");
  });
});
