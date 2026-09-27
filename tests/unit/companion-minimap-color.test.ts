import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Companion, FamilyMembership, Team } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { companionMinimapColor } from '../../src/engine/companion-minimap-color.js';
import { TeamId } from '../../src/shared/constants.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('companion minimap allegiance', () => {
  it('reserves green for player Companions even when they carry family membership', () => {
    const world = createTestWorld();
    const eid = spawnPlayer(world, 0, 0);
    expect(companionMinimapColor(world, eid)).toBeNull();
    addComponent(world.ecs, eid, Companion);
    addComponent(world.ecs, eid, FamilyMembership);
    addComponent(world.ecs, eid, set(Team, { id: TeamId.PLAYER }));
    expect(companionMinimapColor(world, eid)).toBe(0x4ade80);
    world.stores.team.id[eid] = TeamId.ENEMY;
    expect(companionMinimapColor(world, eid)).toBe(0xef4444);
  });
});
