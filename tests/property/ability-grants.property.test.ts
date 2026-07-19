import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  getOrCreateAbilityState,
  grantAbilitySources,
  revokeAbilitySources,
} from '../../src/game/systems/abilitySystem.js';
import { equipmentAbilityGrantSourceId } from '../../src/shared/abilities.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('source-owned ability grant properties', () => {
  it('keeps a passive granted exactly while at least one source remains', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.integer({ min: 0, max: 20 }),
        (ordinals, raw) => {
          const world = createTestWorld();
          const player = spawnPlayer(world, 0, 0);
          const sources = ordinals.map((ordinal) =>
            equipmentAbilityGrantSourceId(`gei:v1:property:${ordinal}`, 0),
          );
          const count = sources.length;
          grantAbilitySources(
            world,
            player,
            sources.map((sourceId) => ({
              kind: 'passive' as const,
              abilityId: 'veteran-instinct',
              sourceId,
            })),
          );

          const removeCount = raw % (count + 1);
          revokeAbilitySources(world, player, sources.slice(0, removeCount));

          const state = getOrCreateAbilityState(world, player);
          expect(state.passiveAbilityIds.includes('veteran-instinct')).toBe(removeCount < count);
          expect(
            state.grantOwnership.passiveSourcesByAbilityId.get('veteran-instinct')?.size ?? 0,
          ).toBe(count - removeCount);
        },
      ),
    );
  });
});
