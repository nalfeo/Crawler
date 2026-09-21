import { describe, expect, it } from 'vitest';
import { entityExists, query } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { GAME } from '../../src/shared/constants.js';
import { FLOOR4_BOSS_ABILITY_CATALOG } from '../../src/shared/boss-abilities.js';
import { EnemyProjectile } from '../../src/core/components.js';
import { applyDamage } from '../../src/core/apply-damage.js';
import {
  spawnPlayer,
  spawnBehaviorEnemy,
  setEnemyAppearanceKey,
} from '../../src/core/spawners/combatants.js';
import { statusEffectSystem } from '../../src/core/systems/statusEffectSystem.js';
import { createFloor4HeadlinerAbilityDefinition } from '../../src/core/mob-abilities/floor4-headliners.js';
import {
  activateMobAbilityEncounter,
  clearMobAbility,
  disableMobAbilityEncounter,
  getMobAbilityKnockbackResistanceMultiplier,
  mobAbilitySystem,
  registerMobAbility,
  setMobAbilitiesEnabled,
} from '../../src/core/mob-abilities/runtime.js';
import type { MobAbilityResolveHandler } from '../../src/core/mob-abilities/types.js';

function setup(archetype: string, summons: MobAbilityResolveHandler = () => {}) {
  const world = createTestWorld();
  const player = spawnPlayer(world, 10, 0);
  const boss = spawnBehaviorEnemy(world, 0, 0, 1000, 0, 0.1, 60, 0);
  world.stores.damage.amount[boss] = 20;
  setEnemyAppearanceKey(world, boss, archetype);
  const definition = createFloor4HeadlinerAbilityDefinition(archetype, summons);
  setMobAbilitiesEnabled(world, true);
  registerMobAbility(world, boss, definition);
  activateMobAbilityEncounter(world);
  const instance = world.mobAbilities.byEntity.get(boss)!;
  const tick = (frames: number) => {
    for (let i = 0; i < frames; i += 1) {
      world.frameCount += 1;
      world.elapsedMs += GAME.DELTA_MS;
      statusEffectSystem(world);
      mobAbilitySystem(world);
    }
  };
  const advance = (ms: number) => tick(Math.round(ms / GAME.DELTA_MS));
  const telegraph = () => advance(definition.firstEligibleAfterMs);
  const resolve = () => advance(definition.telegraphDurationMs);
  const position = (eid: number, x: number, y: number) => {
    world.stores.position.x[eid] = x;
    world.stores.position.y[eid] = y;
  };
  return { world, player, boss, definition, instance, tick, advance, telegraph, resolve, position };
}

describe('Floor 4 authored Headliner clocks', () => {
  it.each(FLOOR4_BOSS_ABILITY_CATALOG.entries)(
    '$bossName binds its authored timing and repeats after resolution',
    (ability) => {
      const f = setup(ability.bossArchetypeId);
      expect(f.definition.abilityId).toBe(ability.id);
      f.advance(ability.timing.firstEligibleAfterMs - GAME.DELTA_MS);
      expect(f.instance.phase).toBe('cooldown');
      expect(f.world.mobAbilities.cues).toHaveLength(0);
      f.tick(1);
      expect(f.instance.phase).toBe('telegraph');
      expect(f.instance.announcementsEmitted).toBe(1);
      expect(f.world.mobAbilities.cues[0]?.announcementText).toContain(ability.attackName);
      f.advance(ability.telegraph.durationMs - GAME.DELTA_MS);
      expect(f.instance.resolvedCasts).toBe(0);
      f.tick(1);
      expect(f.instance.resolvedCasts).toBe(1);
      expect(f.instance.timerMs).toBe(ability.timing.cooldownMs);
      expect(f.world.mobAbilities.cues).toHaveLength(0);
      f.advance(ability.timing.cooldownMs - GAME.DELTA_MS);
      expect(f.instance.announcementsEmitted).toBe(1);
      f.tick(1);
      expect(f.instance.phase).toBe('telegraph');
      expect(f.instance.announcementsEmitted).toBe(2);
    },
  );
});

describe('Floor 4 committed attack geometry and counterplay', () => {
  it('Bellhop hits and shoves from the locked center, while leaving it avoids damage', () => {
    const f = setup('floor4-bellhop-brawler');
    f.telegraph();
    expect(f.instance.committedGeometry).toEqual({ kind: 'circle', x: 10, y: 0, radiusFt: 10 });
    f.resolve();
    expect(f.world.stores.health.current[f.player]).toBe(80);
    expect(f.world.stores.position.x[f.player]).toBe(12);
    f.advance(f.definition.cooldownMs);
    const locked = f.instance.committedGeometry;
    f.position(f.player, 40, 40);
    f.tick(1);
    expect(f.instance.committedGeometry).toEqual(locked);
    f.advance(f.definition.telegraphDurationMs - GAME.DELTA_MS);
    expect(f.world.stores.health.current[f.player]).toBe(80);
  });

  it.each([
    { x: 12, y: 0, hp: 70 },
    { x: 0, y: 12, hp: 100 },
  ])('Mascot resolves the fixed cone and physically lunges: $x,$y', ({ x, y, hp }) => {
    const f = setup('floor4-mascot-mauler');
    f.telegraph();
    expect(f.instance.committedGeometry).toMatchObject({
      kind: 'cone',
      rangeFt: 24,
      angleDeg: 80,
      facingRad: 0,
    });
    f.position(f.player, x, y);
    f.resolve();
    expect(f.world.stores.health.current[f.player]).toBe(hp);
    expect(f.world.stores.position.x[f.boss]).toBe(24);
    expect(f.world.stores.position.y[f.boss]).toBe(0);
  });

  it.each([
    { offset: 6, hp: 70, finalX: 16 },
    { offset: 0, hp: 100, finalX: 14 },
    { offset: 18, hp: 100, finalX: 28 },
  ])(
    'Stunt distinguishes final ring, safe center shove, and outside: $offset',
    ({ offset, hp, finalX }) => {
      const f = setup('floor4-stunt-captain');
      f.telegraph();
      expect(f.instance.committedGeometry).toMatchObject({
        kind: 'contracting-annulus',
        x: 10,
        y: 0,
        startRadiusFt: 18,
        endRadiusFt: 6,
        ringWidthFt: 3,
      });
      f.position(f.player, 10 + offset, 0);
      f.resolve();
      expect(f.world.stores.health.current[f.player]).toBe(hp);
      expect(f.world.stores.position.x[f.player]).toBe(finalX);
      expect(f.world.stores.position.x[f.boss]).toBe(10);
    },
  );

  it.each([
    { x: 30, y: 0, hp: 70 },
    { x: 10, y: 5, hp: 100 },
  ])(
    'Contract reaches its full authored lane; perpendicular escape is safe: $x,$y',
    ({ x, y, hp }) => {
      const f = setup('floor4-contract-collector');
      f.telegraph();
      expect(f.instance.committedGeometry).toMatchObject({
        kind: 'lane',
        widthFt: 7,
        lengthFt: 34,
        endX: 34,
        endY: 0,
      });
      f.position(f.player, x, y);
      f.resolve();
      expect(f.world.stores.health.current[f.player]).toBe(hp);
      const effects = f.world.statusEffectsByEntity.get(f.player) ?? [];
      if (hp < 100)
        expect(effects).toEqual([
          expect.objectContaining({ stat: 'speed', value: 0.8, remainingMs: 2500 }),
        ]);
      else expect(effects).toHaveLength(0);
    },
  );
});

describe('Floor 4 persistent ability effects', () => {
  it('Ringmaster follows its caster and applies both debuffs for exactly three seconds', () => {
    const f = setup('floor4-ringmaster-proxy');
    f.telegraph();
    f.position(f.boss, 20, 0);
    f.tick(1);
    expect(f.instance.committedGeometry).toEqual({ kind: 'circle', x: 20, y: 0, radiusFt: 18 });
    f.advance(f.definition.telegraphDurationMs - GAME.DELTA_MS);
    expect(f.world.statusEffectsByEntity.get(f.player)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stat: 'speed', value: 0.8, remainingMs: 3000 }),
        expect.objectContaining({ stat: 'attackSpeed', value: 0.85, remainingMs: 3000 }),
      ]),
    );
    f.advance(3000 - GAME.DELTA_MS);
    expect(f.world.statusEffectsByEntity.get(f.player)).toHaveLength(2);
    f.tick(1);
    expect(f.world.statusEffectsByEntity.has(f.player)).toBe(false);
  });

  it('leaving Ringmaster aura before resolution avoids both debuffs', () => {
    const f = setup('floor4-ringmaster-proxy');
    f.telegraph();
    f.position(f.player, 19, 0);
    f.resolve();
    expect(f.world.statusEffectsByEntity.has(f.player)).toBe(false);
  });

  it('Sentinel reduces actual incoming damage without stacking or extending its four-second protection', () => {
    const f = setup('floor4-sponsor-sentinel');
    f.telegraph();
    const geometry = f.instance.committedGeometry!;
    f.resolve();
    const damage = () =>
      applyDamage(f.world, f.boss, 100, 0, 0, {
        origin: 'environment',
        affinity: 'unscaled',
        canCrit: false,
        scaleWithPrimary: false,
      });
    expect(damage()).toBe(65);
    expect(getMobAbilityKnockbackResistanceMultiplier(f.world, f.boss)).toBe(0.65);
    f.advance(1000);
    f.definition.resolve(f.world, {
      abilityId: f.definition.abilityId,
      casterEid: f.boss,
      sourceId: `mob-ability:${f.definition.abilityId}:${f.boss}`,
      geometry,
      targetEid: null,
    });
    expect(damage()).toBe(65);
    f.advance(3000 - GAME.DELTA_MS);
    expect(f.world.mobAbilities.activeBuffsByEntity.has(f.boss)).toBe(true);
    f.tick(1);
    expect(damage()).toBe(100);
    expect(getMobAbilityKnockbackResistanceMultiplier(f.world, f.boss)).toBe(1);
  });

  it('Pyro leaves three locked hot circles for exactly two seconds', () => {
    const f = setup('floor4-pyro-principal');
    f.telegraph();
    const geometry = f.instance.committedGeometry!;
    expect(geometry.kind).toBe('multi-circle');
    if (geometry.kind !== 'multi-circle') throw new Error('Expected three blast circles');
    expect(geometry.circles).toHaveLength(3);
    expect(geometry.circles.map((circle) => circle.radiusFt)).toEqual([8, 8, 8]);
    f.position(f.player, geometry.circles[0]!.x, geometry.circles[0]!.y);
    f.resolve();
    expect(f.world.stores.health.current[f.player]).toBe(80);
    expect(f.world.mobAbilities.ownedZones).toHaveLength(1);
    expect(f.world.mobAbilities.ownedZones[0]?.geometry).toEqual(geometry);
    f.advance(500);
    expect(f.world.stores.health.current[f.player]).toBe(75);
    f.position(f.player, 100, 100);
    f.advance(1500 - GAME.DELTA_MS);
    expect(f.world.mobAbilities.ownedZones).toHaveLength(1);
    f.tick(1);
    expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
    expect(f.world.stores.health.current[f.player]).toBe(75);
  });

  it('Camera fires eight committed radial projectiles and encounter teardown removes all of them', () => {
    const f = setup('floor4-camera-kraken');
    f.telegraph();
    expect(f.instance.committedGeometry).toMatchObject({
      kind: 'radial-projectiles',
      casterX: 0,
      casterY: 0,
      count: 8,
      offsetDeg: 0,
    });
    f.position(f.boss, 40, 40);
    f.resolve();
    const projectiles = [...query(f.world.ecs, [EnemyProjectile])];
    expect(projectiles).toHaveLength(8);
    expect(f.instance.ownedEntityGenerations.size).toBe(8);
    projectiles.forEach((eid, index) => {
      expect(f.world.stores.position.x[eid]).toBe(0);
      expect(f.world.stores.position.y[eid]).toBe(0);
      expect(
        Math.atan2(f.world.stores.velocity.y[eid]!, f.world.stores.velocity.x[eid]!),
      ).toBeCloseTo(Math.atan2(Math.sin((index * Math.PI) / 4), Math.cos((index * Math.PI) / 4)));
    });
    disableMobAbilityEncounter(f.world);
    expect(query(f.world.ecs, [EnemyProjectile])).toHaveLength(0);
    expect(f.world.mobAbilities.byEntity.size).toBe(0);
    expect(f.world.mobAbilities.pendingBursts).toHaveLength(0);
  });
});

describe('Floor 4 ability ownership teardown', () => {
  it.each(['floor4-ringmaster-proxy', 'floor4-pyro-principal', 'floor4-sponsor-sentinel'])(
    'clears persistent effects when %s dies',
    (archetype) => {
      const f = setup(archetype);
      f.telegraph();
      f.resolve();
      f.world.stores.health.current[f.boss] = 0;
      f.tick(1);
      expect(f.world.mobAbilities.byEntity.size).toBe(0);
      expect(f.world.mobAbilities.ownedZones).toHaveLength(0);
      expect(f.world.mobAbilities.activeBuffsByEntity.size).toBe(0);
      expect(f.world.statusEffectsByEntity.size).toBe(0);
    },
  );

  it('cancels a pending cast on encounter end', () => {
    const f = setup('floor4-bellhop-brawler');
    f.telegraph();
    disableMobAbilityEncounter(f.world);
    f.resolve();
    expect(f.world.stores.health.current[f.player]).toBe(100);
    expect(f.world.mobAbilities.cues).toHaveLength(0);
    expect(f.world.announcements.filter((event) => event.kind === 'bossAbilityCast')).toHaveLength(
      0,
    );
  });

  it('Showrunner cleanup removes its owned adds but preserves an EID whose generation changed', () => {
    const owned: number[] = [];
    const f = setup('floor4-showrunner', (world, ctx) => {
      for (let i = 0; i < 2; i += 1) {
        const eid = spawnBehaviorEnemy(world, i, 10, 20, 0, 0.1, 60, 0);
        ctx.registerOwnedEntity?.(eid);
        owned.push(eid);
      }
    });
    f.telegraph();
    f.resolve();
    const removed = owned[0]!;
    const recycled = owned[1]!;
    f.world.entityRenderGeneration[recycled] = f.world.entityRenderGeneration[recycled]! + 1;
    clearMobAbility(f.world, f.boss);
    expect(entityExists(f.world.ecs, removed)).toBe(false);
    expect(entityExists(f.world.ecs, recycled)).toBe(true);
    expect(f.world.stores.health.current[recycled]).toBe(20);
    expect(f.world.mobAbilities.byEntity.size).toBe(0);
  });
});
