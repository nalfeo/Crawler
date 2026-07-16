export type AbilityPresentationKind = 'active' | 'passive' | 'spell';
export type AbilityPresentationCategory = 'combat' | 'defense' | 'utility';

export interface AbilityPresentation {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly category: AbilityPresentationCategory;
  readonly kind: AbilityPresentationKind;
  readonly iconBriefId?: string;
  readonly cooldownFrames?: number;
}

export const ABILITY_PRESENTATION_BY_ID = {
  'battle-focus': {
    id: 'battle-focus',
    name: 'Battle Focus',
    shortLabel: 'FOCUS',
    description: 'Land enough hits to convert momentum into damage.',
    category: 'combat',
    kind: 'active',
    cooldownFrames: 30,
  },
  'veteran-instinct': {
    id: 'veteran-instinct',
    name: 'Veteran Instinct',
    shortLabel: 'VETERAN',
    description: 'Constant battlefield awareness improves your armor and pickup range.',
    category: 'defense',
    kind: 'passive',
  },
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    shortLabel: 'FIRE',
    description: 'Hurl a ball of fire that explodes in an area, burning enemies.',
    category: 'combat',
    kind: 'spell',
    iconBriefId: 'ability-icon-fireball-v1',
    cooldownFrames: 300,
  },
  heal: {
    id: 'heal',
    name: 'Heal',
    shortLabel: 'HEAL',
    description: 'Mend your wounds with restorative magic.',
    category: 'defense',
    kind: 'spell',
    iconBriefId: 'ability-icon-heal-v1',
    cooldownFrames: 1800,
  },
  'pulse-shield': {
    id: 'pulse-shield',
    name: 'Pulse Shield',
    shortLabel: 'PULSE',
    description: 'Release a protective shockwave that knocks back nearby enemies.',
    category: 'defense',
    kind: 'spell',
    iconBriefId: 'ability-icon-pulse-shield-v1',
    cooldownFrames: 1200,
  },
} as const satisfies Readonly<Record<string, AbilityPresentation>>;

export function getAbilityPresentation(id: string): AbilityPresentation | undefined {
  return (ABILITY_PRESENTATION_BY_ID as Readonly<Record<string, AbilityPresentation>>)[id];
}
