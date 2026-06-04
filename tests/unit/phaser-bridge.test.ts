import { addComponent, addEntity, removeEntity } from 'bitecs';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { Player, Position, Sprite } from '../../src/core/components.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { set } from '../../src/core/world.js';

class MockRectangle {
  destroyed = false;

  constructor(
    public x: number,
    public y: number,
    public width: number,
    public height: number,
    public fillColor: number,
    public fillAlpha = 1,
  ) {}

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setSize(width: number, height: number): this {
    this.width = width;
    this.height = height;
    return this;
  }

  setFillStyle(fillColor: number, fillAlpha = 1): this {
    this.fillColor = fillColor;
    this.fillAlpha = fillAlpha;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function createSceneStub() {
  const rectangles: MockRectangle[] = [];
  const rectangle = vi.fn((x = 0, y = 0, width = 128, height = 128, fillColor = 0xffffff) => {
    const mockRectangle = new MockRectangle(x, y, width, height, fillColor);
    rectangles.push(mockRectangle);
    return mockRectangle as unknown as Phaser.GameObjects.Rectangle;
  });

  return {
    rectangles,
    scene: {
      add: {
        rectangle,
      },
    } as unknown as Phaser.Scene,
  };
}

describe('createPhaserBridge', () => {
  it('handles empty worlds without creating game objects', () => {
    const { scene, rectangles } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    bridge.sync(world);

    expect(rectangles).toHaveLength(0);
  });

  it('creates and updates rectangles for sprite-position entities', () => {
    const { scene, rectangles } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }));
    addComponent(world.ecs, eid, Player);
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0, height: 0 }));

    bridge.sync(world);

    expect(rectangles).toHaveLength(1);
    expect(rectangles[0]).toMatchObject({
      x: 10,
      y: 20,
      width: 24,
      height: 24,
      fillColor: 0x00ff00,
      destroyed: false,
    });

    world.stores.position.x[eid] = 30;
    world.stores.position.y[eid] = 40;

    bridge.sync(world);

    expect(rectangles).toHaveLength(1);
    expect(rectangles[0]).toMatchObject({ x: 30, y: 40, width: 24, height: 24 });
  });

  it('destroys rectangles when entities disappear or the bridge is destroyed', () => {
    const { scene, rectangles } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 1, y: 2 }));
    addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 12, height: 12 }));

    bridge.sync(world);
    expect(rectangles).toHaveLength(1);

    removeEntity(world.ecs, eid);
    bridge.sync(world);

    expect(rectangles[0]?.destroyed).toBe(true);

    const secondEid = addEntity(world.ecs);
    addComponent(world.ecs, secondEid, set(Position, { x: 5, y: 6 }));
    addComponent(world.ecs, secondEid, set(Sprite, { textureId: 0, width: 12, height: 12 }));

    bridge.sync(world);
    expect(rectangles).toHaveLength(2);

    bridge.destroy();

    expect(rectangles[1]?.destroyed).toBe(true);
  });
});
