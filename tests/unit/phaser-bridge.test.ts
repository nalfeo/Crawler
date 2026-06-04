import { addComponent, addEntity, removeEntity } from 'bitecs';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { Player, Position, Sprite } from '../../src/core/components.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { set } from '../../src/core/world.js';

class MockImage {
  destroyed = false;
  alpha = 1;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;

  constructor(
    public x: number,
    public y: number,
    public textureKey: string,
  ) {}

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setTexture(key: string): this {
    this.textureKey = key;
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

  setVisible(_visible: boolean): this {
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function createSceneStub() {
  const images: MockImage[] = [];
  const image = vi.fn((x = 0, y = 0, textureKey = '') => {
    const mockImage = new MockImage(x, y, textureKey);
    images.push(mockImage);
    return mockImage as unknown as Phaser.GameObjects.Image;
  });

  return {
    images,
    scene: {
      add: {
        image,
      },
    } as unknown as Phaser.Scene,
  };
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
});
