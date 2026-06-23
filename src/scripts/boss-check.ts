import { DungeonGenerator } from '../core/map/generators/DungeonGenerator.js';
import { SeededRandom } from '../shared/random.js';
import { BiomeType, TileFlags, RoomRole } from '../shared/map-types.js';

const gen = new DungeonGenerator({ roomVariety: true });
const seed = 2;
const rng = new SeededRandom(seed);
const floor = gen.generate(
  {
    widthTiles: 120,
    heightTiles: 70,
    tileSizePx: 32,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed,
    roomWidthRange: [6, 14],
    roomHeightRange: [5, 13],
    maxRooms: 45,
    floorDensity: 0.42,
  },
  rng,
);

const w = floor.width;
for (const room of floor.rooms) {
  if (room.role !== RoomRole.BOSS_STAIR && room.role !== RoomRole.SAFE) continue;
  const { x, y, width, height } = room.bounds;
  const doorSet = new Set(room.doors.map((d: any) => `${d.x},${d.y}`));
  const breaches: string[] = [];
  for (let tx = x; tx < x + width; tx++) {
    for (const ty_ of [y, y + height - 1]) {
      const idx = ty_ * w + tx;
      const flags = floor.tileMap.flags[idx]!;
      const isPassable = (flags & TileFlags.PASSABLE) !== 0;
      const isDoor = (flags & TileFlags.DOOR) !== 0;
      if (isPassable && !isDoor && !doorSet.has(`${tx},${ty_}`)) {
        breaches.push(`(${tx},${ty_})`);
      }
    }
  }
  for (let ty = y + 1; ty < y + height - 1; ty++) {
    for (const tx_ of [x, x + width - 1]) {
      const idx = ty * w + tx_;
      const flags = floor.tileMap.flags[idx]!;
      const isPassable = (flags & TileFlags.PASSABLE) !== 0;
      const isDoor = (flags & TileFlags.DOOR) !== 0;
      if (isPassable && !isDoor && !doorSet.has(`${tx_},${ty}`)) {
        breaches.push(`(${tx_},${ty})`);
      }
    }
  }
  console.log(
    `${room.role} room bounds: x=${x},y=${y},w=${width},h=${height} (qualifies for shape: ${width >= 7 && height >= 7})`,
  );
  console.log(`  Doors: ${room.doors.map((d: any) => `(${d.x},${d.y})`).join(', ')}`);
  console.log(
    `  Breaches (passable non-door): ${breaches.length > 0 ? breaches.join(', ') : 'none'}`,
  );
}
