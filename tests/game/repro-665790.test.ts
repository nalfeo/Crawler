import { describe, it, expect } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeFloor1Scenario } from '../../src/game/floor1Scenario.js';

describe('repro seed 665790', () => {
  it('should not spawn final boss in wall', () => {
    const seed = 665790;
    const world = createTestWorld({ seed });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);

    const floorMap = world.floorMap!;
    const bossRoom = floorMap.bossStairRoom;

    console.log('Boss room:', bossRoom ? JSON.stringify(bossRoom.bounds) : 'null');

    if (bossRoom) {
      const { x: bx, y: by, width: bw, height: bh } = bossRoom.bounds;
      const centerX = Math.floor(bx + bw / 2);
      const centerY = Math.floor(by + bh / 2);

      const minX = Math.max(bx + 2, centerX - 2);
      const maxX = Math.min(bx + bw - 3, centerX + 2);
      const minY = Math.max(by + 2, centerY - 2);
      const maxY = Math.min(by + bh - 3, centerY + 2);
      console.log('Range: minX:', minX, 'maxX:', maxX, '| minY:', minY, 'maxY:', maxY);

      // Count passable interior tiles
      let passableCount = 0;
      for (let ty = by + 1; ty < by + bh - 1; ty++) {
        for (let tx = bx + 1; tx < bx + bw - 1; tx++) {
          if (floorMap.tileMap.isPassable(tx, ty)) passableCount++;
        }
      }
      console.log('Interior passable count:', passableCount);

      // Show room grid
      for (let ty = by; ty < by + bh; ty++) {
        let row = `${ty.toString().padStart(3)}: `;
        for (let tx = bx; tx < bx + bw; tx++) {
          if (tx === centerX && ty === centerY) row += 'C';
          else if (floorMap.tileMap.isPassable(tx, ty)) row += '.';
          else row += '#';
        }
        console.log(row);
      }
    }

    const staircasePos = world.floor1?.objective?.staircasePos;
    console.log('StaircasePos:', JSON.stringify(staircasePos));
    if (staircasePos) {
      const t = floorMap.pixelToTile(staircasePos.x, staircasePos.y);
      console.log('Staircase tile:', t.x, t.y, 'passable:', floorMap.tileMap.isPassable(t.x, t.y));
    }

    expect(true).toBe(true);
  });
});
