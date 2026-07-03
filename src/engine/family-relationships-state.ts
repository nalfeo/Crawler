/**
 * Pure resolver for the Floor-2 HUD family-relationships widget (ADR 0040 · D8,
 * FR20). Given `world` + the loaded family roster, produces one `FamilyRow` per
 * present family with the band, band color, boss-alive flag, and status tag.
 *
 * No Phaser, no rendering — this module exists so the band/status logic can be
 * unit-tested without mounting the widget.
 */
import type { FamilyDef } from '../shared/data/families.js';
import {
  bandFor,
  getRelation,
  type FactionBand,
  type FamilyId,
  type FactionRelationsWorldFacet,
} from '../core/faction-relations.js';

/** Numeric band colors used for the 0–100 bar fill in the widget. */
export const BAND_BAR_COLORS: Readonly<Record<FactionBand, number>> = Object.freeze({
  hate: 0x991b1b,
  hostile: 0xea580c,
  neutral: 0x475569,
  friendly: 0x22c55e,
});

/** Same colors as CSS-style hex strings — useful for tests + lab. */
export const BAND_BAR_COLORS_HEX: Readonly<Record<FactionBand, string>> = Object.freeze({
  hate: '#991b1b',
  hostile: '#ea580c',
  neutral: '#475569',
  friendly: '#22c55e',
});

/** Player-facing status tag shown on each row. */
export type FamilyStatusTag = 'Allied' | 'At War' | 'Neutral';

/** Map a band to the row's short status label (FR20). */
export function statusTagForBand(band: FactionBand): FamilyStatusTag {
  if (band === 'friendly') return 'Allied';
  if (band === 'hate' || band === 'hostile') return 'At War';
  return 'Neutral';
}

/** One row rendered by `HudFamilyRelationships`. */
export interface FamilyRow {
  familyId: FamilyId;
  name: string;
  /** Short label (`species`) shown when there's no room for the full name. */
  shortLabel: string;
  /** Family HUD color, parsed from `#RRGGBB` into a `0xRRGGBB` number. */
  hudColor: number;
  /** Relation value in `[0, 100]`. */
  relation: number;
  band: FactionBand;
  /** Bar fill color, keyed off `band`. */
  barColor: number;
  bossDefeated: boolean;
  statusTag: FamilyStatusTag;
}

/**
 * Build the goal-flag key that Slice 4's boss-den system flips when a family's
 * boss is defeated. Kept as a helper so the widget and Slice 4 stay in sync on
 * the exact string.
 */
export function bossDefeatedGoalFlag(familyId: FamilyId): string {
  return `floor2-family-${familyId}-boss-defeated`;
}

/** Parse a `#RRGGBB` string into a `0xRRGGBB` number. Returns `fallback` on invalid input. */
export function parseHexColor(hex: string, fallback = 0x64748b): number {
  if (typeof hex !== 'string') return fallback;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return fallback;
  return parseInt(m[1]!, 16);
}

/** Compute a single row from raw inputs. Pure — no world reads. */
export function familyRowFromRelation(
  family: FamilyDef,
  relation: number,
  bossDefeated: boolean,
): FamilyRow {
  const band = bandFor(relation);
  return {
    familyId: family.id as FamilyId,
    name: family.name,
    shortLabel: family.species,
    hudColor: parseHexColor(family.hudColor),
    relation,
    band,
    barColor: BAND_BAR_COLORS[band],
    bossDefeated,
    statusTag: statusTagForBand(band),
  };
}

/** Look up a family def by id from the loaded roster. */
function findFamilyDef(families: readonly FamilyDef[], id: FamilyId): FamilyDef | undefined {
  return families.find((f) => (f.id as FamilyId) === id);
}

/**
 * Resolve rows for every present family on the current floor. Returns an empty
 * array when the world isn't on Floor 2 (i.e. `floor2State === null`), so the
 * caller can hide the whole widget in one branch.
 */
export function resolveFamilyRows(
  world: FactionRelationsWorldFacet & { goalFlags: Map<string, boolean> },
  families: readonly FamilyDef[],
): FamilyRow[] {
  const floor2 = world.floor2State;
  if (floor2 === null) return [];
  const rows: FamilyRow[] = [];
  for (const familyId of floor2.presentFamilies) {
    const def = findFamilyDef(families, familyId);
    if (!def) continue;
    const relation = getRelation(world, familyId);
    const bossDefeated = world.goalFlags.get(bossDefeatedGoalFlag(familyId)) === true;
    rows.push(familyRowFromRelation(def, relation, bossDefeated));
  }
  return rows;
}
