import { addComponent, addEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AoeOnImpact,
  AreaDamage,
  Enemy,
  EnemyProjectile,
  Gold,
  Harvestable,
  LineDamage,
  MeleeSwing,
  Npc,
  Player,
  Projectile,
  Returning,
  SpawnAnim,
  Spawner,
  Sprite,
  Team,
  Trap,
  XpGem,
} from '../../src/core/components.js';
import { set } from '../../src/core/world.js';
import { TeamId } from '../../src/shared/constants.js';
import { buildGeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { computeSpawnPopScale, spawnAnimProgress } from '../../src/shared/spawn-anim.js';
import {
  computeEnemyScale,
  enemyVariantFromTextureId,
  pickGeneratedEnemyTextureKey,
  placeholderSpawnerTint,
  PLACEHOLDER_SPAWNER_TINT,
  refineEnemyVisualKind,
  resolveRenderKind,
} from '../../src/engine/phaser-bridge/sprite-kind.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * Unit coverage for the pure render-kind helpers extracted from
 * {@link createPhaserBridge} (`src/engine/phaser-bridge/sprite-kind.ts`).
 *
 * These functions used to be private to the PhaserBridge module; pulling them
 * out lets us exercise every dispatch branch directly, with no Phaser scene.
 *
 * Determinism: worlds come from `createTestWorld()` (seed 42) and entity state
 * is built only via `addComponent`/`set`, which fires the same `onSet`
 * observers production uses to populate `world.stores` — so what these tests
 * read is exactly what `sync()` reads. No `Math.random`/`Date.now`.
 */

type TestWorld = ReturnType<typeof createTestWorld>;
type KindBuild = (world: TestWorld, eid: number) => void;

/**
 * Each render kind paired with the MINIMAL component(s) that should resolve to
 * it. For the two component checks that read store data, `set()` seeds the
 * value the branch keys on (`Sprite.textureId === 3` for the welcome sign).
 */
const DEFINING_COMPONENT: ReadonlyArray<readonly [string, KindBuild]> = [
  ['player', (w, e) => addComponent(w.ecs, e, Player)],
  ['npc', (w, e) => addComponent(w.ecs, e, Npc)],
  ['harvestable', (w, e) => addComponent(w.ecs, e, Harvestable)],
  ['enemy', (w, e) => addComponent(w.ecs, e, Enemy)],
  ['gem', (w, e) => addComponent(w.ecs, e, XpGem)],
  ['gold', (w, e) => addComponent(w.ecs, e, Gold)],
  ['beam', (w, e) => addComponent(w.ecs, e, LineDamage)],
  ['melee_swing', (w, e) => addComponent(w.ecs, e, MeleeSwing)],
  ['trap', (w, e) => addComponent(w.ecs, e, Trap)],
  ['aoe', (w, e) => addComponent(w.ecs, e, AreaDamage)],
  ['returning', (w, e) => addComponent(w.ecs, e, Returning)],
  ['aoe_proj', (w, e) => addComponent(w.ecs, e, AoeOnImpact)],
  ['enemy_proj', (w, e) => addComponent(w.ecs, e, EnemyProjectile)],
  ['proj', (w, e) => addComponent(w.ecs, e, Projectile)],
  [
    'welcome_sign',
    (w, e) => addComponent(w.ecs, e, set(Sprite, { textureId: 3, width: 0, height: 0 })),
  ],
  ['default', (w, e) => addComponent(w.ecs, e, set(Sprite, { textureId: 0, width: 0, height: 0 }))],
];

function makeEntity(world: TestWorld, build: KindBuild): number {
  const eid = addEntity(world.ecs);
  build(world, eid);
  return eid;
}

describe('resolveRenderKind — one branch per render kind', () => {
  it.each(DEFINING_COMPONENT)('resolves "%s" from its defining component(s)', (expected, build) => {
    const world = createTestWorld();
    const eid = makeEntity(world, build);
    expect(resolveRenderKind(world, eid)).toBe(expected);
  });

  it('resolves "default" for an entity with no render-relevant components', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    expect(resolveRenderKind(world, eid)).toBe('default');
  });
});

describe('resolveRenderKind — team-split area damage', () => {
  it('resolves "enemy_aoe" when AreaDamage carries the ENEMY team', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, AreaDamage);
    addComponent(world.ecs, eid, set(Team, { id: TeamId.ENEMY }));
    expect(resolveRenderKind(world, eid)).toBe('enemy_aoe');
  });

  it('stays "aoe" when AreaDamage carries the PLAYER team', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, AreaDamage);
    addComponent(world.ecs, eid, set(Team, { id: TeamId.PLAYER }));
    expect(resolveRenderKind(world, eid)).toBe('aoe');
  });

  it('stays "aoe" when AreaDamage has a non-enemy team (NEUTRAL)', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, AreaDamage);
    addComponent(world.ecs, eid, set(Team, { id: TeamId.NEUTRAL }));
    expect(resolveRenderKind(world, eid)).toBe('aoe');
  });
});

describe('resolveRenderKind — projectile-split AoE-on-impact', () => {
  it('resolves "enemy_aoe_proj" when AoeOnImpact is also an enemy projectile', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, AoeOnImpact);
    addComponent(world.ecs, eid, EnemyProjectile);
    expect(resolveRenderKind(world, eid)).toBe('enemy_aoe_proj');
  });

  it('stays "aoe_proj" when AoeOnImpact is not an enemy projectile', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, AoeOnImpact);
    expect(resolveRenderKind(world, eid)).toBe('aoe_proj');
  });
});

describe('resolveRenderKind — dispatch order is load-bearing', () => {
  it('prefers "player" over a co-present Enemy tag', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, Enemy);
    expect(resolveRenderKind(world, eid)).toBe('player');
  });

  it('prefers "enemy" over a co-present Projectile tag', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, Projectile);
    expect(resolveRenderKind(world, eid)).toBe('enemy');
  });

  it('prefers "aoe" (AreaDamage) over a co-present AoeOnImpact tag', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, AreaDamage);
    addComponent(world.ecs, eid, AoeOnImpact);
    expect(resolveRenderKind(world, eid)).toBe('aoe');
  });

  it('treats welcome_sign as the last resort (any real tag wins over textureId === 3)', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 3, width: 0, height: 0 }));
    expect(resolveRenderKind(world, eid)).toBe('enemy');
  });
});

describe('enemyVariantFromTextureId', () => {
  it.each([
    [1, 'enemy_rat'],
    [2, 'enemy_slime'],
    [4, 'enemy_baby_slime'],
    [0, 'enemy'],
    [3, 'enemy'],
    [99, 'enemy'],
  ])('maps textureId %i to "%s"', (textureId, expected) => {
    expect(enemyVariantFromTextureId(textureId)).toBe(expected);
  });

  it('falls back to "enemy" for an undefined textureId', () => {
    expect(enemyVariantFromTextureId(undefined)).toBe('enemy');
  });
});

describe('refineEnemyVisualKind — spawner art dispatch', () => {
  it('returns "enemy_spawner_rats_nest" for a Spawner entity with rat texture', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 1, width: 0, height: 0 })); // enemy_rat
    addComponent(world.ecs, eid, Spawner);
    expect(refineEnemyVisualKind(world, eid)).toBe('enemy_spawner_rats_nest');
  });

  it('returns "enemy_spawner_slime_pool" for a Spawner entity with slime texture', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 0, height: 0 })); // enemy_slime
    addComponent(world.ecs, eid, Spawner);
    expect(refineEnemyVisualKind(world, eid)).toBe('enemy_spawner_slime_pool');
  });

  it('falls back to the mob variant for a Spawner with an unrecognised texture', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 99, width: 0, height: 0 }));
    addComponent(world.ecs, eid, Spawner);
    // textureId 99 has no registered variant → "enemy" fallback
    expect(refineEnemyVisualKind(world, eid)).toBe('enemy');
  });

  it('returns the plain mob variant for a non-Spawner rat enemy', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 1, width: 0, height: 0 })); // enemy_rat
    // No Spawner component → plain mob, not a nest
    expect(refineEnemyVisualKind(world, eid)).toBe('enemy_rat');
  });

  it('returns the plain mob variant for a non-Spawner slime enemy', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 0, height: 0 })); // enemy_slime
    expect(refineEnemyVisualKind(world, eid)).toBe('enemy_slime');
  });
});

describe('pickGeneratedEnemyTextureKey', () => {
  const registry = buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      'slime-v1-var-2': {
        briefId: 'slime-v1',
        spriteName: 'slime-v1-var-2',
        assetPath: 'generated/slime-v1-var-2.png',
        approvedAt: '2026-06-30T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 2,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'slime-v1-var-9': {
        briefId: 'slime-v1',
        spriteName: 'slime-v1-var-9',
        assetPath: 'generated/slime-v1-var-9.png',
        approvedAt: '2026-06-30T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 9,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'baby-slime-v1-var-1': {
        briefId: 'baby-slime-v1',
        spriteName: 'baby-slime-v1-var-1',
        assetPath: 'generated/baby-slime-v1-var-1.png',
        approvedAt: '2026-06-30T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 1,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'baby-slime-v1-var-8': {
        briefId: 'baby-slime-v1',
        spriteName: 'baby-slime-v1-var-8',
        assetPath: 'generated/baby-slime-v1-var-8.png',
        approvedAt: '2026-06-30T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 8,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'rat-nest-v2-var-0': {
        briefId: 'rat-nest-v2',
        spriteName: 'rat-nest-v2-var-0',
        assetPath: 'generated/rat-nest-v2-var-0.png',
        approvedAt: '2026-07-06T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 0,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'rat-nest-v2-var-3': {
        briefId: 'rat-nest-v2',
        spriteName: 'rat-nest-v2-var-3',
        assetPath: 'generated/rat-nest-v2-var-3.png',
        approvedAt: '2026-07-06T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 3,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'slime-pool-v1-var-0': {
        briefId: 'slime-pool-v1',
        spriteName: 'slime-pool-v1-var-0',
        assetPath: 'generated/slime-pool-v1-var-0.png',
        approvedAt: '2026-07-06T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 0,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'slime-pool-v1-var-3': {
        briefId: 'slime-pool-v1',
        spriteName: 'slime-pool-v1-var-3',
        assetPath: 'generated/slime-pool-v1-var-3.png',
        approvedAt: '2026-07-06T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 3,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
    },
  });

  it('uses the stored roll to pick among multiple variants for a broad enemy family', () => {
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_slime', 0.1)).toBe('slime-v1-var-2');
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_slime', 0.95)).toBe('slime-v1-var-9');
  });

  it('lets a specific appearance key override the broad enemy family', () => {
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_slime', 0.1, 'slime-mini')).toBe(
      'baby-slime-v1-var-1',
    );
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_slime', 0.95, 'slime-mini')).toBe(
      'baby-slime-v1-var-8',
    );
  });

  it('returns null when the registry or mapping is missing', () => {
    expect(pickGeneratedEnemyTextureKey(null, 'enemy_slime', 0.2)).toBeNull();
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_boss', 0.2, 'slime-rat')).toBeNull();
  });

  it('supports dedicated spawner generated families', () => {
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_spawner_rats_nest', 0.1)).toBe(
      'rat-nest-v2-var-0',
    );
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_spawner_rats_nest', 0.95)).toBe(
      'rat-nest-v2-var-3',
    );
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_spawner_slime_pool', 0.1)).toBe(
      'slime-pool-v1-var-0',
    );
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_spawner_slime_pool', 0.95)).toBe(
      'slime-pool-v1-var-3',
    );
  });
});

/** Minimal floor-1 sidecar shape the scale helper reads from (archetype map). */
function withFloorArchetype(world: TestWorld, eid: number, archetype: string): void {
  world.floorScenario = {
    enemyArchetypes: new Map<number, string>(),
    objective: { bossBattles: new Map() },
  } as unknown as NonNullable<typeof world.floorScenario>;
  world.floorScenario.enemyArchetypes.set(eid, archetype);
}

describe('computeEnemyScale — baseline', () => {
  it('returns the base scale on both axes when no archetype or spawn animation applies', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 3, height: 3 }));

    expect(computeEnemyScale(world, eid, 2)).toEqual({ scaleX: 2, scaleY: 2 });
  });

  it('ignores a shrunken width for enemies that are NOT slime-mini', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    // Tiny width but no 'slime-mini' archetype → full base scale, uniformly.
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 0.5, height: 0.5 }));

    expect(computeEnemyScale(world, eid, 2)).toEqual({ scaleX: 2, scaleY: 2 });
  });

  it('multiplies the base scale by the stored spawn-time size scale', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(
      world.ecs,
      eid,
      set(Sprite, { textureId: 2, width: 3, height: 3, sizeScale: 1.08, variantRoll: 0.5 }),
    );

    const { scaleX, scaleY } = computeEnemyScale(world, eid, 2);
    expect(scaleX).toBeCloseTo(2 * 1.08, 5);
    expect(scaleY).toBeCloseTo(2 * 1.08, 5);
  });
});

describe('computeEnemyScale — slime-mini size class', () => {
  it('shrinks a baby slime to width / SLIME_FULL_SPRITE_WIDTH of the base scale', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    // 1.95 ft / 3.0 ft = 0.65 → renders at 0.65 of a full slime, still uniform.
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 1.95, height: 1.95 }));
    withFloorArchetype(world, eid, 'slime-mini');

    const { scaleX, scaleY } = computeEnemyScale(world, eid, 2);
    expect(scaleX).toBeCloseTo(2 * 0.65, 6);
    expect(scaleY).toBeCloseTo(2 * 0.65, 6);
  });

  it('clamps a baby slime smaller than the 0.2 floor up to 0.2', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    // 0.3 ft / 3.0 ft = 0.1 → clamped up to the 0.2 minimum.
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 0.3, height: 0.3 }));
    withFloorArchetype(world, eid, 'slime-mini');

    const { scaleX, scaleY } = computeEnemyScale(world, eid, 2);
    expect(scaleX).toBeCloseTo(2 * 0.2, 6);
    expect(scaleY).toBeCloseTo(2 * 0.2, 6);
  });

  it('clamps an oversized baby slime down to the full 1.0 scale', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    // 9 ft / 3 ft = 3 → clamped down to 1.0 → no shrink.
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 9, height: 9 }));
    withFloorArchetype(world, eid, 'slime-mini');

    expect(computeEnemyScale(world, eid, 2)).toEqual({ scaleX: 2, scaleY: 2 });
  });
});

describe('computeEnemyScale — spawn-in pop animation', () => {
  it('multiplies the base scale by the per-axis spawn pop while SpawnAnim runs', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    // Mid-animation (half elapsed) so the pop/wiggle is non-identity on both axes.
    addComponent(world.ecs, eid, set(SpawnAnim, { remainingMs: 50, totalMs: 100 }));

    const pop = computeSpawnPopScale(spawnAnimProgress(50, 100));
    const { scaleX, scaleY } = computeEnemyScale(world, eid, 2);

    expect(scaleX).toBeCloseTo(2 * pop.x, 6);
    expect(scaleY).toBeCloseTo(2 * pop.y, 6);
    // Guard: the SpawnAnim branch actually altered the base scale.
    expect([scaleX, scaleY]).not.toEqual([2, 2]);
  });

  it('composes the spawn pop on top of the slime-mini shrink (both multipliers apply)', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 2, width: 1.95, height: 1.95 }));
    addComponent(world.ecs, eid, set(SpawnAnim, { remainingMs: 50, totalMs: 100 }));
    withFloorArchetype(world, eid, 'slime-mini');

    const pop = computeSpawnPopScale(spawnAnimProgress(50, 100));
    const { scaleX, scaleY } = computeEnemyScale(world, eid, 2);

    expect(scaleX).toBeCloseTo(2 * 0.65 * pop.x, 6);
    expect(scaleY).toBeCloseTo(2 * 0.65 * pop.y, 6);
  });
});

describe('placeholderSpawnerTint — bright-red wash for art-less spawner structures', () => {
  it('returns the placeholder tint for an entity tagged Spawner', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, Spawner);
    expect(placeholderSpawnerTint(world.ecs, eid)).toBe(PLACEHOLDER_SPAWNER_TINT);
  });

  it('returns null for a plain enemy (no Spawner) so real mobs keep their sprite colour', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, Enemy);
    expect(placeholderSpawnerTint(world.ecs, eid)).toBeNull();
  });

  it('returns null for an entity with no render-relevant components', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);
    expect(placeholderSpawnerTint(world.ecs, eid)).toBeNull();
  });

  it('exposes a genuinely bright red constant (dominant red, non-zero green/blue for luminance)', () => {
    const r = (PLACEHOLDER_SPAWNER_TINT >> 16) & 0xff;
    const g = (PLACEHOLDER_SPAWNER_TINT >> 8) & 0xff;
    const b = PLACEHOLDER_SPAWNER_TINT & 0xff;
    // A multiply-tint of pure 0xff0000 crushes dark sprites to near-black; keep
    // some green/blue so the wash reads as *bright* red rather than muddy.
    expect(r).toBe(0xff);
    expect(g).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(g).toBeLessThan(r);
    expect(b).toBeLessThan(r);
  });
});
