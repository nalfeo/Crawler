import { describe, expect, it } from 'vitest';
import {
  shouldDrawTerritoryOverlayBands,
  shouldUseFamilyRoomTint,
} from '../../src/engine/minimap-territory-guards.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import type { GameWorld } from '../../src/core/world.js';
import { RoomRole } from '../../src/shared/map-types.js';

describe('HudMinimap docked radar territory overlay guard', () => {
  it('skips family-palette room marker work on floors without family state', () => {
    expect(shouldUseFamilyRoomTint({ role: RoomRole.SAFE }, { floorExtendedState: null })).toBe(
      false,
    );
    expect(
      shouldUseFamilyRoomTint({ role: RoomRole.SAFE }, {
        floorExtendedState: { familyState: null },
      } as unknown as Pick<GameWorld, 'floorExtendedState'>),
    ).toBe(false);
    expect(
      shouldUseFamilyRoomTint({ role: RoomRole.SAFE }, {
        floorExtendedState: { familyState: {} },
      } as Pick<GameWorld, 'floorExtendedState'>),
    ).toBe(true);
    expect(
      shouldUseFamilyRoomTint({ role: RoomRole.TERRITORY }, { floorExtendedState: null }),
    ).toBe(true);
    expect(shouldUseFamilyRoomTint({ role: RoomRole.BOSS_DEN }, { floorExtendedState: null })).toBe(
      true,
    );
    expect(
      shouldUseFamilyRoomTint({ role: RoomRole.SETTLEMENT }, { floorExtendedState: null }),
    ).toBe(true);
    expect(
      shouldUseFamilyRoomTint({ role: RoomRole.RESOURCE_HEART }, { floorExtendedState: null }),
    ).toBe(true);
  });

  it('skips territory tint work on floors without territory zones', () => {
    expect(shouldDrawTerritoryOverlayBands({ territoryZones: [] })).toBe(false);
    expect(
      shouldDrawTerritoryOverlayBands({
        territoryZones: [{ familyIndex: 0, centerX: 1, centerY: 2, radius: 3 }],
      } as Pick<FloorMap, 'territoryZones'>),
    ).toBe(true);
  });
});
