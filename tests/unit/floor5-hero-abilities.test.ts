import { describe, expect, it } from 'vitest';
import { addComponent } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import {
  Health,
  Position,
  SiegeHero,
  SiegeMinion,
  Team,
  createEntity,
  set,
  spawnPlayer,
  type GameWorld,
  type MobAbilityGeometry,
  type MobAbilityResolveContext,
} from '../../src/core/index.js';
import { initializeFloor5Scenario } from '../../src/game/floor5Scenario.js';
import { createFloor5HeroAbilityDefinition } from '../../src/game/floor5HeroAbilities.js';
import {
  FLOOR5_FIELD_HERO_ROSTER,
  buildFloor5FieldHeroCard,
} from '../../src/shared/floor5-heroes.js';
import { TeamId } from '../../src/shared/constants.js';
import type {
  Floor5FieldHeroCardEntry,
  Floor5FieldHeroRole,
  Floor5SiegeState,
} from '../../src/shared/floor-types.js';

/**
 * Deterministic per-role coverage for the Floor 5 field-Hero abilities. Every
 * resolve handler is a pure function of world state plus committed geometry, so
 * each effect is exercised directly against a real initialized Floor 5 world —
 * no RNG, no wall clock, no frame-count luck.
 */

const CARD = buildFloor5FieldHeroCard(FLOOR5_FIELD_HERO_ROSTER, '505:floor5:heroes');

function cardFor(role: Floor5FieldHeroRole): Floor5FieldHeroCardEntry {
  const entry = CARD.find((candidate) => candidate.role === role);
  if (!entry) throw new Error(`no card entry for role ${role}`);
  return entry;
}

interface Harness {
  world: GameWorld;
  state: Floor5SiegeState;
}

function setupFloor5(): Harness {
  const world = createTestWorld({ seed: 505 }) as unknown as GameWorld;
  const player = spawnPlayer(world, 0, 0);
  initializeFloor5Scenario(world, player);
  const state = world.floorExtendedState?.floor5Siege;
  if (!state) throw new Error('floor5 siege state missing');
  return { world, state };
}

function spawnMinion(
  world: GameWorld,
  team: 'allied' | 'enemy',
  x: number,
  y: number,
  hp = 40,
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Health, { current: hp, max: hp }));
  addComponent(
    world.ecs,
    eid,
    set(Team, { id: team === 'allied' ? TeamId.SIEGE_ALLIED : TeamId.SIEGE_ENEMY }),
  );
  addComponent(
    world.ecs,
    eid,
    set(SiegeMinion, {
      team: team === 'allied' ? 1 : 2,
      manifestIndex: 0,
      targetEid: 0,
      lastX: x,
      lastY: y,
      stillFrames: 0,
    }),
  );
  return eid;
}

function spawnHeroCaster(world: GameWorld, x: number, y: number, targetEid = 0): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Health, { current: 100, max: 100 }));
  addComponent(world.ecs, eid, set(Team, { id: TeamId.SIEGE_ENEMY }));
  addComponent(
    world.ecs,
    eid,
    set(SiegeHero, { team: 2, rosterOrder: 1, role: 1, targetEid, anchorX: x, anchorY: y }),
  );
  return eid;
}

function resolveContext(casterEid: number, geometry: MobAbilityGeometry): MobAbilityResolveContext {
  return {
    abilityId: 'floor5-field-hero-test',
    casterEid,
    sourceId: `mob-ability:floor5-field-hero-test:${casterEid}`,
    geometry,
    targetEid: null,
  };
}

function circle(x: number, y: number, radiusFt: number): MobAbilityGeometry {
  return { kind: 'circle', x, y, radiusFt };
}

describe('Floor 5 field-Hero ability definitions', () => {
  it('locks artillery telegraph origin and lets self-centred roles follow the caster', () => {
    // Regression: `follows-caster` re-centres the committed circle on the Hero
    // every telegraph tick, which would throw away the artillery lob's
    // target-committed geometry.
    for (const role of [
      'counter-push',
      'checkpoint-defense',
      'engine-disruption',
      'minion-support',
    ] as const) {
      expect(createFloor5HeroAbilityDefinition(cardFor(role)).originMode).toBe('follows-caster');
    }
    const artillery = createFloor5HeroAbilityDefinition(cardFor('artillery'));
    expect(artillery.originMode).toBe('locked');
    expect(artillery.commitGeometry).toBeTypeOf('function');
  });

  it('counts one cast per resolution for every role', () => {
    for (const role of [
      'counter-push',
      'checkpoint-defense',
      'engine-disruption',
      'minion-support',
      'artillery',
    ] as const) {
      const { world, state } = setupFloor5();
      const caster = spawnHeroCaster(world, 0, 0);
      createFloor5HeroAbilityDefinition(cardFor(role)).resolve(
        world,
        resolveContext(caster, circle(0, 0, 6)),
      );
      expect(state.heroes.abilityCasts).toBe(1);
    }
  });
});

describe('counter-push · Restructuring Order', () => {
  it('reinforces the castle-side checkpoint without exceeding its max health', () => {
    const { world, state } = setupFloor5();
    const checkpoint = state.structures['enemy-checkpoint'].eid;
    expect(checkpoint).toBeGreaterThan(0);
    const max = world.stores.health.max[checkpoint] ?? 0;
    world.stores.health.current[checkpoint] = max - 3;
    const caster = spawnHeroCaster(world, 0, 0);
    const resolve = createFloor5HeroAbilityDefinition(cardFor('counter-push')).resolve;

    resolve(world, resolveContext(caster, circle(0, 0, 6)));

    expect(world.stores.health.current[checkpoint]).toBe(max);
  });
});

describe('checkpoint-defense · Audit Zone', () => {
  it('damages only besieging minions inside the committed circle', () => {
    const { world } = setupFloor5();
    const inside = spawnMinion(world, 'allied', 20, 20);
    const outside = spawnMinion(world, 'allied', 60, 20);
    const friendly = spawnMinion(world, 'enemy', 21, 20);
    const caster = spawnHeroCaster(world, 20, 20);

    createFloor5HeroAbilityDefinition(cardFor('checkpoint-defense')).resolve(
      world,
      resolveContext(caster, circle(20, 20, 9)),
    );

    expect(world.stores.health.current[inside]).toBeLessThan(40);
    expect(world.stores.health.current[outside]).toBe(40);
    expect(world.stores.health.current[friendly]).toBe(40);
  });
});

describe('engine-disruption · Wildcat Strike', () => {
  it('banks no stall while the Ratings Ram is not being built', () => {
    const { world, state } = setupFloor5();
    const caster = spawnHeroCaster(world, 0, 0);
    const resolve = createFloor5HeroAbilityDefinition(cardFor('engine-disruption')).resolve;

    resolve(world, resolveContext(caster, circle(0, 0, 10)));

    expect(state.engineState).toBe('LOCKED');
    expect(state.heroes.buildStallMs).toBe(0);
  });

  it('stalls one window at a time instead of accumulating deferred debt', () => {
    const { world, state } = setupFloor5();
    state.engineState = 'BUILDING';
    const caster = spawnHeroCaster(world, 0, 0);
    const resolve = createFloor5HeroAbilityDefinition(cardFor('engine-disruption')).resolve;

    resolve(world, resolveContext(caster, circle(0, 0, 10)));
    const afterFirst = state.heroes.buildStallMs;
    resolve(world, resolveContext(caster, circle(0, 0, 10)));

    expect(afterFirst).toBeGreaterThan(0);
    expect(state.heroes.buildStallMs).toBe(afterFirst);
  });

  it('expires the stall window against the fixed-step clock even when idle', () => {
    const { world, state } = setupFloor5();
    world.state = 'playing';
    state.heroes.buildStallMs = 2_000;

    // Under 1s of sim time so the auto-task advance stays out of the way; the
    // Ram is NOT building, and the window must still burn down.
    world.elapsedMs += 900;
    world.floorObjectiveTick?.(world);

    expect(state.engineState).toBe('LOCKED');
    expect(state.heroes.buildStallMs).toBe(1_100);
  });
});

describe('minion-support · Performance Review', () => {
  it('heals only castle-side minions inside the aura, capped at max health', () => {
    const { world } = setupFloor5();
    const ally = spawnMinion(world, 'enemy', 30, 30);
    const farAlly = spawnMinion(world, 'enemy', 80, 30);
    const enemyMinion = spawnMinion(world, 'allied', 31, 30);
    world.stores.health.current[ally] = 10;
    world.stores.health.current[farAlly] = 10;
    world.stores.health.current[enemyMinion] = 10;
    const caster = spawnHeroCaster(world, 30, 30);

    createFloor5HeroAbilityDefinition(cardFor('minion-support')).resolve(
      world,
      resolveContext(caster, circle(30, 30, 10)),
    );

    expect(world.stores.health.current[ally]).toBe(16);
    expect(world.stores.health.current[farAlly]).toBe(10);
    expect(world.stores.health.current[enemyMinion]).toBe(10);
  });

  it('never heals a minion above its max health', () => {
    const { world } = setupFloor5();
    const ally = spawnMinion(world, 'enemy', 30, 30);
    world.stores.health.current[ally] = 38;
    const caster = spawnHeroCaster(world, 30, 30);

    createFloor5HeroAbilityDefinition(cardFor('minion-support')).resolve(
      world,
      resolveContext(caster, circle(30, 30, 10)),
    );

    expect(world.stores.health.current[ally]).toBe(40);
  });
});

describe('artillery · Hostile Bid', () => {
  it('commits the lob onto the selected target, clamped to max range', () => {
    const { world } = setupFloor5();
    const near = spawnMinion(world, 'allied', 10, 0);
    const caster = spawnHeroCaster(world, 0, 0, near);
    const definition = createFloor5HeroAbilityDefinition(cardFor('artillery'));

    const committed = definition.commitGeometry!({
      world,
      casterEid: caster,
      targetEid: near,
      lockedX: 0,
      lockedY: 0,
    });

    expect(committed.kind).toBe('circle');
    expect(committed).toMatchObject({ x: 10, y: 0 });
  });

  it('clamps a distant target to the ability range and falls back to the lock', () => {
    const { world } = setupFloor5();
    const far = spawnMinion(world, 'allied', 100, 0);
    const caster = spawnHeroCaster(world, 0, 0, far);
    const definition = createFloor5HeroAbilityDefinition(cardFor('artillery'));

    expect(
      definition.commitGeometry!({
        world,
        casterEid: caster,
        targetEid: far,
        lockedX: 0,
        lockedY: 0,
      }),
    ).toMatchObject({ x: 22, y: 0 });

    world.stores.health.current[far] = 0;
    expect(
      definition.commitGeometry!({
        world,
        casterEid: caster,
        targetEid: far,
        lockedX: 4,
        lockedY: 5,
      }),
    ).toMatchObject({ x: 4, y: 5 });
  });

  it('resolves damage around the committed circle, not around the Hero', () => {
    const { world } = setupFloor5();
    const atTarget = spawnMinion(world, 'allied', 30, 0);
    const atHero = spawnMinion(world, 'allied', 0, 0);
    const caster = spawnHeroCaster(world, 0, 0, atTarget);

    createFloor5HeroAbilityDefinition(cardFor('artillery')).resolve(
      world,
      resolveContext(caster, circle(30, 0, 7)),
    );

    expect(world.stores.health.current[atTarget]).toBeLessThan(40);
    expect(world.stores.health.current[atHero]).toBe(40);
  });
});
