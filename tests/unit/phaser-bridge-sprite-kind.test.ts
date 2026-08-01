import { addComponent, addEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  AoeOnImpact,
  AreaDamage,
  BossChestEntity,
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
  enemyAppearanceTint,
  enemyVariantFromTextureId,
  GENERATED_KEY_BY_NPC_DEF,
  generatedBriefIdForEnemy,
  generatedBriefIdForHarvestable,
  pickGeneratedEnemyTextureKey,
  pickGeneratedNpcTextureKey,
  pickGeneratedHarvestableTextureKey,
  placeholderSpawnerTint,
  PLACEHOLDER_SPAWNER_TINT,
  RAT_BRUTE_TINT,
  refineEnemyVisualKind,
  resolveRenderKind,
} from '../../src/engine/phaser-bridge/sprite-kind.js';
import { getNpcDef } from '../../src/shared/npc-types.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { HARVESTABLE_DEFS } from '../../src/shared/harvestableDefs.js';

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
  ['boss_chest', (w, e) => addComponent(w.ecs, e, BossChestEntity)],
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
    [5, 'enemy_family_boss'],
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
      'rat-king-v1-var-7': {
        briefId: 'rat-king-v1',
        spriteName: 'rat-king-v1-var-7',
        assetPath: 'generated/rat-king-v1-var-7.png',
        approvedAt: '2026-07-02T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 7,
        anchor: null,
        sensorScore: '7/8',
        judgeScore: '2',
      },
      'rat-queen-v1-var-7': {
        briefId: 'rat-queen-v1',
        spriteName: 'rat-queen-v1-var-7',
        assetPath: 'generated/rat-queen-v1-var-7.png',
        approvedAt: '2026-07-02T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 7,
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

  it('resolves rat monarch and slime-pool appearance keys to their generated briefs', () => {
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_rat', 0.5, 'rat-king')).toBe(
      'rat-king-v1-var-7',
    );
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_rat', 0.5, 'rat-queen')).toBe(
      'rat-queen-v1-var-7',
    );
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_slime', 0.5, 'slime-pool')).toBe(
      'slime-pool-v1-var-3',
    );
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

describe('generatedBriefIdForEnemy', () => {
  it('maps rat monarch and spawner appearance keys to explicit briefs', () => {
    expect(generatedBriefIdForEnemy('enemy_rat', 'rat-king')).toBe('rat-king-v1');
    expect(generatedBriefIdForEnemy('enemy_rat', 'rat-queen')).toBe('rat-queen-v1');
    expect(generatedBriefIdForEnemy('enemy_slime', 'slime-pool')).toBe('slime-pool-v1');
    expect(generatedBriefIdForEnemy('enemy_rat', 'rats-nest')).toBe('rats-nest-v1');
    expect(generatedBriefIdForEnemy('enemy_spawner_rats_nest')).toBe('rat-nest-v2');
    expect(generatedBriefIdForEnemy('enemy_spawner_slime_pool')).toBe('slime-pool-v1');
  });

  it('resolves Floor-2 family bosses and grunts by identity appearance key', () => {
    // Bosses render via textureId 5 → enemy_family_boss; grunts/ambient render
    // via textureId 1 → enemy_rat. Both resolve by the archetype-id appearance
    // key first, so the numeric type is irrelevant when the key is present.
    expect(generatedBriefIdForEnemy('enemy_family_boss', 'goblin-boss')).toBe('goblin-boss');
    expect(generatedBriefIdForEnemy('enemy_family_boss', 'batfolk-boss')).toBe('batfolk-boss');
    expect(generatedBriefIdForEnemy('enemy_rat', 'goblin-grunt')).toBe('goblin-grunt');
    expect(generatedBriefIdForEnemy('enemy_rat', 'geese-honker')).toBe('geese-honker');
    expect(generatedBriefIdForEnemy('enemy_slime', 'cave-slime')).toBe('cave-slime');
    expect(generatedBriefIdForEnemy('enemy_rat', 'crystal-scuttler')).toBe('crystal-scuttler');
  });

  it('prefers a dedicated bare-id brief in the live registry before a legacy alias fallback', () => {
    const registry = buildGeneratedSpriteRegistry({
      version: 1,
      entries: {
        'faerie-blink-var-0': {
          briefId: 'faerie-blink',
          spriteName: 'faerie-blink-var-0',
          assetPath: 'generated/faerie-blink-var-0.png',
          approvedAt: '2026-08-01T00:00:00.000Z',
          sourceRun: 'test',
          variantIndex: 0,
          anchor: null,
          sensorScore: '7/7',
          judgeScore: '4',
        },
        'faerie-spark-caster-var-0': {
          briefId: 'faerie-spark-caster',
          spriteName: 'faerie-spark-caster-var-0',
          assetPath: 'generated/faerie-spark-caster-var-0.png',
          approvedAt: '2026-08-01T00:00:00.000Z',
          sourceRun: 'test',
          variantIndex: 0,
          anchor: null,
          sensorScore: '7/7',
          judgeScore: '4',
        },
      },
    });

    expect(generatedBriefIdForEnemy('enemy_rat', 'faerie-spark-caster')).toBe('faerie-blink');
    expect(generatedBriefIdForEnemy('enemy_rat', 'faerie-spark-caster', registry)).toBe(
      'faerie-spark-caster',
    );
    expect(pickGeneratedEnemyTextureKey(registry, 'enemy_rat', 0.5, 'faerie-spark-caster')).toBe(
      'faerie-spark-caster-var-0',
    );
  });

  it('prefers the newest dedicated versioned brief in the live registry before a legacy alias fallback', () => {
    const registry = buildGeneratedSpriteRegistry({
      version: 1,
      entries: {
        'raccoon-thief-var-0': {
          briefId: 'raccoon-thief',
          spriteName: 'raccoon-thief-var-0',
          assetPath: 'generated/raccoon-thief-var-0.png',
          approvedAt: '2026-08-01T00:00:00.000Z',
          sourceRun: 'test',
          variantIndex: 0,
          anchor: null,
          sensorScore: '7/7',
          judgeScore: '4',
        },
        'raccoon-bottle-rocketeer-v1-var-0': {
          briefId: 'raccoon-bottle-rocketeer-v1',
          spriteName: 'raccoon-bottle-rocketeer-v1-var-0',
          assetPath: 'generated/raccoon-bottle-rocketeer-v1-var-0.png',
          approvedAt: '2026-08-01T00:00:00.000Z',
          sourceRun: 'test',
          variantIndex: 0,
          anchor: null,
          sensorScore: '7/7',
          judgeScore: '4',
        },
        'raccoon-bottle-rocketeer-v2-var-0': {
          briefId: 'raccoon-bottle-rocketeer-v2',
          spriteName: 'raccoon-bottle-rocketeer-v2-var-0',
          assetPath: 'generated/raccoon-bottle-rocketeer-v2-var-0.png',
          approvedAt: '2026-08-01T00:00:00.000Z',
          sourceRun: 'test',
          variantIndex: 0,
          anchor: null,
          sensorScore: '7/7',
          judgeScore: '4',
        },
      },
    });

    expect(generatedBriefIdForEnemy('enemy_rat', 'raccoon-bottle-rocketeer')).toBe('raccoon-thief');
    expect(generatedBriefIdForEnemy('enemy_rat', 'raccoon-bottle-rocketeer', registry)).toBe(
      'raccoon-bottle-rocketeer-v2',
    );
    expect(
      pickGeneratedEnemyTextureKey(registry, 'enemy_rat', 0.5, 'raccoon-bottle-rocketeer'),
    ).toBe('raccoon-bottle-rocketeer-v2-var-0');
  });

  it('reconciles the two singular→plural boss id mismatches', () => {
    // Briefs shipped plural but the archetype ids are singular — the appearance
    // map remaps them so the keys resolve to the real shipped art.
    expect(generatedBriefIdForEnemy('enemy_family_boss', 'raccoon-boss')).toBe('raccoons-boss');
    expect(generatedBriefIdForEnemy('enemy_family_boss', 'imp-boss')).toBe('imps-boss');
  });

  it('falls back to the goblin-boss type default when a boss has no appearance key', () => {
    // Type-level safety net: a family boss with a missing/unknown appearance key
    // still resolves to a real boss brief rather than the rat default.
    expect(generatedBriefIdForEnemy('enemy_family_boss')).toBe('goblin-boss');
    expect(generatedBriefIdForEnemy('enemy_family_boss', 'unknown-key')).toBe('goblin-boss');
  });
});

describe('pickGeneratedNpcTextureKey — def-aware welcome-room NPC art', () => {
  it('pins each welcome-room NPC to its distinct generated texture key', () => {
    // Three DISTINCT keys — the whole point of the feature (no shared villager).
    expect(pickGeneratedNpcTextureKey('tutorial-goon')).toBe('welcome-goon-v3-var-1');
    expect(pickGeneratedNpcTextureKey('shopkeeper')).toBe('sweaty-merchant-v3-var-3');
    expect(pickGeneratedNpcTextureKey('spell-quest-giver')).toBe('npc-spell-broker-var-1');
    const keys = [
      pickGeneratedNpcTextureKey('tutorial-goon'),
      pickGeneratedNpcTextureKey('shopkeeper'),
      pickGeneratedNpcTextureKey('spell-quest-giver'),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('pins per def id because approved variant indices differ (a roll would mis-pick)', () => {
    // Hard requirement: the approved variants are NOT a shared index — Goon
    // var-1, Merchant var-3, Broker var-1 — so keys are pinned per def id
    // rather than computed from a variant roll. Assert the indices genuinely
    // differ, which is the actual reason a roll cannot work; pinning only the
    // broker would still pass if every NPC drifted to a single shared index.
    const variantIndexOf = (key: string | null) => Number(key?.match(/-var-(\d+)$/)?.[1] ?? NaN);
    const indices = (['tutorial-goon', 'shopkeeper', 'spell-quest-giver'] as const).map((id) =>
      variantIndexOf(pickGeneratedNpcTextureKey(id)),
    );
    expect(indices.every((n) => Number.isInteger(n))).toBe(true);
    expect(new Set(indices).size).toBeGreaterThan(1);
    expect(pickGeneratedNpcTextureKey('spell-quest-giver')).toBe('npc-spell-broker-var-1');
    expect(pickGeneratedNpcTextureKey('spell-quest-giver')).not.toBe('npc-spell-broker-var-0');
  });

  it('returns null for unknown or undefined def ids (bridge falls back to villager)', () => {
    expect(pickGeneratedNpcTextureKey('the-broker')).toBeNull();
    expect(pickGeneratedNpcTextureKey('not-a-real-npc')).toBeNull();
    expect(pickGeneratedNpcTextureKey(undefined)).toBeNull();
  });

  it('keys the map only on real NPC def ids (guards against def-id drift)', () => {
    for (const defId of Object.keys(GENERATED_KEY_BY_NPC_DEF)) {
      expect(getNpcDef(defId), `${defId} must be a real NpcDef id`).toBeDefined();
    }
    expect(Object.keys(GENERATED_KEY_BY_NPC_DEF).sort()).toEqual([
      'shopkeeper',
      'spell-quest-giver',
      'tutorial-goon',
    ]);
  });
});

describe('generatedBriefIdForHarvestable', () => {
  it('maps every Floor-1 harvestable def id to its versioned brief', () => {
    expect(generatedBriefIdForHarvestable('crimson-mushroom')).toBe('crimson-mushroom-v1');
    expect(generatedBriefIdForHarvestable('azure-mushroom')).toBe('azure-mushroom-v1');
    expect(generatedBriefIdForHarvestable('sunpetal-flower')).toBe('sunpetal-flower-v1');
    expect(generatedBriefIdForHarvestable('moonbloom-flower')).toBe('moonbloom-flower-v1');
    expect(generatedBriefIdForHarvestable('frost-lichen')).toBe('frost-lichen-v1');
    expect(generatedBriefIdForHarvestable('shadow-lichen')).toBe('shadow-lichen-v1');
  });

  it('resolves a briefId for EVERY registered harvestable def (no node left on a circle)', () => {
    // Success-gate guard: a newly-added node type that ships without a brief
    // fails here instead of silently falling back to the procedural circle.
    for (const def of HARVESTABLE_DEFS) {
      const briefId = generatedBriefIdForHarvestable(def.id);
      expect(briefId, `harvestable "${def.id}" has no wired briefId`).toBeDefined();
      expect(briefId).toBe(`${def.id}-v1`);
    }
  });

  it('returns undefined for an unknown node id (renderer falls back to the circle)', () => {
    expect(generatedBriefIdForHarvestable('not-a-node')).toBeUndefined();
    expect(generatedBriefIdForHarvestable('')).toBeUndefined();
  });
});

describe('pickGeneratedHarvestableTextureKey', () => {
  const registry = buildGeneratedSpriteRegistry({
    version: 1,
    entries: {
      'crimson-mushroom-v1-var-0': {
        briefId: 'crimson-mushroom-v1',
        spriteName: 'crimson-mushroom-v1-var-0',
        assetPath: 'generated/crimson-mushroom-v1-var-0.png',
        approvedAt: '2026-07-08T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 0,
        anchor: null,
        sensorScore: '7/7',
        judgeScore: '4',
      },
      'crimson-mushroom-v1-var-3': {
        briefId: 'crimson-mushroom-v1',
        spriteName: 'crimson-mushroom-v1-var-3',
        assetPath: 'generated/crimson-mushroom-v1-var-3.png',
        approvedAt: '2026-07-08T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 3,
        anchor: null,
        sensorScore: '7/7',
        judgeScore: '4',
      },
      'frost-lichen-v1-var-12': {
        briefId: 'frost-lichen-v1',
        spriteName: 'frost-lichen-v1-var-12',
        assetPath: 'generated/frost-lichen-v1-var-12.png',
        approvedAt: '2026-07-08T00:00:00.000Z',
        sourceRun: 'test',
        variantIndex: 12,
        anchor: null,
        sensorScore: '7/7',
        judgeScore: '4',
      },
    },
  });

  it('resolves a node def id to the texture key of its single wired variant', () => {
    expect(pickGeneratedHarvestableTextureKey(registry, 'frost-lichen', 0)).toBe(
      'frost-lichen-v1-var-12',
    );
  });

  it('uses the stored roll deterministically across multiple variants', () => {
    expect(pickGeneratedHarvestableTextureKey(registry, 'crimson-mushroom', 0.1)).toBe(
      'crimson-mushroom-v1-var-0',
    );
    expect(pickGeneratedHarvestableTextureKey(registry, 'crimson-mushroom', 0.95)).toBe(
      'crimson-mushroom-v1-var-3',
    );
  });

  it('returns null when the registry, def id, or approved art is missing', () => {
    expect(pickGeneratedHarvestableTextureKey(null, 'frost-lichen', 0)).toBeNull();
    expect(pickGeneratedHarvestableTextureKey(undefined, 'frost-lichen', 0)).toBeNull();
    expect(pickGeneratedHarvestableTextureKey(registry, undefined, 0)).toBeNull();
    expect(pickGeneratedHarvestableTextureKey(registry, 'not-a-node', 0)).toBeNull();
    // Wired brief but no variant in this registry → null (renderer draws the circle).
    expect(pickGeneratedHarvestableTextureKey(registry, 'shadow-lichen', 0)).toBeNull();
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

  describe('enemyAppearanceTint', () => {
    it('tints rat-brute darker grey when it is a normal enemy', () => {
      const world = createTestWorld();
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, Enemy);
      expect(enemyAppearanceTint(world.ecs, eid, 'rat-brute')).toBe(RAT_BRUTE_TINT);
    });

    it('keeps spawner red as top priority even if appearance key is rat-brute', () => {
      const world = createTestWorld();
      const eid = addEntity(world.ecs);
      addComponent(world.ecs, eid, Spawner);
      expect(enemyAppearanceTint(world.ecs, eid, 'rat-brute')).toBe(PLACEHOLDER_SPAWNER_TINT);
    });
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
