import {
  addComponent,
  hasComponent,
  removeComponent,
  removeEntity,
  set,
  setComponent,
} from 'bitecs';
import { expect, it } from 'vitest';
import {
  Damage,
  DeathTimer,
  Enemy,
  EnemyBehavior,
  Health,
  Position,
  Size,
  SpawnAnim,
  Spawner,
  Sprite,
  Velocity,
  Weight,
} from '../../src/core/components.js';
import { applyDamage, DEFAULT_DAMAGE_OPTIONS } from '../../src/core/apply-damage.js';
import { setEnemyAppearanceKey, spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { WORLD_VFX_DEPTH } from '../../src/shared/render-depths.js';
import { floor1EnemyPack, floor2EnemyPack } from '../../src/shared/enemy-packs.js';
import {
  CONTACT_ATTACK_MOTION_MS,
  getRuntimeMobMotionProfiles,
  HIT_REACTION_MOTION_MS,
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
  const runtimeMobMotionProfiles = getRuntimeMobMotionProfiles();
  const expectedIds = [
    ...floor1EnemyPack.archetypes.map((archetype) => archetype.id),
    ...SPECIAL_FLOOR_1_MOBS,
    ...SPAWNER_FLOOR_1_MOBS,
    ...floor2EnemyPack.archetypes.map((archetype) => archetype.id),
  ].sort();
  const actualIds = runtimeMobMotionProfiles.map((profile) => profile.archetypeId).sort();
  expect(actualIds).toEqual(expectedIds);
  expect(new Set(actualIds).size).toBe(actualIds.length);
  expect(actualIds).not.toContain('rat-nest');
  expect(actualIds).not.toContain('slime-pool');

  const world = createTestWorld({ seed: 42, floor: 1 });
  const spawned = runtimeMobMotionProfiles.map((profile, index) => {
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
      sourceRenderGeneration: world.entityRenderGeneration[eid],
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
      targetRenderGeneration: world.entityRenderGeneration[eid],
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

  // ── Generation-safe hit reaction: two-sided proof ──
  // • Producer side: applyDamage must stamp targetRenderGeneration; removing
  //   the stamp makes the producer assertion fail.
  // • Bridge guard: even with a correctly stamped event, a stale generation
  //   (from the recycled victim) must be rejected; removing the guard lets a
  //   hit-reaction pose show on the new occupant, making the position assertion
  //   fail.
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

  // ── Producer side: applyDamage must stamp targetRenderGeneration ──
  const oldGeneration = staleGenWorld.entityRenderGeneration[victimEid];
  staleGenWorld.elapsedMs = 0;
  applyDamage(staleGenWorld, victimEid, 5, VICTIM_X, VICTIM_Y, DEFAULT_DAMAGE_OPTIONS);
  const stampedEvent = staleGenWorld.combatEvents.at(-1)!;
  expect(
    stampedEvent.targetRenderGeneration,
    'applyDamage must stamp targetRenderGeneration on the combat event',
  ).toBe(oldGeneration);
  // Drain events: the victim's hit must not seed the new occupant's stale-event check.
  staleGenWorld.combatEvents.length = 0;

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
  expect(staleGenWorld.entityRenderGeneration[newOccupantEid]).not.toBe(oldGeneration);

  const staleBeforeSync = gameplaySnapshot(staleGenWorld, [newOccupantEid]);

  // ── Bridge guard: prewarm past the spawn window, then submit a stale event
  //    at a fresh timestamp. Without the guard the entity shows a non-neutral
  //    hit-reaction offset; the guard must reject it. ──
  //
  // First sync registers the new occupant (firstSeenMs = T_FIRST_SEEN).
  const T_FIRST_SEEN = 50;
  staleBridge.sync(staleGenWorld, T_FIRST_SEEN);
  expect(
    gameplaySnapshot(staleGenWorld, [newOccupantEid]),
    'prewarm sync must not mutate gameplay',
  ).toEqual(staleBeforeSync);

  // Advance past spawn window: spawnElapsedMs = T_ACTIVE - T_FIRST_SEEN > MINI_SLIME_SPAWN_ANIM_MS.
  const T_ACTIVE = T_FIRST_SEEN + MINI_SLIME_SPAWN_ANIM_MS + 50;
  // Stale event with the OLD generation and a timestamp inside the HIT_REACTION_MOTION_MS
  // window — so if the guard were absent, sampleHitReactionMotion would shift x by
  // several pixels and the position assertion below would fail.
  staleGenWorld.combatEvents.push({
    type: 'hit',
    x: NEW_OCCUPANT_X,
    y: VICTIM_Y,
    amount: 5,
    targetType: 'enemy',
    targetEid: newOccupantEid,
    targetRenderGeneration: oldGeneration,
    timestamp: T_ACTIVE - Math.floor(HIT_REACTION_MOTION_MS / 2),
  });
  staleBridge.sync(staleGenWorld, T_ACTIVE);
  expect(
    gameplaySnapshot(staleGenWorld, [newOccupantEid]),
    'generation-safe: stale hit event must not mutate new occupant gameplay state',
  ).toEqual(staleBeforeSync);
  const staleNewImage = [...staleStub.images].reverse().find((image) => !image.destroyed)!;
  // Stale event rejected: no hit-reaction offset, entity at neutral position.
  expect(staleNewImage.x, 'generation-safe: new occupant must not show stale hit reaction').toBe(
    ftToPx(NEW_OCCUPANT_X),
  );
});

it('spawner child with 240 ms SpawnAnim stays settled after SpawnAnim expires (no residual pop-scale)', () => {
  // SPAWNER_CHILD_SPAWN_ANIM_MS = 240 in spawnerSystem.ts; MINI_SLIME_SPAWN_ANIM_MS = 280.
  // Before this fix the bridge used the 280 ms window regardless: at T=241 ms after first-seen,
  // spawnAnimSystem had already removed SpawnAnim (at 240 ms), so the inner
  //   `if (hasComponent(..., SpawnAnim)) { ...scaleX: 1, scaleY: 1 }`
  // no longer fired, and sampleSpawnMotion(241) returned scaleX ≈ 1.05 — a 40 ms visible glitch.
  // The fix stores spawnAnimDurationMs from SpawnAnim.totalMs at first-seen, so the spawn block
  // exits cleanly after 240 ms.
  const CHILD_SPAWN_ANIM_MS = 240;
  const SPAWN_X = 15;
  const SPAWN_Y = 20;

  const childWorld = createTestWorld({ seed: 77, floor: 1 });
  childWorld.floorScenario = {
    enemyArchetypes: new Map(),
    objective: { bossBattles: new Map() },
  } as typeof childWorld.floorScenario;
  childWorld.floorExtendedState = { ambientEnemyArchetypes: new Map() };

  // Spawn a slime — it has a runtime motion profile.
  const childEid = spawnBehaviorEnemy(childWorld, SPAWN_X, SPAWN_Y, 100, 0, 1, 30, 8);
  setComponent(childWorld.ecs, childEid, Sprite, { textureId: 1, width: 3, height: 3 });
  setEnemyAppearanceKey(childWorld, childEid, 'slime');
  // Attach SpawnAnim with the spawner-child duration (shorter than MINI_SLIME_SPAWN_ANIM_MS).
  addComponent(
    childWorld.ecs,
    childEid,
    set(SpawnAnim, { remainingMs: CHILD_SPAWN_ANIM_MS, totalMs: CHILD_SPAWN_ANIM_MS }),
  );

  const { scene, images } = createSceneStub({ kenneyLoaded: true });
  const childBridge = createPhaserBridge(scene);

  // T=0: first sync registers firstSeenMs=0 and captures spawnAnimDurationMs=240.
  // The image is created here; spawnAnimDurationMs is locked in for this generation.
  childBridge.sync(childWorld, 0);
  const childImage = images[0] as (typeof images)[0];

  // Simulate the spawn animation reaching completion (remainingMs→0):
  // computeEnemyScale reads remainingMs/totalMs for the pop-scale; when remainingMs=0,
  // progress=1 and pop={x:1,y:1} so scaleX = baseScale (fully settled).
  childWorld.stores.spawnAnim.remainingMs[childEid] = 0;

  // T=239ms: SpawnAnim still present and animation done — scale is at full (base) scale.
  // mobMotion.scaleX is still suppressed to 1 by the inner hasComponent check.
  childBridge.sync(childWorld, 239);
  const settledScaleX = childImage.scaleX;
  const settledScaleY = childImage.scaleY;
  // Settled scale must be positive (sanity check on test setup).
  expect(settledScaleX, 'at T=239ms settled scale must be positive').toBeGreaterThan(0);

  // Simulate spawnAnimSystem removing the component at 240ms.
  removeComponent(childWorld.ecs, childEid, SpawnAnim);

  // T=241ms: past the 240ms spawner window, SpawnAnim removed.
  // Old code (MINI_SLIME_SPAWN_ANIM_MS=280): spawnElapsedMs 241 < 280 → sampleSpawnMotion fires
  //   and returns scaleX ≈ 1.05, applied without SpawnAnim override → final = baseScale × 1.05
  //   (a 40 ms visible glitch).
  // New code: spawnElapsedMs 241 >= spawnAnimDurationMs (240) → block skipped, neutral motion
  //   applied → final = baseScale × 1 = settledScaleX (no glitch).
  childBridge.sync(childWorld, 241);
  expect(
    childImage.scaleX,
    'at T=241ms after SpawnAnim removed: no residual pop-scale (must match settled scale)',
  ).toBe(settledScaleX);
  expect(
    childImage.scaleY,
    'at T=241ms after SpawnAnim removed: no residual pop-scale (must match settled scale)',
  ).toBe(settledScaleY);
});
