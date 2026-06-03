import { hasComponent, query } from 'bitecs';
import type Phaser from 'phaser';
import { Enemy, EnemyProjectile, Player, Position, Projectile, Sprite, XpGem } from '../core/components.js';
import type { GameWorld } from '../core/world.js';

interface RenderStyle {
  color: number;
  width: number;
  height: number;
}

function getRenderStyle(world: GameWorld, eid: number): RenderStyle {
  if (hasComponent(world.ecs, eid, Player)) {
    return { color: 0x00ff00, width: 24, height: 24 };
  }

  if (hasComponent(world.ecs, eid, Enemy)) {
    return { color: 0xff0000, width: 16, height: 16 };
  }

  if (hasComponent(world.ecs, eid, XpGem)) {
    return { color: 0xffff00, width: 8, height: 8 };
  }

  if (hasComponent(world.ecs, eid, EnemyProjectile)) {
    return { color: 0xff6600, width: 6, height: 6 };
  }

  if (hasComponent(world.ecs, eid, Projectile)) {
    return { color: 0xffffff, width: 6, height: 6 };
  }

  return { color: 0x808080, width: 12, height: 12 };
}

export function createPhaserBridge(scene: Phaser.Scene): { sync(world: GameWorld): void; destroy(): void } {
  const gameObjects = new Map<number, Phaser.GameObjects.Rectangle>();

  return {
    sync(world: GameWorld): void {
      const entities = query(world.ecs, [Sprite, Position]);
      const activeEntities = new Set<number>();
      const { position, sprite } = world.stores;

      for (const eid of entities) {
        activeEntities.add(eid);

        const renderStyle = getRenderStyle(world, eid);
        const spriteWidth = sprite.width[eid] ?? 0;
        const spriteHeight = sprite.height[eid] ?? 0;
        const width = spriteWidth > 0 ? spriteWidth : renderStyle.width;
        const height = spriteHeight > 0 ? spriteHeight : renderStyle.height;
        const x = position.x[eid] ?? 0;
        const y = position.y[eid] ?? 0;

        let rectangle = gameObjects.get(eid);

        if (!rectangle) {
          rectangle = scene.add.rectangle(x, y, width, height, renderStyle.color);
          gameObjects.set(eid, rectangle);
        }

        rectangle.setPosition(x, y);
        rectangle.setSize(width, height);
        rectangle.setFillStyle(renderStyle.color, 1);
      }

      for (const [eid, rectangle] of gameObjects) {
        if (activeEntities.has(eid)) {
          continue;
        }

        rectangle.destroy();
        gameObjects.delete(eid);
      }
    },

    destroy(): void {
      for (const rectangle of gameObjects.values()) {
        rectangle.destroy();
      }

      gameObjects.clear();
    },
  };
}
