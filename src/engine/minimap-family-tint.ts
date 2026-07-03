/**
 * Pure minimap tint helpers for Floor 2 (ADR 0040 · D8, FR20).
 *
 * `HudMinimap` calls these to color room markers / enemy dots by family. No
 * Phaser, no rendering — kept pure so band + role math can be unit-tested.
 */
import type { FamilyDef } from '../shared/data/families.js';
import { RoomRole, type RoomData } from '../shared/map-types.js';
import { type FamilyId, type FactionRelationsWorldFacet } from '../core/faction-relations.js';
import { bossDefeatedGoalFlag, parseHexColor } from './family-relationships-state.js';

/** Distinctive tints for non-territory Floor-2 room roles. */
export const SETTLEMENT_TINT = 0xf5c542; // warm gold
export const RESOURCE_HEART_TINT = 0xd946ef; // magenta
export const BOSS_DEN_OUTLINE = 0xdc2626; // fallback red when family unknown

/** Grayscale fallback for a family whose boss is dead. */
export const DEFEATED_TINT = 0x6b7280;

/** Roles the tint helper knows how to color. */
export type FamilyTintRole =
  | RoomRole.TERRITORY
  | RoomRole.BOSS_DEN
  | RoomRole.SETTLEMENT
  | RoomRole.RESOURCE_HEART;

/**
 * Look up a family by its index into `world.floor2State.presentFamilies`.
 * Returns `null` when the world isn't on Floor 2 or the index is out of bounds.
 */
export function resolveFamilyByIndex(
  world: FactionRelationsWorldFacet,
  families: readonly FamilyDef[],
  familyIndex: number | undefined,
): { id: FamilyId; def: FamilyDef } | null {
  const floor2 = world.floor2State;
  if (floor2 === null) return null;
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
 * Blend two colors channel-wise. `t` in `[0,1]` picks the ratio of `b` to mix
 * into `a` (0 → all `a`, 1 → all `b`).
 */
export function blendColors(a: number, b: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const rr = Math.round(ar + (br - ar) * clamped);
  const rg = Math.round(ag + (bg - ag) * clamped);
  const rb = Math.round(ab + (bb - ab) * clamped);
  return (rr << 16) | (rg << 8) | rb;
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
      if (!fam) return null;
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
