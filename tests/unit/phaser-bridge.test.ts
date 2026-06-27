import { addComponent, addEntity, removeEntity } from 'bitecs';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import {
  DeathTimer,
  Enemy,
  Player,
  Position,
  Rotation,
  Sprite,
} from '../../src/core/components.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { set } from '../../src/core/world.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';

class MockImage {
  destroyed = false;
  visible = true;
  alpha = 1;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  tint = 0xffffff;
  tinted = false;
  frame: number | undefined;

  constructor(
    public x: number,
    public y: number,
    public textureKey: string,
    frame?: number,
  ) {
    this.frame = frame;
  }

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setTexture(key: string, frame?: number): this {
    this.textureKey = key;
    // Match Phaser semantics: setTexture(key) resets frame to the texture default.
    this.frame = frame ?? 0;
    return this;
  }

  setAlpha(alpha: number): this {
    this.alpha = alpha;
    return this;
  }

  setTint(tint: number): this {
    this.tint = tint;
    this.tinted = true;
    return this;
  }

  clearTint(): this {
    this.tint = 0xffffff;
    this.tinted = false;
    return this;
  }

  setScale(x: number, y?: number): this {
    this.scaleX = x;
    this.scaleY = y ?? x;
    return this;
  }

  setRotation(rotation: number): this {
    this.rotation = rotation;
    return this;
  }

  setVisible(visible: boolean): this {
    this.visible = visible;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function createSceneStub(options: { kenneyLoaded?: boolean } = {}) {
  const images: MockImage[] = [];
  const image = vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
    const mockImage = new MockImage(x, y, textureKey, frame);
    images.push(mockImage);
    return mockImage as unknown as Phaser.GameObjects.Image;
  });

  const textures = options.kenneyLoaded ? { exists: (_key: string) => true } : undefined;

  return {
    images,
    scene: {
      add: {
        image,
      },
      textures,
    } as unknown as Phaser.Scene,
  };
}

function createBridgeTestMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 20,
    heightTiles: 20,
    tileSizePx: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(20, 20);
  tileMap.fill(TilePresets.FLOOR);
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(400), { x: 10, y: 10 });
}

describe('createPhaserBridge', () => {
  it('handles empty worlds without creating game objects', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    bridge.sync(world);

    expect(images).toHaveLength(0);
  });

  it('creates and updates images for sprite-position entities', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      x: 10,
      y: 20,
      destroyed: false,
    });

    world.stores.position.x[eid] = 30;
    world.stores.position.y[eid] = 40;

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ x: 30, y: 40 });
  });

  it('destroys images when entities disappear or the bridge is destroyed', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 1, y: 2 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 12, height: 12 }));

    bridge.sync(world);
    expect(images).toHaveLength(1);

    removeEntity(world.ecs, eid);
    bridge.sync(world);

    expect(images[0]?.destroyed).toBe(true);

    const secondEid = addEntity(world.ecs);
    addComponent(world.ecs, secondEid, set(Position, { x: 5, y: 6 }));
    addComponent(world.ecs, secondEid, set(Sprite, { textureId: 0, width: 12, height: 12 }));

    bridge.sync(world);
    expect(images).toHaveLength(2);

    bridge.destroy();

    expect(images[1]?.destroyed).toBe(true);
  });

  it('uses procedural texture key when no Kenney sheet is loaded', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toMatch(/^__cw_/);
    expect(images[0]?.frame).toBeUndefined();
    expect(images[0]?.scaleX).toBe(1);
  });

  it('prefers Kenney sprite + frame when the sheet texture exists', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: true });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('kenney-tiny-dungeon');
    expect(images[0]?.frame).toBe(96); // player → Tiny Dungeon knight (frame 96)
    expect(images[0]?.scaleX).toBeGreaterThan(1); // upscaled from 16x16
  });

  it('fades the skull marker out quickly while the corpse desaturates and fades', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 12, y: 34 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);
    expect(images).toHaveLength(1);

    // First dead frame: skull spawned at full alpha, corpse untouched.
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 3000 }));
    bridge.sync(world);

    expect(images).toHaveLength(2);
    const corpse = images[0]!;
    const skull = images[1]!;
    expect(skull).toMatchObject({
      x: 12,
      y: 16, // 34 - DEAD_SKULL_Y_OFFSET, no rise yet
      textureKey: '__cw_dead_skull',
      destroyed: false,
    });
    expect(skull.alpha).toBeCloseTo(0.95);
    expect(corpse.alpha).toBe(1);
    expect(corpse.tint).toBe(0xffffff); // no desaturation yet

    // Partway through the short skull window: skull dimmer and floating up.
    world.stores.deathTimer.remainingMs[eid] = 3000 - 450;
    bridge.sync(world);
    expect(skull.alpha).toBeLessThan(0.95);
    expect(skull.alpha).toBeGreaterThan(0);
    expect(skull.y).toBeLessThan(16); // risen upward
    expect(corpse.tinted).toBe(true);
    expect(corpse.tint).not.toBe(0xffffff); // draining toward grey

    // Past the skull window but well before corpse removal: skull gone, corpse
    // still fully present and now fully desaturated.
    world.stores.deathTimer.remainingMs[eid] = 3000 - 900;
    bridge.sync(world);
    expect(skull.alpha).toBe(0);
    expect(skull.visible).toBe(false);
    expect(corpse.alpha).toBe(1);

    // Late linger: corpse fading out.
    world.stores.deathTimer.remainingMs[eid] = 600;
    bridge.sync(world);
    expect(corpse.alpha).toBeLessThan(1);
    expect(corpse.alpha).toBeGreaterThan(0);

    removeEntity(world.ecs, eid);
    bridge.sync(world);

    expect(corpse.destroyed).toBe(true);
    expect(skull.destroyed).toBe(true);
  });

  it('clears leftover corpse tint and linger state when a dead enemy EID is recycled', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 12, y: 34 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    bridge.sync(world);

    // Kill it and advance so the corpse takes on a grey multiply-tint and the
    // visual captures its 3000ms linger duration.
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 3000 }));
    bridge.sync(world);
    world.stores.deathTimer.remainingMs[eid] = 1500;
    bridge.sync(world);

    const corpse = images[0]!;
    expect(corpse.tinted).toBe(true);
    expect(corpse.tint).not.toBe(0xffffff);

    // Free the EID and immediately reuse it for a fresh living enemy with NO
    // intervening sync, so the bridge reuses the same sprite (it never sees the
    // EID go idle, so the cleanup pass never recreates the visual).
    removeEntity(world.ecs, eid);
    const recycled = addEntity(world.ecs);
    expect(recycled).toBe(eid); // bitecs reuses the freed EID
    addComponent(world.ecs, recycled, set(Position, { x: 50, y: 60 }));
    addComponent(world.ecs, recycled, Enemy);
    addComponent(world.ecs, recycled, set(Sprite, { textureId: 0, width: 0, height: 0 }));
    bridge.sync(world);

    // The same sprite object was reused (not destroyed/recreated) and its
    // leftover corpse styling is gone: full colour at full opacity.
    expect(corpse.destroyed).toBe(false);
    expect(corpse.tinted).toBe(false);
    expect(corpse.tint).toBe(0xffffff);
    expect(corpse.alpha).toBe(1);

    // The stale linger was cleared too, so a shorter second death recalibrates
    // from full. With a stale 3000ms total, 1000ms remaining would read as a
    // two-thirds-elapsed corpse and tint grey + drop alpha on the first frame.
    addComponent(world.ecs, recycled, set(DeathTimer, { remainingMs: 1000 }));
    bridge.sync(world);
    expect(corpse.tint).toBe(0xffffff);
    expect(corpse.alpha).toBe(1);
  });

  it('renders rats and slimes with distinct enemy textures', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const rat = addEntity(world.ecs);
    const slime = addEntity(world.ecs);

    addComponent(world.ecs, rat, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, rat, Enemy);
    addComponent(world.ecs, rat, set(Sprite, { textureId: 1, width: 16, height: 16 }));

    addComponent(world.ecs, slime, set(Position, { x: 30, y: 10 }));
    addComponent(world.ecs, slime, Enemy);
    addComponent(world.ecs, slime, set(Sprite, { textureId: 2, width: 16, height: 16 }));

    bridge.sync(world);

    expect(images).toHaveLength(2);
    expect(images[0]?.textureKey).toBe('__cw_enemy_rat');
    expect(images[1]?.textureKey).toBe('__cw_enemy_slime');
  });

  it('renders slime-mini babies smaller than a full slime', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    // Minimal floor1 sidecar so the renderer can read the 'slime-mini' archetype
    // and iterate boss battles (both accessed during enemy sync).
    world.floor1 = {
      enemyArchetypes: new Map<number, string>(),
      objective: { bossBattles: new Map() },
    } as unknown as NonNullable<typeof world.floor1>;

    const fullSlime = addEntity(world.ecs);
    const miniSlime = addEntity(world.ecs);

    // Full slime: no archetype, so it renders at the base enemy scale.
    addComponent(world.ecs, fullSlime, set(Position, { x: 10, y: 10 }));
    addComponent(world.ecs, fullSlime, Enemy);
    addComponent(world.ecs, fullSlime, set(Sprite, { textureId: 2, width: 24, height: 24 }));

    // Baby slime: shrunken Sprite.width + 'slime-mini' archetype, no SpawnAnim so
    // it renders at a steady, smaller size (16/24 of the full slime).
    addComponent(world.ecs, miniSlime, set(Position, { x: 30, y: 10 }));
    addComponent(world.ecs, miniSlime, Enemy);
    addComponent(world.ecs, miniSlime, set(Sprite, { textureId: 2, width: 16, height: 16 }));
    world.floor1!.enemyArchetypes.set(miniSlime, 'slime-mini');

    bridge.sync(world);

    expect(images).toHaveLength(2);
    const fullImg = images[0]!;
    const miniImg = images[1]!;

    // Full slime is scaled uniformly at the base scale.
    expect(fullImg.scaleX).toBeCloseTo(fullImg.scaleY, 6);
    expect(fullImg.scaleX).toBeGreaterThan(0);

    // Baby renders smaller, at 16/24 of the full slime's scale, still uniform.
    expect(miniImg.scaleX).toBeLessThan(fullImg.scaleX);
    expect(miniImg.scaleX).toBeCloseTo(miniImg.scaleY, 6);
    expect(miniImg.scaleX).toBeCloseTo(fullImg.scaleX * (16 / 24), 5);
  });

  // A welcome sign is a Sprite+Position entity whose textureId is the welcome
  // board (SPRITE_TEX_WELCOME_SIGN === 3). Its Rotation.angle aims the arrow at
  // the door that leads onward; the renderer picks the baked board so the
  // "WELCOME" word never reads upside-down.
  it('points a right-hemisphere welcome sign along its angle with the base board', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    // cos(angle) >= 0: the arrow-right board already reads upright, so the
    // renderer keeps the base texture and rotates straight to `angle`.
    const angle = Math.PI / 6; // 30°, cos > 0
    addComponent(world.ecs, eid, set(Position, { x: 40, y: 50 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 3, width: 16, height: 16 }));
    addComponent(world.ecs, eid, set(Rotation, { angle }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('__cw_welcome_sign');
    expect(images[0]?.rotation).toBeCloseTo(angle, 6);
  });

  it('swaps a left-hemisphere welcome sign to the mirrored board, measured from −x', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    // cos(angle) < 0: aiming the arrow-right board here would flip "WELCOME"
    // upside-down, so the renderer swaps to the arrow-left board and measures
    // rotation from the −x reference (angle − π) to keep the word readable while
    // the arrow still points along `angle`.
    const angle = (3 * Math.PI) / 4; // 135°, cos < 0
    addComponent(world.ecs, eid, set(Position, { x: 40, y: 50 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 3, width: 16, height: 16 }));
    addComponent(world.ecs, eid, set(Rotation, { angle }));

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]?.textureKey).toBe('__cw_welcome_sign_left');
    expect(images[0]?.rotation).toBeCloseTo(angle - Math.PI, 6);
  });

  it('flips a welcome sign between boards as it rotates across the vertical', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    const rightAngle = Math.PI / 4; // cos > 0 → base board
    addComponent(world.ecs, eid, set(Position, { x: 40, y: 50 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 3, width: 16, height: 16 }));
    addComponent(world.ecs, eid, set(Rotation, { angle: rightAngle }));

    bridge.sync(world);
    expect(images).toHaveLength(1);
    const sign = images[0]!;
    expect(sign.textureKey).toBe('__cw_welcome_sign');
    expect(sign.rotation).toBeCloseTo(rightAngle, 6);

    // Rotate past vertical into the left hemisphere: the SAME sprite swaps to the
    // mirrored board and re-references its rotation — no new image is created.
    const leftAngle = (3 * Math.PI) / 4; // cos < 0 → mirrored board
    world.stores.rotation.angle[eid] = leftAngle;
    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(sign.textureKey).toBe('__cw_welcome_sign_left');
    expect(sign.rotation).toBeCloseTo(leftAngle - Math.PI, 6);
  });

  it('hides enemies on tiles outside current FOV visibility', () => {
    const { scene, images } = createSceneStub({ kenneyLoaded: false });
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const floorMap = createBridgeTestMap();
    world.floorMap = floorMap;
    floorMap.clearVisibility();
    floorMap.setVisible(2, 2);
    const enemyVisible = addEntity(world.ecs);
    const enemyHidden = addEntity(world.ecs);

    addComponent(world.ecs, enemyVisible, set(Position, { x: 2 * 32 + 16, y: 2 * 32 + 16 }));
    addComponent(world.ecs, enemyVisible, Enemy);
    addComponent(world.ecs, enemyVisible, set(Sprite, { textureId: 0, width: 16, height: 16 }));

    addComponent(world.ecs, enemyHidden, set(Position, { x: 8 * 32 + 16, y: 8 * 32 + 16 }));
    addComponent(world.ecs, enemyHidden, Enemy);
    addComponent(world.ecs, enemyHidden, set(Sprite, { textureId: 0, width: 16, height: 16 }));

    bridge.sync(world);

    expect(images).toHaveLength(2);
    expect(images[0]?.visible).toBe(true);
    expect(images[1]?.visible).toBe(false);
  });
});
