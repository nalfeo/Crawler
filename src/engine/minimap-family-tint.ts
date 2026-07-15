/**
 * Pure minimap tint helpers for Floor 2 (ADR 0040 · D8, FR20).
 *
 * `HudMinimap` calls these to color room markers / enemy dots by family. No
 * Phaser, no rendering — kept pure so band + role math can be unit-tested.
 */
import type { FamilyDef } from '../shared/data/families.js';
import { RoomRole, type RoomData, type TerritoryZone } from '../shared/map-types.js';
import { type FamilyId, type FactionRelationsWorldFacet } from '../core/faction-relations.js';
import { bossDefeatedGoalFlag, parseHexColor } from './family-relationships-state.js';

/** Distinctive tints for non-territory Floor-2 room roles. */
export const SETTLEMENT_TINT = 0xf5c542; // warm gold
export const RESOURCE_HEART_TINT = 0xd946ef; // magenta
export const BOSS_DEN_OUTLINE = 0xdc2626; // fallback red when family unknown

/**
 * Neutral tint for a TERRITORY room whose family index is missing/invalid.
 * Returning this (instead of `null`) keeps the room marker on the minimap
 * rather than dropping it entirely when `RoomData.familyIndex` is unset.
 */
export const TERRITORY_NEUTRAL_TINT = 0x6b7280; // slate gray
export const TERRITORY_OVERLAY_ALPHA = 0.42;

/** Roles the tint helper knows how to color. */
export type FamilyTintRole =
  | RoomRole.TERRITORY
  | RoomRole.BOSS_DEN
  | RoomRole.SETTLEMENT
  | RoomRole.RESOURCE_HEART;

/**
 * Look up a family by its index into `world.floorExtendedState?.familyState?.presentFamilies`.
 * Returns `null` when the world isn't on Floor 2 or the index is out of bounds.
 */
export function resolveFamilyByIndex(
  world: FactionRelationsWorldFacet,
  families: readonly FamilyDef[],
  familyIndex: number | undefined,
): { id: FamilyId; def: FamilyDef } | null {
  const floor2 = world.floorExtendedState?.familyState;
  if (!floor2) return null;
  if (typeof familyIndex !== 'number' || familyIndex < 0) return null;
  if (familyIndex >= floor2.presentFamilies.length) return null;
  const id = floor2.presentFamilies[familyIndex]!;
  const def = families.find((f) => (f.id as FamilyId) === id);
  if (!def) return null;
  return { id, def };
}

/** True if the family's boss has been defeated (goal flag set). */
export function isFamilyBossDefeated(
  world: FactionRelationsWorldFacet & { goalFlags: Map<string, boolean> },
  familyId: FamilyId,
): boolean {
  return world.goalFlags.get(bossDefeatedGoalFlag(familyId)) === true;
}

/** Convert a 0xRRGGBB color to its grayscale equivalent (Rec. 709 luma). */
export function toGrayscale(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return (y << 16) | (y << 8) | y;
}

/**
 * Pick the minimap tint for a Floor-2 room. Returns `null` for roles that
 * aren't part of the family palette (SPAWN/SAFE/BOSS_STAIR/NORMAL) so the
 * caller can fall through to the classic accent palette.
 */
export function familyTintForRoom(
  world: FactionRelationsWorldFacet & { goalFlags: Map<string, boolean> },
  families: readonly FamilyDef[],
  room: Pick<RoomData, 'role' | 'familyIndex'>,
): number | null {
  switch (room.role) {
    case RoomRole.SETTLEMENT:
      return SETTLEMENT_TINT;
    case RoomRole.RESOURCE_HEART:
      return RESOURCE_HEART_TINT;
    case RoomRole.TERRITORY: {
      const fam = resolveFamilyByIndex(world, families, room.familyIndex);
      if (!fam) return TERRITORY_NEUTRAL_TINT;
      const base = parseHexColor(fam.def.hudColor);
      return isFamilyBossDefeated(world, fam.id) ? toGrayscale(base) : base;
    }

    case RoomRole.BOSS_DEN: {
      const fam = resolveFamilyByIndex(world, families, room.familyIndex);
      if (!fam) return BOSS_DEN_OUTLINE;
      const base = parseHexColor(fam.def.hudColor);
      return isFamilyBossDefeated(world, fam.id) ? toGrayscale(base) : base;
    }
    default:
      return null;
  }
}

/**
 * Return every family tint influencing a map tile, ordered by family index.
 * Multiple colors are retained so the minimap can display overlap without
 * collapsing it into an ambiguous blended color.
 */
export function territoryTintsForTile(
  world: FactionRelationsWorldFacet & { goalFlags: Map<string, boolean> },
  families: readonly FamilyDef[],
  zones: readonly TerritoryZone[],
  tileX: number,
  tileY: number,
): readonly number[] {
  const tintByFamilyIndex = new Map<number, number>();
  for (const zone of zones) {
    const dx = tileX - zone.centerX;
    const dy = tileY - zone.centerY;
    if (dx * dx + dy * dy > zone.radius * zone.radius) {
      continue;
    }
    const family = resolveFamilyByIndex(world, families, zone.familyIndex);
    if (!family) {
      continue;
    }
    const base = parseHexColor(family.def.hudColor);
    tintByFamilyIndex.set(
      zone.familyIndex,
      isFamilyBossDefeated(world, family.id) ? toGrayscale(base) : base,
    );
  }
  return [...tintByFamilyIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, tint]) => tint);
}

/**
 * Pick the enemy-dot color for a mob with `FamilyMembership`. Returns `null`
 * when the family index is missing/invalid so the caller falls back to the
 * classic red enemy dot.
 */
export function familyColorForEnemy(
  world: FactionRelationsWorldFacet,
  families: readonly FamilyDef[],
  familyIndex: number | undefined,
): number | null {
  const fam = resolveFamilyByIndex(world, families, familyIndex);
  if (!fam) return null;
  return parseHexColor(fam.def.hudColor);
}
