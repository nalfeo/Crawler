/**
 * Equipment slot definitions — data-driven, append-only registry.
 * Adding a slot = append to SLOT_REGISTRY. No migration needed.
 */

export interface SlotDefinition {
  readonly id: string;
  readonly label: string;
  readonly bodyGroup: string;
  readonly uiPosition: { readonly x: number; readonly y: number };
}

// Paper-doll layout is a deterministic 6-row × 3-column lane grid.
//
// Columns are the left limb column (x 0.2), the central body spine (x 0.5), and
// the right limb column (x 0.8). Rows are evenly spaced lanes (y 0, 0.2, 0.4,
// 0.6, 0.8, 1.0). Because every slot lands on a fixed lane intersection, slot
// boxes are uniformly spaced and can never overlap regardless of slot size —
// paired slots (arms/wrists/hands/rings) stay row-aligned for body symmetry.
//
//   lane │ left (0.2)   center (0.5)  right (0.8)
//   ─────┼──────────────────────────────────────
//    0.0 │ neck         head          back
//    0.2 │ leftArm      face          rightArm
//    0.4 │ leftWrist    shoulders     rightWrist
//    0.6 │ mainHand     chest         offHand
//    0.8 │ gloves       legs          belt
//    1.0 │ ringLeft     feet          ringRight
export const SLOT_REGISTRY: readonly SlotDefinition[] = [
  { id: 'head', label: 'Head', bodyGroup: 'head', uiPosition: { x: 0.5, y: 0.0 } },
  { id: 'neck', label: 'Neck', bodyGroup: 'torso', uiPosition: { x: 0.2, y: 0.0 } },
  { id: 'back', label: 'Back', bodyGroup: 'torso', uiPosition: { x: 0.8, y: 0.0 } },
  { id: 'leftArm', label: 'L Arm', bodyGroup: 'arms', uiPosition: { x: 0.2, y: 0.2 } },
  { id: 'face', label: 'Face', bodyGroup: 'head', uiPosition: { x: 0.5, y: 0.2 } },
  { id: 'rightArm', label: 'R Arm', bodyGroup: 'arms', uiPosition: { x: 0.8, y: 0.2 } },
  { id: 'leftWrist', label: 'L Wrist', bodyGroup: 'arms', uiPosition: { x: 0.2, y: 0.4 } },
  { id: 'shoulders', label: 'Shoulders', bodyGroup: 'torso', uiPosition: { x: 0.5, y: 0.4 } },
  { id: 'rightWrist', label: 'R Wrist', bodyGroup: 'arms', uiPosition: { x: 0.8, y: 0.4 } },
  { id: 'mainHand', label: 'Main Hand', bodyGroup: 'hands', uiPosition: { x: 0.2, y: 0.6 } },
  { id: 'chest', label: 'Chest', bodyGroup: 'torso', uiPosition: { x: 0.5, y: 0.6 } },
  { id: 'offHand', label: 'Off Hand', bodyGroup: 'hands', uiPosition: { x: 0.8, y: 0.6 } },
  { id: 'gloves', label: 'Gloves', bodyGroup: 'hands', uiPosition: { x: 0.2, y: 0.8 } },
  { id: 'legs', label: 'Legs', bodyGroup: 'legs', uiPosition: { x: 0.5, y: 0.8 } },
  { id: 'belt', label: 'Belt', bodyGroup: 'torso', uiPosition: { x: 0.8, y: 0.8 } },
  { id: 'ringLeft', label: 'L Ring', bodyGroup: 'hands', uiPosition: { x: 0.2, y: 1.0 } },
  { id: 'feet', label: 'Feet', bodyGroup: 'legs', uiPosition: { x: 0.5, y: 1.0 } },
  { id: 'ringRight', label: 'R Ring', bodyGroup: 'hands', uiPosition: { x: 0.8, y: 1.0 } },
] as const;

const SLOT_BY_ID: ReadonlyMap<string, SlotDefinition> = new Map(
  SLOT_REGISTRY.map((slot) => [slot.id, slot]),
);

/** Set of valid slot IDs for O(1) lookup. */
export const VALID_SLOT_IDS: ReadonlySet<string> = new Set(SLOT_REGISTRY.map((s) => s.id));

/** Equipment slot identifier — validated against SLOT_REGISTRY at runtime. */
export type EquipmentSlotId = string;

export function isValidSlotId(id: string): boolean {
  return VALID_SLOT_IDS.has(id);
}

export function getSlotLabel(slotId: EquipmentSlotId): string {
  return SLOT_BY_ID.get(slotId)?.label ?? slotId;
}
