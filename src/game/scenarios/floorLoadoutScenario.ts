import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import { equip, unequip } from '../../core/systems/equipmentSystem.js';
import type { GameWorld } from '../../core/world.js';
import { getEquipmentDefForStarterWeapon } from '../../shared/equipmentDefs.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { type ModalPickerScenario } from '../../shared/modal-picker.js';
import { setActiveWeapon } from '../weaponSystem.js';

export type Floor1LoadoutChoiceId = 'sword' | 'bow' | 'baseball-bat';

export const DEFAULT_FLOOR1_LOADOUT_CHOICE: Floor1LoadoutChoiceId = 'sword';

const FLOOR1_LOADOUT_OPTIONS = [
  {
    id: 'sword',
    label: 'Blade Dancer',
    description: 'Sword: reliable mid-range cleave with balanced speed and damage.',
  },
  {
    id: 'bow',
    label: 'Sharpshooter',
    description: 'Bow: slow but hard-hitting arrow that punches through one enemy.',
  },
  {
    id: 'baseball-bat',
    label: 'Crowd Control',
    description: 'Baseball Bat: wide slow swing that launches enemies across the room.',
  },
] as const;

function resolveFloor1LoadoutChoice(choiceId: string | undefined): Floor1LoadoutChoiceId {
  if (choiceId === 'sword' || choiceId === 'bow' || choiceId === 'baseball-bat') {
    return choiceId;
  }
  return DEFAULT_FLOOR1_LOADOUT_CHOICE;
}

function findPlayerEid(world: GameWorld): number | undefined {
  return query(world.ecs, [Player])[0];
}

export function applyFloor1LoadoutChoice(
  world: GameWorld,
  choiceId: string | undefined,
): Floor1LoadoutChoiceId {
  const resolvedChoice = resolveFloor1LoadoutChoice(choiceId);
  const weaponDef = getWeaponDef(resolvedChoice) ?? getWeaponDef(DEFAULT_FLOOR1_LOADOUT_CHOICE);
  if (!weaponDef) {
    throw new Error(`Missing weapon definition for floor 1 loadout: ${resolvedChoice}`);
  }
  // Prefer the equipment-driven path so the chosen weapon lives in the
  // corresponding hand slot(s). Falls back to a raw setActiveWeapon when
  // there's no player entity, when the starter has no equipment def
  // registered, or when equip() fails (e.g. hand slot occupied by a
  // previous run's leftover); the fallback keeps combat working while a
  // downstream cleanup handles the equipment desync.
  const player = findPlayerEid(world);
  const equipmentDef = getEquipmentDefForStarterWeapon(resolvedChoice);
  let equipped = false;
  if (player !== undefined && equipmentDef !== undefined) {
    // Clear any lingering hand-slot equipment first so re-initializing the
    // same world (dev tools, test harness, respawn) can't leave a stale
    // sword sitting in mainHand while the new starter routes through
    // setActiveWeapon only.
    unequip(world, player, 'mainHand', { force: true });
    unequip(world, player, 'offHand', { force: true });
    const result = equip(world, player, equipmentDef, { force: true });
    equipped = result.ok;
  }
  if (!equipped) {
    setActiveWeapon(world, weaponDef);
  }
  return resolvedChoice;
}

export function createFloor1LoadoutScenario(): ModalPickerScenario<
  Floor1LoadoutChoiceId,
  GameWorld
> {
  return {
    title: 'Choose your opening loadout',
    subtitle: 'Floor 1 starts as soon as you lock this in.',
    body: 'Each starter weapon defines your early pacing. Pick one now and adapt on the fly.',
    options: FLOOR1_LOADOUT_OPTIONS,
    allowCancel: true,
    initialSelectedId: DEFAULT_FLOOR1_LOADOUT_CHOICE,
    defaultOptionId: DEFAULT_FLOOR1_LOADOUT_CHOICE,
    onConfirm: (world, optionId) => {
      applyFloor1LoadoutChoice(world, optionId);
    },
    onCancel: (world) => {
      applyFloor1LoadoutChoice(world, DEFAULT_FLOOR1_LOADOUT_CHOICE);
    },
  };
}
