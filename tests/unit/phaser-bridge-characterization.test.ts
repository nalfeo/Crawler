import { addComponent, addEntity, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Enemy, Gold, Player, Position, Sprite, XpGem } from '../../src/core/components.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { set } from '../../src/core/world.js';
import { ftToPx, PIXELS_PER_FOOT } from '../../src/shared/units.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createSceneStub } from '../fixtures/phaser-bridge-harness.js';

/**
 * CHARACTERIZATION GUARDS for {@link createPhaserBridge}.
 *
 * These pin the CURRENT observable create/sync/teardown bookkeeping of the
 * PhaserBridge god-class (~1336 LOC) so a future session can decompose it and
 * prove equivalence. They are deliberately NON-duplicative of
 * `phaser-bridge.test.ts`: that suite verifies per-entity-type VISUAL detail
 * (textures, tint, fade, bob, crop) one entity at a time; THIS suite pins the
 * cross-cutting renderer/sim contracts a decomposition is most likely to break:
 *
 *  A. Every active entity's position is routed through the feet→pixel boundary
 *     (`ftToPx`) — the single units boundary between sim and renderer.
 *  B. A heterogeneous populated world maps 1:1 to game objects (no entity type
 *     silently dropped or doubled).
 *  C. Re-syncing an unchanged world is idempotent (no churn: no new objects, no
 *     destroys, identity preserved).
 *  D. Selective teardown destroys ONLY the removed entity's object; survivors
 *     keep their object identity and position.
 *  E. `destroy()` tears down EVERY live visual at once.
 *
 * Determinism: worlds come from `createTestWorld()` (seed 42); all positions are
 * integer feet so `ftToPx` is exact; no `Math.random`/`Date.now`/wall-clock in
 * any assertion. The mock scene exposes only `add.image`, so gem/gold shadow
 * ellipses are guarded out and every renderable entity yields exactly one image.
 */

interface SpawnSpec {
  readonly fx: number;
  readonly fy: number;
}

function spawnPlayer(world: ReturnType<typeof createTestWorld>, spec: SpawnSpec): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x: spec.fx, y: spec.fy }));
  addComponent(world.ecs, eid, Player);
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
  return eid;
}

function spawnEnemy(world: ReturnType<typeof createTestWorld>, spec: SpawnSpec): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x: spec.fx, y: spec.fy }));
  addComponent(world.ecs, eid, Enemy);
  addComponent(world.ecs, eid, set(Sprite, { textureId: 1, width: 8, height: 8 }));
  return eid;
}

function spawnGem(world: ReturnType<typeof createTestWorld>, spec: SpawnSpec): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x: spec.fx, y: spec.fy }));
  addComponent(world.ecs, eid, set(XpGem, { value: 5 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 8, height: 8 }));
  return eid;
}

function spawnGold(world: ReturnType<typeof createTestWorld>, spec: SpawnSpec): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(Position, { x: spec.fx, y: spec.fy }));
  addComponent(world.ecs, eid, set(Gold, { value: 12 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 8, height: 8 }));
  return eid;
}

describe('PhaserBridge characterization — units boundary', () => {
  it('renders one foot as exactly PIXELS_PER_FOOT screen pixels', () => {
    // The bridge's only legal feet→pixel scale is ftToPx; pin the boundary
    // constant the decomposition must preserve.
    expect(ftToPx(1)).toBe(PIXELS_PER_FOOT);
    expect(ftToPx(0)).toBe(0);
  });

  it('routes every active entity position through ftToPx (player + enemies)', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    // Distinct integer-feet positions so each maps to a unique pixel coordinate.
    const specs: readonly SpawnSpec[] = [
      { fx: 10, fy: 20 }, // player
      { fx: 30, fy: 40 }, // enemy A
      { fx: 55, fy: 12 }, // enemy B
    ];
    spawnPlayer(world, specs[0]!);
    spawnEnemy(world, specs[1]!);
    spawnEnemy(world, specs[2]!);

    bridge.sync(world);

    expect(images).toHaveLength(specs.length);
    // Order-independent 1:1 check: the multiset of rendered pixel coords equals
    // the multiset of ftToPx-mapped feet coords. None of these entities bob, so
    // both axes are exact.
    const renderedCoords = images
      .map((img) => `${img.x},${img.y}`)
      .sort((a, b) => a.localeCompare(b));
    const expectedCoords = specs
      .map((s) => `${ftToPx(s.fx)},${ftToPx(s.fy)}`)
      .sort((a, b) => a.localeCompare(b));
    expect(renderedCoords).toEqual(expectedCoords);

    bridge.destroy();
  });

  it('maps a heterogeneous populated world 1:1 to game objects', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    // player + 2 enemies + gem + gold, each at a unique x in feet.
    const specs: readonly SpawnSpec[] = [
      { fx: 10, fy: 20 },
      { fx: 30, fy: 40 },
      { fx: 55, fy: 12 },
      { fx: 100, fy: 200 }, // gem
      { fx: 60, fy: 90 }, // gold
    ];
    spawnPlayer(world, specs[0]!);
    spawnEnemy(world, specs[1]!);
    spawnEnemy(world, specs[2]!);
    spawnGem(world, specs[3]!);
    spawnGold(world, specs[4]!);

    bridge.sync(world, 0);

    // Exactly one game object per entity — no type dropped or doubled.
    expect(images).toHaveLength(specs.length);

    // x carries no bob offset for any type, so each rendered x must equal a
    // distinct ftToPx-mapped feet x (gem/gold add a bob to y only).
    const renderedX = images.map((img) => img.x).sort((a, b) => a - b);
    const expectedX = specs.map((s) => ftToPx(s.fx)).sort((a, b) => a - b);
    expect(renderedX).toEqual(expectedX);

    bridge.destroy();
  });
});

describe('PhaserBridge characterization — sync/teardown bookkeeping', () => {
  it('is idempotent when re-syncing an unchanged world (no object churn)', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    spawnPlayer(world, { fx: 10, fy: 20 });
    spawnEnemy(world, { fx: 30, fy: 40 });
    spawnEnemy(world, { fx: 55, fy: 12 });

    bridge.sync(world);
    expect(images).toHaveLength(3);
    const firstPass = [...images];

    // Re-sync with no world mutation: must reuse existing objects — no new
    // creations, no destroys, same instances in the same order.
    bridge.sync(world);

    expect(images).toHaveLength(3);
    expect(images).toEqual(firstPass);
    for (const img of images) {
      expect(img.destroyed).toBe(false);
    }

    bridge.destroy();
  });

  it('selectively tears down a removed entity while preserving survivors', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    const playerEid = spawnPlayer(world, { fx: 10, fy: 20 });
    const enemyAEid = spawnEnemy(world, { fx: 30, fy: 40 });
    const enemyBEid = spawnEnemy(world, { fx: 55, fy: 12 });

    bridge.sync(world);
    expect(images).toHaveLength(3);
    const playerImg = images[0]!;
    const enemyAImg = images[1]!;
    const enemyBImg = images[2]!;
    expect(playerImg.x).toBe(ftToPx(10));
    expect(enemyAImg.x).toBe(ftToPx(30));
    expect(enemyBImg.x).toBe(ftToPx(55));

    // Remove ONLY enemy A.
    removeEntity(world.ecs, enemyAEid);
    bridge.sync(world);

    // No new objects were created (still 3 in the recorded array)...
    expect(images).toHaveLength(3);
    // ...only enemy A's object is destroyed.
    expect(enemyAImg.destroyed).toBe(true);
    // Survivors keep their identity AND position (same instances, untouched).
    expect(images[0]).toBe(playerImg);
    expect(images[2]).toBe(enemyBImg);
    expect(playerImg.destroyed).toBe(false);
    expect(enemyBImg.destroyed).toBe(false);
    expect(playerImg.x).toBe(ftToPx(10));
    expect(enemyBImg.x).toBe(ftToPx(55));

    // playerEid / enemyBEid still resolve to live entities (sanity).
    expect(playerEid).toBeGreaterThanOrEqual(0);
    expect(enemyBEid).toBeGreaterThanOrEqual(0);

    bridge.destroy();
  });

  it('destroys every live visual at once on destroy()', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    spawnPlayer(world, { fx: 10, fy: 20 });
    spawnEnemy(world, { fx: 30, fy: 40 });
    spawnEnemy(world, { fx: 55, fy: 12 });

    bridge.sync(world);
    // Three simultaneously-live visuals (the existing suite only ever exercises
    // destroy() with a single live visual).
    expect(images).toHaveLength(3);
    expect(images.every((img) => !img.destroyed)).toBe(true);

    bridge.destroy();

    expect(images.every((img) => img.destroyed)).toBe(true);
  });
});
