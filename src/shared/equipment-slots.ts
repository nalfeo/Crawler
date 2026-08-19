/**
 * Equipment slot definitions — the active persistence/runtime contract.
 * Retired slot ids must not be reintroduced without a schema migration.
 */

export interface SlotDefinition {
  readonly id: string;
  readonly label: string;
  readonly bodyGroup: string;
  readonly uiPosition: { readonly x: number; readonly y: number };
}

export const SLOT_REGISTRY: readonly SlotDefinition[] = [
  { id: 'head', label: 'Head', bodyGroup: 'head', uiPosition: { x: 0.5, y: 0.0 } },
  { id: 'neck', label: 'Neck', bodyGroup: 'torso', uiPosition: { x: 0.2, y: 0.0 } },
  { id: 'mainHand', label: 'Main Hand', bodyGroup: 'hands', uiPosition: { x: 0.2, y: 0.33 } },
  { id: 'chest', label: 'Chest', bodyGroup: 'torso', uiPosition: { x: 0.5, y: 0.33 } },
  { id: 'offHand', label: 'Off Hand', bodyGroup: 'hands', uiPosition: { x: 0.8, y: 0.33 } },
  { id: 'gloves', label: 'Gloves', bodyGroup: 'hands', uiPosition: { x: 0.2, y: 0.66 } },
  { id: 'legs', label: 'Legs', bodyGroup: 'legs', uiPosition: { x: 0.5, y: 0.66 } },
  { id: 'ring1', label: 'Ring 1', bodyGroup: 'hands', uiPosition: { x: 0.8, y: 0.66 } },
  { id: 'feet', label: 'Feet', bodyGroup: 'legs', uiPosition: { x: 0.35, y: 1.0 } },
  { id: 'ring2', label: 'Ring 2', bodyGroup: 'hands', uiPosition: { x: 0.65, y: 1.0 } },
] as const;

const SLOT_BY_ID: ReadonlyMap<string, SlotDefinition> = new Map(
  SLOT_REGISTRY.map((slot) => [slot.id, slot]),
);

/** Set of valid slot IDs for O(1) lookup. */
export const VALID_SLOT_IDS: ReadonlySet<string> = new Set(SLOT_REGISTRY.map((s) => s.id));
export const _VALID_SLOT_IDS_FOR_TESTS = VALID_SLOT_IDS;

/** Equipment slot identifier — validated against SLOT_REGISTRY at runtime. */
export type EquipmentSlotId = string;

export function isValidSlotId(id: string): boolean {
  return VALID_SLOT_IDS.has(id);
}

export function getSlotLabel(slotId: EquipmentSlotId): string {
  return SLOT_BY_ID.get(slotId)?.label ?? slotId;
}

/**
 * Left/right mirror-symmetric slot pairs. A real garment covers BOTH sides of
 * the body at once — a pair of bracers, arm wraps that go on both arms, a ring
 * that fits either hand — so a single equipment item is expected to carry both
 * slot ids rather than being split into a left item and a right item.
 *
 * `mainHand`/`offHand` are deliberately NOT a mirror pair: they are
 * functionally distinct hands (a weapon vs a shield), not the same garment
 * mirrored. `gloves` is already a single both-hands slot.
 *
 * This is inert metadata — the runtime equipment stack already supports
 * multi-slot items (an item's `slots` is an array). It exists so authoring
 * tooling can enforce "one unified item per mirror pair" from a single source
 * of truth colocated with `SLOT_REGISTRY`, and every id is guaranteed valid.
 */
export const MIRROR_SLOT_PAIRS: readonly (readonly [EquipmentSlotId, EquipmentSlotId])[] =
  [] as const;
export const _MIRROR_SLOT_PAIRS_FOR_TESTS = MIRROR_SLOT_PAIRS;

// Fail fast at module load if a pair ever names a slot that is not in the
// registry — keeps this table honest against SLOT_REGISTRY edits.
for (const [a, b] of MIRROR_SLOT_PAIRS) {
  if (!VALID_SLOT_IDS.has(a) || !VALID_SLOT_IDS.has(b)) {
    throw new Error(`MIRROR_SLOT_PAIRS references unknown slot id in pair [${a}, ${b}]`);
  }
}

const MIRROR_PARTNER_BY_ID: ReadonlyMap<EquipmentSlotId, EquipmentSlotId> = new Map(
  MIRROR_SLOT_PAIRS.flatMap(([a, b]) => [[a, b] as const, [b, a] as const]),
);

/** Set of every slot id that participates in a mirror pair, for O(1) lookup. */
export const MIRROR_SLOT_IDS: ReadonlySet<EquipmentSlotId> = new Set(MIRROR_PARTNER_BY_ID.keys());
export const _MIRROR_SLOT_IDS_FOR_TESTS = MIRROR_SLOT_IDS;

/**
 * The mirror partner of `slotId`, or `undefined` when the slot is not part of
 * a mirror pair. The ten-slot contract has no mirror pairs.
 */
export function getMirrorSlot(slotId: EquipmentSlotId): EquipmentSlotId | undefined {
  return MIRROR_PARTNER_BY_ID.get(slotId);
}

export const _getMirrorSlotForTests = getMirrorSlot;
