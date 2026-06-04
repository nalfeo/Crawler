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

export const SLOT_REGISTRY: readonly SlotDefinition[] = [
  { id: 'head', label: 'Head', bodyGroup: 'head', uiPosition: { x: 0.5, y: 0.02 } },
  { id: 'face', label: 'Face', bodyGroup: 'head', uiPosition: { x: 0.25, y: 0.08 } },
  { id: 'neck', label: 'Neck', bodyGroup: 'torso', uiPosition: { x: 0.75, y: 0.08 } },
  { id: 'shoulders', label: 'Shoulders', bodyGroup: 'torso', uiPosition: { x: 0.5, y: 0.17 } },
  { id: 'chest', label: 'Chest', bodyGroup: 'torso', uiPosition: { x: 0.5, y: 0.28 } },
  { id: 'back', label: 'Back', bodyGroup: 'torso', uiPosition: { x: 0.12, y: 0.28 } },
  { id: 'arms', label: 'Arms', bodyGroup: 'arms', uiPosition: { x: 0.88, y: 0.28 } },
  { id: 'wrists', label: 'Wrists', bodyGroup: 'arms', uiPosition: { x: 0.88, y: 0.4 } },
  { id: 'gloves', label: 'Gloves', bodyGroup: 'hands', uiPosition: { x: 0.5, y: 0.52 } },
  { id: 'mainHand', label: 'Main Hand', bodyGroup: 'hands', uiPosition: { x: 0.08, y: 0.48 } },
  { id: 'offHand', label: 'Off Hand', bodyGroup: 'hands', uiPosition: { x: 0.92, y: 0.48 } },
  { id: 'ringLeft', label: 'Left Ring', bodyGroup: 'hands', uiPosition: { x: 0.2, y: 0.58 } },
  { id: 'ringRight', label: 'Right Ring', bodyGroup: 'hands', uiPosition: { x: 0.8, y: 0.58 } },
  { id: 'belt', label: 'Belt', bodyGroup: 'torso', uiPosition: { x: 0.5, y: 0.4 } },
  { id: 'legs', label: 'Legs', bodyGroup: 'legs', uiPosition: { x: 0.5, y: 0.7 } },
  { id: 'feet', label: 'Feet', bodyGroup: 'legs', uiPosition: { x: 0.5, y: 0.85 } },
] as const;

/** Set of valid slot IDs for O(1) lookup. */
export const VALID_SLOT_IDS: ReadonlySet<string> = new Set(SLOT_REGISTRY.map((s) => s.id));

/** Equipment slot identifier — validated against SLOT_REGISTRY at runtime. */
export type EquipmentSlotId = string;

export function isValidSlotId(id: string): boolean {
  return VALID_SLOT_IDS.has(id);
}
