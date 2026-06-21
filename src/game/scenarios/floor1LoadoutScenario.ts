import type { GameWorld } from '../../core/world.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { type ModalPickerScenario } from '../../shared/modal-picker.js';
import { setActiveWeapon } from '../weaponSystem.js';

export type Floor1LoadoutChoiceId = 'sword' | 'bow' | 'baseball-bat';

export const DEFAULT_FLOOR1_LOADOUT_CHOICE: Floor1LoadoutChoiceId = 'sword';

const FLOOR1_LOADOUT_OPTIONS = [
  {
    id: 'sword',
    label: 'Blade Dancer',
    description: 'Sword: medium swing, speed, and damage for balanced melee control.',
  },
  {
    id: 'bow',
    label: 'Deadeye',
    description: 'Bow: slower, harder-hitting arrows that pierce one enemy.',
  },
  {
    id: 'baseball-bat',
    label: 'Cleanup Hitter',
    description: 'Baseball Bat: slow, wide swings with heavy knockback.',
  },
] as const;

function resolveFloor1LoadoutChoice(choiceId: string | undefined): Floor1LoadoutChoiceId {
  if (choiceId === 'sword' || choiceId === 'bow' || choiceId === 'baseball-bat') {
    return choiceId;
  }
  return DEFAULT_FLOOR1_LOADOUT_CHOICE;
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
  setActiveWeapon(world, weaponDef);
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
