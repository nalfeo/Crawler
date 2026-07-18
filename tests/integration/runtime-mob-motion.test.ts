import { addComponent, hasComponent, removeEntity, set, setComponent } from 'bitecs';
import { expect, it } from 'vitest';
import {
  Damage,
  DeathTimer,
  Enemy,
  EnemyBehavior,
  Health,
  Position,
  Size,
  Spawner,
  Sprite,
  Velocity,
  Weight,
} from '../../src/core/components.js';
import { setEnemyAppearanceKey, spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { WORLD_VFX_DEPTH } from '../../src/shared/render-depths.js';
import { floor1EnemyPack, floor2EnemyPack } from '../../src/shared/enemy-packs.js';
import {
  CONTACT_ATTACK_MOTION_MS,
  HIT_REACTION_MOTION_MS,
  RUNTIME_MOB_MOTION_PROFILES,
  RANGED_RELEASE_MOTION_MS,
  sampleContactAttackMotion,
  sampleHitReactionMotion,
  sampleMovementMotion,
  sampleRangedReleaseMotion,
  sampleRangedWindupMotion,
} from '../../src/shared/mob-motion.js';
import { MINI_SLIME_SPAWN_ANIM_MS } from '../../src/shared/spawn-anim.js';
import { ftToPx } from '../../src/shared/units.js';
import {
  createSceneStub,
  PHASER_TINT_MODE_FILL,
  type MockImage,
} from '../fixtures/phaser-bridge-harness.js';
import { createTestWorld } from '../helpers/world-factory.js';

const SPECIAL_FLOOR_1_MOBS = ['slime-mini', 'slime-rat', 'rat-slime'] as const;
const SPAWNER_FLOOR_1_MOBS = [
  'rat-brute',
  'rat-king',
  'rat-queen',
  'mama-slime',
  'papa-slime',
] as const;
const COMPONENTS = [
  Position,
  Velocity,
  Health,
  Damage,
  Enemy,
  EnemyBehavior,
  Sprite,
  Size,
  Weight,
  DeathTimer,
] as const;

function gameplaySnapshot(world: ReturnType<typeof createTestWorld>, eids: readonly number[]) {
  const { stores } = world;
  return {
    frameCount: world.frameCount,
    elapsedMs: world.elapsedMs,
    state: world.state,
    rngState: (world.rng as unknown as { state: number }).state,
    entities: eids.map((eid) => ({
      eid,
      components: COMPONENTS.map((component) => hasComponent(world.ecs, eid, component)),
      position: [stores.position.x[eid], stores.position.y[eid]],
      velocity: [stores.velocity.x[eid], stores.velocity.y[eid]],
      health: [stores.health.current[eid], stores.health.max[eid]],
      damage: stores.damage.amount[eid],
      sprite: [
        stores.sprite.textureId[eid],
        stores.sprite.variantRoll[eid],
        stores.sprite.sizeScale[eid],
      ],
      size: [
        stores.size.radius[eid],
        stores.size.halfWidth[eid],
        stores.size.halfHeight[eid],
        stores.size.shape[eid],
      ],
      weight: stores.weight.value[eid],
      behavior: Object.fromEntries(
        Object.entries(stores.enemyBehavior).map(([key, values]) => [
          key,
          key === 'telegraphWasActiveThisFrame' ? '<render-cue>' : values[eid],
        ]),
      ),
      statusEffects: world.statusEffectsByEntity
        .get(eid)
        ?.map((effect) => ({ ...effect, stackRule: { ...effect.stackRule } })),
      appearanceKey: world.enemyAppearanceKeys.get(eid),
      scenarioArchetype: world.floorScenario?.enemyArchetypes.get(eid),
      ambientArchetype: world.floorExtendedState?.ambientEnemyArchetypes?.get(eid),
      generation: world.entityRenderGeneration[eid],
    })),
  };
}

it('renders every eligible Floor 1-2 mob state through the real PhaserBridge with zero gameplay deltas', () => {
  const expectedIds = [
    ...floor1EnemyPack.archetypes.map((archetype) => archetype.id),
    ...SPECIAL_FLOOR_1_MOBS,
    ...SPAWNER_FLOOR_1_MOBS,
    ...floor2EnemyPack.archetypes.map((archetype) => archetype.id),
  ].sort();
  const actualIds = RUNTIME_MOB_MOTION_PROFILES.map((profile) => profile.archetypeId).sort();
  expect(actualIds).toEqual(expectedIds);
  expect(new Set(actualIds).size).toBe(actualIds.length);
  expect(actualIds).not.toContain('rat-nest-v2');
  expect(actualIds).not.toContain('slime-pool-v1');

  const world = createTestWorld({ seed: 42, floor: 1 });
  const spawned = RUNTIME_MOB_MOTION_PROFILES.map((profile, index) => {
    const x = 10 + index * 4;
    const eid = spawnBehaviorEnemy(world, x, 20, 100, 0, 1, 30, 8);
    setComponent(world.ecs, eid, Sprite, {
      textureId: profile.spriteTexture,
      width: 3,
      height: 3,
    });
    addComponent(world.ecs, eid, set(Damage, { amount: 7 }));
    setEnemyAppearanceKey(world, eid, profile.archetypeId);
    return { eid, x, profile };
  });

  // A structure deliberately masquerading as a known mobile archetype proves
  // component-based exclusion wins over appearance-key lookup.
  const spawnerEid = spawnBehaviorEnemy(world, 999, 20, 100, 0, 1, 30, 8);
  addComponent(world.ecs, spawnerEid, Spawner);
  setEnemyAppearanceKey(world, spawnerEid, 'rat');
  world.stores.velocity.x[spawnerEid] = 1;

  const allEids = [...spawned.map(({ eid }) => eid), spawnerEid];
  const rat = spawned.find(({ profile }) => profile.archetypeId === 'rat')!;
  setEnemyAppearanceKey(world, rat.eid, 'rat-brute');
  world.floorScenario = {
    enemyArchetypes: new Map([[rat.eid, 'rat']]),
    objective: { bossBattles: new Map() },
  } as typeof world.floorScenario;

  const { scene, images } = createSceneStub({ kenneyLoaded: true });
  const bridge = createPhaserBridge(scene);
  const coverage = new Map(actualIds.map((id) => [id, new Set<string>()]));
  const baseImageCount = allEids.length;

  const syncWithoutGameplayDelta = (state: string, renderMs: number) => {
    const before = gameplaySnapshot(world, allEids);
    bridge.sync(world, renderMs);
    expect(gameplaySnapshot(world, allEids), `${state} mutated gameplay state`).toEqual(before);
  };
  const signedMotionOffsetX = (img: MockImage, offsetFt: number) =>
    (img.flipX ? -1 : 1) * ftToPx(offsetFt);

  syncWithoutGameplayDelta('spawn', 0);
  expect(images).toHaveLength(spawned.length + 1);
  const imageByEid = new Map<number, MockImage>(
    allEids.map((eid, index) => [eid, images[index] as MockImage]),
  );
  for (const { eid, profile } of spawned) {
    const img = imageByEid.get(eid)!;
    expect(img.scaleX, `${profile.archetypeId}:spawn scaleX`).toBe(0);
    expect(img.scaleY, `${profile.archetypeId}:spawn scaleY`).toBe(0);
    coverage.get(profile.archetypeId)!.add('spawn');
  }
  expect(
    imageByEid.get(spawnerEid)!.scaleX,
    'spawner must not receive spawn motion',
  ).toBeGreaterThan(0);

  for (const { eid } of spawned) {
    world.combatEvents.push({
      type: 'hit',
      x: 0,
      y: 0,
      amount: 5,
      targetType: 'player',
      timestamp: 100,
      sourceEid: eid,
      delivery: 'contact',
    });
  }
  syncWithoutGameplayDelta('contact immediately after spawn', MINI_SLIME_SPAWN_ANIM_MS);
  const expectedEarlyContact = sampleContactAttackMotion(MINI_SLIME_SPAWN_ANIM_MS - 100);
  expect(MINI_SLIME_SPAWN_ANIM_MS - 100).toBeLessThan(CONTACT_ATTACK_MOTION_MS);
  for (const { eid, x, profile } of spawned) {
    const img = imageByEid.get(eid)!;
    expect(img.x, `${profile.archetypeId}:early contact`).toBeCloseTo(
      ftToPx(x) + signedMotionOffsetX(img, expectedEarlyContact.offsetX),
    );
    coverage.get(profile.archetypeId)!.add('contact');
  }

  for (const { eid } of spawned) {
    world.stores.velocity.x[eid] = 1;
  }
  syncWithoutGameplayDelta('movement', 700);
  for (const { eid, x, profile } of spawned) {
    const expected = sampleMovementMotion(700, profile.movementStyle);
    const img = imageByEid.get(eid)!;
    expect(img.x, `${profile.archetypeId}:movement x`).toBeCloseTo(
      ftToPx(x) + signedMotionOffsetX(img, expected.offsetX),
    );
    expect(img.y, `${profile.archetypeId}:movement y`).toBeCloseTo(
      ftToPx(20) + ftToPx(expected.offsetY),
    );
    expect(img.rotation, `${profile.archetypeId}:movement rotation`).toBeCloseTo(expected.rotation);
    coverage.get(profile.archetypeId)!.add('movement');
  }
  expect(imageByEid.get(spawnerEid)!.x, 'spawner must not receive locomotion').toBe(ftToPx(999));

  for (const { eid } of spawned) {
    world.stores.velocity.x[eid] = 0;
  }
  const ranged = spawned.filter(({ profile }) => profile.hasProjectile);
  for (const { eid } of ranged) {
    world.stores.enemyBehavior.telegraphActive[eid] = 1;
    world.stores.enemyBehavior.telegraphStartMs[eid] = 700;
    world.stores.enemyBehavior.telegraphDelayMs[eid] = 400;
  }
  syncWithoutGameplayDelta('ranged windup', 900);
  const expectedWindup = sampleRangedWindupMotion(0.5);
  for (const { eid, x, profile } of ranged) {
    const img = imageByEid.get(eid)!;
    expect(img.x, `${profile.archetypeId}:ranged windup`).toBeCloseTo(
      ftToPx(x) + signedMotionOffsetX(img, expectedWindup.offsetX),
    );
    coverage.get(profile.archetypeId)!.add('ranged-windup');
  }

  for (const { eid } of ranged) {
    world.stores.enemyBehavior.telegraphActive[eid] = 0;
    world.stores.enemyBehavior.lastFireMs[eid] = 950;
  }
  syncWithoutGameplayDelta('ranged release', 950);
  const expectedRelease = sampleRangedReleaseMotion(0);
  expect(sampleRangedReleaseMotion(RANGED_RELEASE_MOTION_MS).flash).toBe(0);
  for (const { eid, x, profile } of ranged) {
    const baseImage = imageByEid.get(eid)!;
    expect(baseImage.x, `${profile.archetypeId}:ranged release`).toBeCloseTo(
      ftToPx(x) + signedMotionOffsetX(baseImage, expectedRelease.offsetX),
    );
    const flashOverlay = images.find(
      (image, index) =>
        index >= baseImageCount &&
        image.visible &&
        image.tintMode === PHASER_TINT_MODE_FILL &&
        Math.abs(image.x - baseImage.x) < 0.001,
    );
    expect(flashOverlay, `${profile.archetypeId}:ranged release flash`).toBeDefined();
    expect(flashOverlay!.alpha).toBeCloseTo(expectedRelease.flash);
    coverage.get(profile.archetypeId)!.add('ranged-release');
  }

  for (const { eid } of ranged) {
    world.combatEvents.push({
      type: 'hit',
      x: 0,
      y: 0,
      amount: 5,
      targetType: 'player',
      timestamp: 1_100,
      sourceEid: eid,
      delivery: 'projectile',
    });
  }
  syncWithoutGameplayDelta('projectile non-contact', 1_100);
  for (const { eid, x, profile } of ranged) {
    expect(imageByEid.get(eid)!.x, `${profile.archetypeId}:projectile non-contact`).toBe(ftToPx(x));
    coverage.get(profile.archetypeId)!.add('projectile-no-contact');
  }

  for (const { eid, x } of spawned) {
    world.combatEvents.push({
      type: 'hit',
      x,
      y: 20,
      amount: 5,
      targetType: 'enemy',
      targetEid: eid,
      timestamp: 1_500,
    });
  }
  syncWithoutGameplayDelta('enemy hit reaction', 1_500);
  const expectedHit = sampleHitReactionMotion(0);
  expect(expectedHit).not.toEqual(sampleHitReactionMotion(HIT_REACTION_MOTION_MS));
  for (const { eid, x, profile } of spawned) {
    const baseImage = imageByEid.get(eid)!;
    expect(baseImage.x, `${profile.archetypeId}:hit reaction`).toBeCloseTo(
      ftToPx(x) + signedMotionOffsetX(baseImage, expectedHit.offsetX),
    );
    const flashOverlay = images.find(
      (image, index) =>
        index >= baseImageCount &&
        image.visible &&
        image.tintMode === PHASER_TINT_MODE_FILL &&
        Math.abs(image.x - baseImage.x) < 0.001,
    );
    expect(flashOverlay, `${profile.archetypeId}:hit flash`).toBeDefined();
    expect(flashOverlay!.alpha).toBeCloseTo(baseImage.alpha * expectedHit.flash);
    coverage.get(profile.archetypeId)!.add('hit');
  }
  expect(imageByEid.get(rat.eid)!.tint, 'Rat Brute identity tint survives flash').not.toBe(
    0xffffff,
  );

  for (const { eid } of spawned) {
    world.statusEffectsByEntity.set(eid, [
      {
        stat: 'speed',
        op: 'multiply',
        value: 0.75,
        durationMs: 2_000,
        remainingMs: 1_000,
        sourceType: 'ability',
        sourceId: 'runtime-motion-test-slow',
        stackRule: { mode: 'refresh' },
      },
    ]);
  }
  syncWithoutGameplayDelta('active speed status', 1_900);
  for (const { eid, profile } of spawned) {
    const img = imageByEid.get(eid)!;
    expect(img.tinted, `${profile.archetypeId}:status tint`).toBe(true);
    expect(img.alpha, `${profile.archetypeId}:status alpha`).toBeCloseTo(0.9);
    const flashOverlay = images.find(
      (image, index) =>
        index >= baseImageCount &&
        image.visible &&
        image.tintMode === PHASER_TINT_MODE_FILL &&
        Math.abs(image.x - img.x) < 0.001,
    );
    expect(flashOverlay, `${profile.archetypeId}:status flash`).toBeDefined();
    expect(flashOverlay!.alpha, `${profile.archetypeId}:status flash alpha`).toBeCloseTo(
      img.alpha * 0.15,
    );
    coverage.get(profile.archetypeId)!.add('status');
  }

  for (const { eid } of spawned) {
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 3_000 }));
  }
  syncWithoutGameplayDelta('corpse precedence', 2_100);
  for (const { eid, x, profile } of spawned) {
    const img = imageByEid.get(eid)!;
    expect(img.x, `${profile.archetypeId}:corpse x`).toBe(ftToPx(x));
    expect(img.y, `${profile.archetypeId}:corpse y`).toBe(ftToPx(20));
    expect(img.rotation, `${profile.archetypeId}:corpse rotation`).toBeCloseTo(0);
    expect(img.depth, `${profile.archetypeId}:corpse depth`).toBe(WORLD_VFX_DEPTH.corpse);
    coverage.get(profile.archetypeId)!.add('death');
  }
  expect(
    images
      .slice(baseImageCount)
      .filter((image) => image.tintMode === PHASER_TINT_MODE_FILL)
      .every((image) => !image.visible),
    'corpse presentation hides every live flash overlay',
  ).toBe(true);

  for (const { profile } of spawned) {
    const expectedStates = ['spawn', 'movement', 'contact', 'hit', 'status', 'death'];
    if (profile.hasProjectile) {
      expectedStates.push('ranged-windup', 'ranged-release', 'projectile-no-contact');
    }
    expect(
      [...coverage.get(profile.archetypeId)!].sort(),
      `${profile.archetypeId}:state coverage`,
    ).toEqual(expectedStates.sort());
  }

  const reuseWorld = createTestWorld({ seed: 42, floor: 2 });
  reuseWorld.floorScenario = {
    enemyArchetypes: new Map(),
    objective: { bossBattles: new Map() },
  } as typeof reuseWorld.floorScenario;
  reuseWorld.floorExtendedState = { ambientEnemyArchetypes: new Map() };
  const oldEid = spawnBehaviorEnemy(reuseWorld, 10, 10, 100, 0, 1, 30, 8);
  setComponent(reuseWorld.ecs, oldEid, Sprite, { textureId: 1, width: 3, height: 3 });
  setEnemyAppearanceKey(reuseWorld, oldEid, 'glow-worm');
  reuseWorld.floorScenario!.enemyArchetypes.set(oldEid, 'snailfolk-boss');
  reuseWorld.floorExtendedState!.ambientEnemyArchetypes!.set(oldEid, 'glow-worm');
  const reuseStub = createSceneStub({ kenneyLoaded: true });
  const reuseBridge = createPhaserBridge(reuseStub.scene);
  let before = gameplaySnapshot(reuseWorld, [oldEid]);
  reuseBridge.sync(reuseWorld, 0);
  expect(gameplaySnapshot(reuseWorld, [oldEid]), 'initial reuse sync mutated gameplay').toEqual(
    before,
  );

  removeEntity(reuseWorld.ecs, oldEid);
  reuseWorld.floorScenario!.enemyArchetypes.delete(oldEid);
  // Intentionally leave the stale ambientEnemyArchetypes entry to verify
  // that the generation-fresh enemyAppearanceKeys takes priority over it.
  const recycledEid = spawnBehaviorEnemy(reuseWorld, 20, 10, 100, 0, 1, 30, 8);
  expect(recycledEid).toBe(oldEid);
  setComponent(reuseWorld.ecs, recycledEid, Sprite, { textureId: 2, width: 3, height: 3 });
  setEnemyAppearanceKey(reuseWorld, recycledEid, 'slime');
  reuseWorld.stores.velocity.x[recycledEid] = 1;
  before = gameplaySnapshot(reuseWorld, [recycledEid]);
  reuseBridge.sync(reuseWorld, 500);
  expect(
    gameplaySnapshot(reuseWorld, [recycledEid]),
    'recycled spawn sync mutated gameplay',
  ).toEqual(before);
  before = gameplaySnapshot(reuseWorld, [recycledEid]);
  reuseBridge.sync(reuseWorld, 800);
  expect(
    gameplaySnapshot(reuseWorld, [recycledEid]),
    'recycled movement sync mutated gameplay',
  ).toEqual(before);
  const recycledImage = [...reuseStub.images].reverse().find((image) => !image.destroyed)!;
  const expectedRecycledMotion = sampleMovementMotion(800, 'hop');
  expect(recycledImage.x, 'recycled EID resolves the new slime profile').toBeCloseTo(
    ftToPx(20) + (recycledImage.flipX ? -1 : 1) * ftToPx(expectedRecycledMotion.offsetX),
  );

  // ── Generation-safe hit reaction: stale events must not apply to a recycled EID ──
  // Push a hit event with the OLD generation before recycling, then verify the
  // new occupant does not receive the stale reaction on the next sync.
  const VICTIM_X = 5;
  const VICTIM_Y = 5;
  const NEW_OCCUPANT_X = 30;
  const STALE_HP = 100;
  const STALE_DETECT = 30;
  const STALE_ATTACK_RANGE = 8;

  const staleGenWorld = createTestWorld({ seed: 99, floor: 2 });
  staleGenWorld.floorScenario = {
    enemyArchetypes: new Map(),
    objective: { bossBattles: new Map() },
  } as typeof staleGenWorld.floorScenario;
  staleGenWorld.floorExtendedState = { ambientEnemyArchetypes: new Map() };
  const victimEid = spawnBehaviorEnemy(
    staleGenWorld,
    VICTIM_X,
    VICTIM_Y,
    STALE_HP,
    0,
    1,
    STALE_DETECT,
    STALE_ATTACK_RANGE,
  );
  setComponent(staleGenWorld.ecs, victimEid, Sprite, { textureId: 1, width: 3, height: 3 });
  setEnemyAppearanceKey(staleGenWorld, victimEid, 'rat');
  const staleStub = createSceneStub({ kenneyLoaded: true });
  const staleBridge = createPhaserBridge(staleStub.scene);
  staleBridge.sync(staleGenWorld, 0);

  // Record the OLD generation for the victim EID.
  const oldGeneration = staleGenWorld.entityRenderGeneration[victimEid];
  // Push a hit event with the victim's OLD generation stamped in.
  staleGenWorld.combatEvents.push({
    type: 'hit',
    x: VICTIM_X,
    y: VICTIM_Y,
    amount: 5,
    targetType: 'enemy',
    targetEid: victimEid,
    targetRenderGeneration: oldGeneration,
    timestamp: 10,
  });

  // Remove and immediately recycle the EID (bitecs reuses it).
  removeEntity(staleGenWorld.ecs, victimEid);
  staleGenWorld.floorScenario!.enemyArchetypes.delete(victimEid);
  const newOccupantEid = spawnBehaviorEnemy(
    staleGenWorld,
    NEW_OCCUPANT_X,
    VICTIM_Y,
    STALE_HP,
    0,
    1,
    STALE_DETECT,
    STALE_ATTACK_RANGE,
  );
  expect(
    newOccupantEid,
    'EID must be recycled for the generation-safety test to be meaningful',
  ).toBe(victimEid);
  setComponent(staleGenWorld.ecs, newOccupantEid, Sprite, { textureId: 2, width: 3, height: 3 });
  setEnemyAppearanceKey(staleGenWorld, newOccupantEid, 'slime');

  // The new occupant has a different generation; the stale event must be skipped.
  expect(staleGenWorld.entityRenderGeneration[newOccupantEid]).not.toBe(oldGeneration);
  const staleBeforeSync = gameplaySnapshot(staleGenWorld, [newOccupantEid]);
  staleBridge.sync(staleGenWorld, 50);
  expect(
    gameplaySnapshot(staleGenWorld, [newOccupantEid]),
    'generation-safe: stale hit event must not mutate new occupant gameplay state',
  ).toEqual(staleBeforeSync);
  const staleNewImage = [...staleStub.images].reverse().find((image) => !image.destroyed)!;
  // The new occupant has no motion state, so it sits at neutral position — not
  // at a hit-reaction offset — proving the stale event was discarded.
  expect(staleNewImage.x, 'generation-safe: new occupant must not show stale hit reaction').toBe(
    ftToPx(NEW_OCCUPANT_X),
  );
});
