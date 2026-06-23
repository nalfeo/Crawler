import { addComponent, addEntity, removeEntity } from 'bitecs';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { DeathTimer, Enemy, Player, Position, Sprite } from '../../src/core/components.js';
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

  setScale(scale: number): this {
    this.scaleX = scale;
    this.scaleY = scale;
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
    tileSizeFt: 32,
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
      x: 80,
      y: 160,
      destroyed: false,
    });

    world.stores.position.x[eid] = 30;
    world.stores.position.y[eid] = 40;

    bridge.sync(world);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ x: 240, y: 320 });
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

  it('adds a skull marker above enemies during their death linger window', () => {
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 12, y: 34 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);
    expect(images).toHaveLength(1);

    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 300 }));
    bridge.sync(world);

    expect(images).toHaveLength(2);
    expect(images[1]).toMatchObject({
      x: 96,
      y: 254,
      textureKey: '__cw_dead_skull',
      destroyed: false,
    });

    removeEntity(world.ecs, eid);
    bridge.sync(world);

    expect(images[0]?.destroyed).toBe(true);
    expect(images[1]?.destroyed).toBe(true);
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
