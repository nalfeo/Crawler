import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  _recoverFloor5RamComponent,
  initializeFloor5Scenario,
} from '../../src/game/floor5Scenario.js';
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
    expect(initial.lines[1]).toContain('secure');
    expect(initial.lines[1]).toContain('Escalation: holding line');
    expect(initial.lines[2]).toContain('Ram: Locked');
    expect(initial.lines[3]).toContain('Hostile pressure: 0 minions');
    expect(initial.lines[3]).toContain('wave cap 4/16');
    expect(initial.lines[3]).toContain('Heroes 0/2 max');
    expect(initial.cues).toEqual([]);
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
    expect(building.lines[1]).toContain('critical — return to the line');
    expect(building.cues).toEqual([
      { id: 'floor5-command-post-critical-audio', kind: 'audio', label: 'Command Post critical' },
      { id: 'floor5-command-post-critical-vfx', kind: 'vfx', label: 'Command Post critical' },
    ]);
    expect(building.lines[2]).toContain('build 50% (paused)');
  });

  it('projects a stable, non-color-only command post warning before the critical tier', () => {
    const world = siegeWorld();
    const state = world.floorExtendedState!.floor5Siege!;
    state.commandPostHealth = 700;

    const warning = getFloor5HudSnapshot(world)!;

    expect(warning.lines[1]).toContain('under attack — defend the line');
    expect(warning.cues).toEqual([
      {
        id: 'floor5-command-post-danger-audio',
        kind: 'audio',
        label: 'Command Post under attack',
      },
      {
        id: 'floor5-command-post-danger-vfx',
        kind: 'vfx',
        label: 'Command Post under attack',
      },
    ]);
  });

  it('projects deterministic non-color-only Field Hero deployment and defeat states', () => {
    const world = siegeWorld();
    const state = world.floorExtendedState!.floor5Siege!;
    const card = state.heroes.card[0]!;
    state.heroes.cursor = 0;
    state.heroes.status = 'active';
    state.heroes.health = card.hp;
    state.heroes.maxHealth = card.hp;

    const active = getFloor5HudSnapshot(world)!;
    expect(active.lines[3]).toContain(
      `Field Hero ${card.displayName} · ${card.role.charAt(0).toUpperCase()}${card.role.slice(1)} · active`,
    );
    expect(active.cues).toContainEqual({
      id: `floor5-hero-active-${card.heroId}-audio`,
      kind: 'audio',
      label: `${card.displayName} deployed`,
    });

    state.heroes.status = 'down';
    const defeated = getFloor5HudSnapshot(world)!;
    expect(defeated.lines[3]).toContain(`Field Hero ${card.displayName} defeated`);
    expect(defeated.cues).toContainEqual({
      id: `floor5-hero-defeated-${card.heroId}-vfx`,
      kind: 'vfx',
      label: `${card.displayName} defeated`,
    });

    state.phase = { kind: 'CAPTURED' };
    expect(getFloor5HudSnapshot(world)!.cues).toEqual([]);
  });

  it('makes a field-equipment payoff visible at the Command Post before it takes damage', () => {
    const world = siegeWorld();
    const state = world.floorExtendedState!.floor5Siege!;

    _recoverFloor5RamComponent(world, 'chassis');
    _recoverFloor5RamComponent(world, 'plating');
    _recoverFloor5RamComponent(world, 'broadcast-array');

    const snapshot = getFloor5HudSnapshot(world)!;
    expect(state.commandPostHealth).toBe(1000);
    expect(snapshot.lines[1]).toContain('secure');
    expect(snapshot.lines[1]).toContain('Escalation: siege payoff 1/6 — supplies applied');
    expect(snapshot.lines[3]).toContain('1 escalation beats');
  });

  it.each([700, 37])('suppresses danger after capture with %i post health', (health) => {
    const world = siegeWorld();
    const state = world.floorExtendedState!.floor5Siege!;
    state.commandPostHealth = health;
    state.phase = { kind: 'CAPTURED' };
    const snapshot = getFloor5HudSnapshot(world)!;
    expect(snapshot.lines[0]).toContain('Castle captured');
    expect(snapshot.lines[1]).toContain('secure');
    expect(snapshot.cues).toEqual([]);
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
    state.breach.latched = true;
    expect(getFloor5HudSnapshot(world)!.lines[1]).toContain(
      'Escalation: breach open — route to throne',
    );
    state.phase = { kind: 'THRONE' };
    state.finale.captureAvailable = true;
    expect(getFloor5HudSnapshot(world)!.lines[0]).toContain('Capture the throne');
    state.phase = { kind: 'DEFEAT' };
    expect(getFloor5HudSnapshot(world)!.lines[0]).toContain('Command Post lost');
  });
});
