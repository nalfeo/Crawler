import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { GAME } from '../../src/shared/constants.js';
import { Knockback } from '../../src/core/components.js';
import { spawnBehaviorEnemy, spawnPlayer, setEnemyAppearanceKey } from '../../src/core/helpers.js';
import {
  activateMobAbilityEncounter,
  clearMobAbility,
  disableMobAbilityEncounter,
  mobAbilitySystem,
  registerMobAbility,
  registerMobAbilityOwnedZone,
  setMobAbilitiesEnabled,
} from '../../src/core/mob-abilities/runtime.js';
import {
  createAbuelaThornRingDefinition,
  createChitinTurnoverDefinition,
  createLongSqueezeDefinition,
  createMidnightResonanceDefinition,
} from '../../src/core/mob-abilities/floor2-ring-abilities.js';
import {
  circlesForMobAbilityGeometry,
  flattenMobAbilityGeometry,
  type MobAbilityRuntimeDefinition,
} from '../../src/core/mob-abilities/types.js';
import { getStatusEffects } from '../../src/core/status-effects.js';
import { createTestWorld } from '../helpers/world-factory.js';

const factories = [
  createAbuelaThornRingDefinition,
  createMidnightResonanceDefinition,
  createChitinTurnoverDefinition,
  createLongSqueezeDefinition,
];

function setup(factory: () => MobAbilityRuntimeDefinition, x = 40, y = 0) {
  const world = createTestWorld({ seed: 42 });
  world.floorId = 'floor2';
  const player = spawnPlayer(world, x, y);
  world.stores.health.current[player] = 1000;
  world.stores.health.max[player] = 1000;
  const boss = spawnBehaviorEnemy(world, 0, 0, 5000, 0, 0.1, 100, 0);
  const def = factory();
  setEnemyAppearanceKey(world, boss, def.bossArchetypeKey);
  setMobAbilitiesEnabled(world, true);
  registerMobAbility(world, boss, def);
  activateMobAbilityEncounter(world);
  const tick = (frames: number) => {
    for (let i = 0; i < frames; i += 1) {
      world.elapsedMs += GAME.DELTA_MS;
      world.frameCount += 1;
      mobAbilitySystem(world);
    }
  };
  const begin = () => tick(Math.round(def.firstEligibleAfterMs / GAME.DELTA_MS));
  const resolve = () => tick(Math.round(def.telegraphDurationMs / GAME.DELTA_MS));
  return { world, player, boss, def, tick, begin, resolve };
}

describe('Floor 2 ring signatures', () => {
  it('Abuela preserves both safe regions, detonates only after its full warning, and knocks outward', () => {
    for (const [distance, hit] of [
      [0, false],
      [10, true],
      [20, false],
    ] as const) {
      const { world, player, begin, resolve } = setup(createAbuelaThornRingDefinition, distance);
      begin();
      expect(world.mobAbilities.cues[0]?.geometry).toEqual({
        kind: 'annulus',
        x: 0,
        y: 0,
        innerRadiusFt: 6,
        outerRadiusFt: 15,
      });
      expect(world.stores.health.current[player]).toBe(1000);
      resolve();
      expect(world.stores.health.current[player]).toBe(hit ? 980 : 1000);
      expect(hasComponent(world.ecs, player, Knockback)).toBe(hit);
      if (hit) expect(world.stores.knockback.dirX[player]).toBe(1);
    }
  });

  it('Vesper detonates bands at resolution, +350ms and +700ms, keeping the used band safe', () => {
    const { world, player, begin, resolve, tick } = setup(createMidnightResonanceDefinition, 12);
    begin();
    const telegraph = world.mobAbilities.cues[0]!.geometry;
    expect(telegraph.kind).toBe('composite');
    if (telegraph.kind !== 'composite') throw new Error('Missing ordered warning');
    expect(telegraph.orderedIntervalMs).toBe(350);
    expect(flattenMobAbilityGeometry(telegraph)).toHaveLength(3);
    resolve();
    expect(world.stores.health.current[player]).toBe(1000);
    tick(20);
    expect(world.stores.health.current[player]).toBe(1000);
    tick(1);
    expect(world.stores.health.current[player]).toBe(980);
    world.stores.position.x[player] = 20;
    tick(20);
    expect(world.stores.health.current[player]).toBe(980);
    tick(1);
    expect(world.stores.health.current[player]).toBe(960);
    expect(world.mobAbilities.ownedZones).toHaveLength(0);
    tick(50);
    expect(world.stores.health.current[player]).toBe(960);

    const safe = setup(createMidnightResonanceDefinition, 4);
    safe.begin();
    safe.resolve();
    expect(safe.world.stores.health.current[safe.player]).toBe(980);
    safe.tick(42);
    expect(safe.world.stores.health.current[safe.player]).toBe(980);
  });

  it('Broodfather exposes its rotation, sweeps for 1600ms once per player, then alternates direction', () => {
    const { world, player, boss, def, begin, resolve, tick } = setup(
      createChitinTurnoverDefinition,
      10,
    );
    begin();
    const first = world.mobAbilities.cues[0]!.geometry;
    expect(first.kind).toBe('sweeping-arc');
    if (first.kind !== 'sweeping-arc') throw new Error('Missing rotating arc');
    expect(first.direction).toBe(1);
    world.stores.position.x[player] = 0;
    world.stores.position.y[player] = 10;
    resolve();
    expect(world.stores.health.current[player]).toBe(1000);
    tick(24);
    expect(world.stores.health.current[player]).toBe(980);
    const active = world.mobAbilities.ownedZones[0]!.geometry;
    expect(active.kind).toBe('sweeping-arc');
    if (active.kind === 'sweeping-arc') expect(active.facingRad).toBeCloseTo(Math.PI / 2);
    tick(72);
    expect(world.mobAbilities.ownedZones).toHaveLength(0);
    expect(world.stores.health.current[player]).toBe(980);
    tick(Math.round(def.cooldownMs / GAME.DELTA_MS) - 96);
    const next = world.mobAbilities.cues[0]!.geometry;
    if (next.kind !== 'sweeping-arc') throw new Error('Missing next arc');
    expect(next.direction).toBe(-1);
    expect(world.mobAbilities.byEntity.get(boss)?.resolvedCasts).toBe(1);
  });

  it('Long Squeeze contracts its visible ring over 2500ms, hits once and applies 35% slow for 4 seconds', () => {
    const { world, player, begin, resolve, tick } = setup(createLongSqueezeDefinition, 14);
    begin();
    resolve();
    expect(world.stores.health.current[player]).toBe(1000);
    const initial = world.mobAbilities.ownedZones[0]!.geometry;
    expect(initial).toEqual({ kind: 'annulus', x: 0, y: 0, innerRadiusFt: 22, outerRadiusFt: 26 });
    tick(75);
    const halfway = world.mobAbilities.ownedZones[0]!.geometry;
    expect(halfway.kind).toBe('annulus');
    if (halfway.kind === 'annulus') expect(halfway.innerRadiusFt).toBeCloseTo(12.5);
    expect(world.stores.health.current[player]).toBe(980);
    const slow = getStatusEffects(world, player).find((effect) => effect.stat === 'speed');
    expect(slow?.value).toBe(0.65);
    expect(slow?.remainingMs).toBe(4000);
    tick(75);
    expect(world.mobAbilities.ownedZones).toHaveLength(0);
    expect(world.stores.health.current[player]).toBe(980);
    const safe = setup(createLongSqueezeDefinition, 0);
    safe.begin();
    safe.resolve();
    safe.tick(150);
    expect(safe.world.stores.health.current[safe.player]).toBe(1000);
  });

  it.each(factories)(
    '%s repeats identically and cleans every owned hazard on caster death',
    (factory) => {
      const run = () => {
        const fixture = setup(factory);
        fixture.begin();
        fixture.resolve();
        fixture.tick(
          Math.round((fixture.def.cooldownMs + fixture.def.telegraphDurationMs) / GAME.DELTA_MS),
        );
        expect(fixture.world.mobAbilities.byEntity.get(fixture.boss)?.resolvedCasts).toBe(2);
        const snapshot = {
          hp: fixture.world.stores.health.current[fixture.player],
          zones: fixture.world.mobAbilities.ownedZones.map((zone) => zone.geometry),
          rng: fixture.world.rng.next(),
        };
        fixture.world.stores.health.current[fixture.boss] = 0;
        fixture.tick(1);
        expect(fixture.world.mobAbilities.byEntity.size).toBe(0);
        expect(fixture.world.mobAbilities.ownedZones).toHaveLength(0);
        expect(fixture.world.mobAbilities.cues).toHaveLength(0);
        expect(getStatusEffects(fixture.world, fixture.player)).toHaveLength(0);
        return snapshot;
      };
      expect(run()).toEqual(run());
    },
  );

  it('cleans active owned zones on encounter disable and per-caster clear', () => {
    for (const clear of [
      clearMobAbility,
      (world: ReturnType<typeof createTestWorld>, _boss: number) =>
        disableMobAbilityEncounter(world),
    ]) {
      const fixture = setup(createLongSqueezeDefinition, 24);
      fixture.begin();
      fixture.resolve();
      expect(fixture.world.mobAbilities.ownedZones).toHaveLength(1);
      expect(getStatusEffects(fixture.world, fixture.player)).toHaveLength(1);
      clear(fixture.world, fixture.boss);
      expect(fixture.world.mobAbilities.ownedZones).toHaveLength(0);
      expect(getStatusEffects(fixture.world, fixture.player)).toHaveLength(0);
    }
  });

  it('samples clamped geometry before ticks, never dispatching a tick past expiry', () => {
    const { world, boss, tick } = setup(createAbuelaThornRingDefinition);
    const samples: number[] = [];
    const ticks: number[] = [];
    registerMobAbilityOwnedZone(world, {
      abilityId: 'test',
      casterEid: boss,
      sourceId: 'test',
      durationMs: 25,
      tickIntervalMs: 10,
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 1 },
      sampleGeometry: (elapsed) => {
        samples.push(elapsed);
        return { kind: 'circle', x: elapsed, y: 0, radiusFt: 1 };
      },
      tick: (_world, zone) => {
        ticks.push(zone.nextTickAtMs);
        if (zone.geometry.kind === 'circle') expect(zone.geometry.x).toBe(samples.at(-1));
      },
    });
    tick(3);
    expect(samples).toEqual([GAME.DELTA_MS, 25]);
    expect(ticks).toEqual([10, 20]);
    expect(world.mobAbilities.ownedZones).toHaveLength(0);
  });

  it('honors a lane custom commit exactly once, keeping locked composite geometry', () => {
    let commits = 0;
    const fixture = setup(
      () => ({
        ...createAbuelaThornRingDefinition(),
        targetingMode: 'player-position',
        geometry: { kind: 'lane', widthFt: 6, maxRangeFt: 32 },
        commitGeometry: ({ lockedX, lockedY }) => {
          commits += 1;
          return {
            kind: 'composite',
            shapes: [{ kind: 'circle', x: lockedX, y: lockedY, radiusFt: 8 }],
          };
        },
        resolve: () => undefined,
      }),
      20,
      5,
    );
    fixture.begin();
    const locked = fixture.world.mobAbilities.cues[0]!.geometry;
    expect(locked).toEqual({
      kind: 'composite',
      shapes: [{ kind: 'circle', x: 20, y: 5, radiusFt: 8 }],
    });
    fixture.world.stores.position.x[fixture.player] = 40;
    fixture.tick(1);
    expect(fixture.world.mobAbilities.cues[0]!.geometry).toEqual(locked);
    expect(commits).toBe(1);
  });

  it('flattens composites without turning safe annulus holes into filled circles', () => {
    const circle = { kind: 'circle' as const, x: 0, y: 0, radiusFt: 2 };
    const annulus = { kind: 'annulus' as const, x: 0, y: 0, innerRadiusFt: 6, outerRadiusFt: 15 };
    const composite = {
      kind: 'composite' as const,
      shapes: [circle, { kind: 'composite' as const, shapes: [annulus] }],
    };
    expect(flattenMobAbilityGeometry(composite)).toEqual([circle, annulus]);
    expect(circlesForMobAbilityGeometry(composite)).toEqual([circle]);
  });
});
