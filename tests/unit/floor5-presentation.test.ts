import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeFloor5Scenario } from '../../src/game/floor5Scenario.js';
import { getFloor5HudSnapshot } from '../../src/game/floor5Presentation.js';
import { createTestWorld } from '../helpers/world-factory.js';

function siegeWorld() {
  const world = createTestWorld({ seed: 505 });
  initializeFloor5Scenario(world, spawnPlayer(world, 0, 0));
  return world;
}

describe('Floor 5 HUD presentation', () => {
  it('does not expose a siege HUD outside Floor 5', () => {
    expect(getFloor5HudSnapshot(createTestWorld())).toBeNull();
  });

  it('projects live phase, objective, Command Post and Ram state without mutation', () => {
    const world = siegeWorld();
    const state = world.floorExtendedState!.floor5Siege!;
    const before = JSON.stringify(state);
    const initial = getFloor5HudSnapshot(world)!;
    expect(initial.lines).toHaveLength(4);
    expect(initial.lines[0]).toContain('Muster | Objective: Defend the Command Post');
    expect(initial.lines[1]).toContain(`Command Post ${state.commandPostHealth}/`);
    expect(initial.lines[2]).toContain('Ram: Locked');
    expect(initial.lines[3]).toContain('Hostile pressure: 0 minions');
    expect(initial.lines[3]).toContain('wave cap 4/16');
    expect(initial.lines[3]).toContain('Heroes 0/2 max');
    expect(JSON.stringify(state)).toBe(before);

    state.commandPostHealth = 37;
    state.phase = { kind: 'BUILD' };
    state.engineState = 'BUILDING';
    state.construction.progressMs = state.construction.requiredMs / 2;
    state.construction.buildSiteUnderAttack = true;
    const building = getFloor5HudSnapshot(world)!;
    expect(building.id).not.toBe(initial.id);
    expect(building.lines[0]).toContain('Clear attackers from the build site');
    expect(building.lines[1]).toContain('Command Post 37/');
    expect(building.lines[2]).toContain('build 50% (paused)');
  });

  it('distinguishes route progress, protection, wall damage and terminal objectives', () => {
    const world = siegeWorld();
    const state = world.floorExtendedState!.floor5Siege!;
    state.phase = { kind: 'ESCORT' };
    state.engineState = 'ADVANCING';
    state.ram.health = 23;
    state.ram.protectionMet = false;
    expect(getFloor5HudSnapshot(world)!.lines[0]).toContain('Clear threats near the Ram');
    expect(getFloor5HudSnapshot(world)!.lines[2]).toContain('23/');
    expect(getFloor5HudSnapshot(world)!.lines[2]).toContain('holding');
    state.engineState = 'DESTROYED';
    expect(getFloor5HudSnapshot(world)!.lines[0]).toContain(
      'Defend the Command Post during rebuild',
    );
    expect(getFloor5HudSnapshot(world)!.lines[2]).toContain('rebuild pending');
    state.engineState = 'ATTACKING';
    state.phase = { kind: 'BREACH' };
    state.structures['outer-wall'].health = 19;
    expect(getFloor5HudSnapshot(world)!.lines[2]).toContain('wall 19/');
    state.phase = { kind: 'THRONE' };
    state.finale.captureAvailable = true;
    expect(getFloor5HudSnapshot(world)!.lines[0]).toContain('Capture the throne');
    state.phase = { kind: 'DEFEAT' };
    expect(getFloor5HudSnapshot(world)!.lines[0]).toContain('Command Post lost');
  });
});
