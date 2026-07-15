import type { GameWorld } from '../../core/world.js';
import {
  getFloor1StarterWeaponPool,
  isFloor1ExperimentalStarterOptionsEnabled,
} from '../../shared/floor1-starter-weapons.js';
import { type ModalPickerScenario } from '../../shared/modal-picker.js';
import { getWeaponDef } from '../../shared/weaponDefs.js';
import { equipStarterOrFallback } from './starterWeaponEquip.js';

const BASE_FLOOR1_LOADOUT_OPTION_IDS = ['sword', 'bow', 'baseball-bat'] as const;

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
  {
    id: 'laser',
    label: 'Beam Breaker',
    description: 'Laser: sustained beam damage that melts anything holding a straight line.',
  },
  {
    id: 'punch',
    label: 'Bare Knuckles',
    description: 'Punch: fast close-range jabs for contestants who want to start scrapping now.',
  },
  {
    id: 'landmine',
    label: 'Area Denial',
    description: 'Landmine: plant explosive traps and make the room come to you.',
  },
] as const;

export type Floor1LoadoutChoiceId = (typeof FLOOR1_LOADOUT_OPTIONS)[number]['id'];

export const DEFAULT_FLOOR1_LOADOUT_CHOICE: Floor1LoadoutChoiceId = 'sword';

const FLOOR1_LOADOUT_CHOICE_IDS: readonly Floor1LoadoutChoiceId[] = FLOOR1_LOADOUT_OPTIONS.map(
  (option) => option.id,
);

/** The three canonical (non-experimental) starter options used for merchant stock. */
export const FLOOR1_BASE_LOADOUT_CHOICE_IDS: readonly Floor1LoadoutChoiceId[] = [
  'sword',
  'bow',
  'baseball-bat',
];

function isFloor1LoadoutChoiceId(choiceId: string | undefined): choiceId is Floor1LoadoutChoiceId {
  return (
    choiceId !== undefined && FLOOR1_LOADOUT_CHOICE_IDS.includes(choiceId as Floor1LoadoutChoiceId)
  );
}

function resolveFloor1LoadoutChoice(choiceId: string | undefined): Floor1LoadoutChoiceId {
  if (isFloor1LoadoutChoiceId(choiceId)) {
    return choiceId;
  }
  return DEFAULT_FLOOR1_LOADOUT_CHOICE;
}

const FLOOR1_LOADOUT_OPTIONS_BY_ID = Object.fromEntries(
  FLOOR1_LOADOUT_OPTIONS.map((opt) => [opt.id, opt]),
) as Record<Floor1LoadoutChoiceId, (typeof FLOOR1_LOADOUT_OPTIONS)[number]>;

function getFloor1LoadoutOptions(enableExperimental: boolean) {
  return getFloor1StarterWeaponPool(BASE_FLOOR1_LOADOUT_OPTION_IDS, {
    enableExperimental,
  })
    .filter((id): id is Floor1LoadoutChoiceId => id in FLOOR1_LOADOUT_OPTIONS_BY_ID)
    .map((id) => FLOOR1_LOADOUT_OPTIONS_BY_ID[id]);
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
  // Prefer the equipment-driven path so the chosen weapon lands in the
  // corresponding hand slot(s); falls back to setActiveWeapon when there's no
  // player, no equipment def, or equip() fails. Shared with
  // selectFloor1StarterWeapon so both loadout entry points stay in lockstep.
  equipStarterOrFallback(world, resolvedChoice, weaponDef);
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
    options: getFloor1LoadoutOptions(
      isFloor1ExperimentalStarterOptionsEnabled(
        typeof window !== 'undefined' ? window.location.search : undefined,
      ),
    ),
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
