import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/shared/random';
import {
  BiomeType,
  TileFlags,
  TilePresets,
  TerrainType,
  RoomRole,
} from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';

const smallConfig = (): MapConfig => ({
  widthTiles: 60,
  heightTiles: 40,
  tileSizePx: 32,
  biome: BiomeType.BASIC_UNDERGROUND,
  seed: 42,
  roomWidthRange: [4, 8],
  roomHeightRange: [4, 8],
  maxRooms: 10,
  floorDensity: 0.3,
});

// Inline partial implementation to trace RNG consumption
describe('debug', () => {
  it('traces rng consumption for room shapes', () => {
    // Manually check what happens: read rng values for rooms 0,1,2,3,4...
    const rng = new SeededRandom(1);
    const rolls: number[] = [];
    // applyRoomShapes processes rooms in order; rooms with rw>=7 and rh>=7 consume a roll
    // Room 0: rw=6 (SKIP), Room 1: rw=9, rh=8 → roll, Room 2: rw=10, rh=9 → roll, etc.
    // Let's just record 18 rolls to cover all rooms
    for (let i = 0; i < 18; i++) rolls.push(rng.next());
    console.log('First 18 RNG values:', rolls.map((r, i) => `r${i}=${r.toFixed(3)}`).join(', '));
    // Room 1 → roll index 0 (rw=9>=7, rh=8>=7)
    // Room 2 → roll index 1 (rw=10>=7, rh=9>=7)
    console.log(
      'Roll for room 1 (index 0):',
      rolls[0]!.toFixed(3),
      '→',
      rolls[0]! < 0.25 ? 'ELLIPSE' : rolls[0]! < 0.5 ? 'L-SHAPE' : 'RECT',
    );
    console.log(
      'Roll for room 2 (index 1):',
      rolls[1]!.toFixed(3),
      '→',
      rolls[1]! < 0.25 ? 'ELLIPSE' : rolls[1]! < 0.5 ? 'L-SHAPE' : 'RECT',
    );

    // BUT if room 1 applied L-shape and called rng.nextInt for tie-breaking, the sequence shifts!
    // Need to check more carefully...
    expect(true).toBe(true);
  });
});
