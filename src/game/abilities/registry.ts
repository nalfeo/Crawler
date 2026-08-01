import { abilityCatalogSchema, type AbilityDefinition } from './types.js';
import { ABILITY_PRESENTATION_BY_ID } from '../../shared/ability-presentation.js';

const ABILITY_DEFINITIONS_RAW: AbilityDefinition[] = [
  {
    ...ABILITY_PRESENTATION_BY_ID['battle-focus'],
    trigger: { kind: 'skill_usage', metric: 'hits_landed', minAmount: 10 },
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['veteran-instinct'],
    effects: [
      { type: 'stat_add', stat: 'armor', value: 2 },
      { type: 'stat_add', stat: 'pickupRange', value: 0.75 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.fireball,
    trigger: { kind: 'enemy_cluster', minEnemies: 1, withinFeet: 6 },
    effects: [
      {
        type: 'spell_fireball',
        damage: { base: 15, scalesWithIntelligence: true },
        radiusTiles: { base: 3, scalesWithIntelligence: false },
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.heal,
    trigger: { kind: 'health_deficit_at_least', deficitAmount: 30 },
    effects: [{ type: 'spell_heal', heal: { base: 30, scalesWithIntelligence: true } }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['pulse-shield'],
    trigger: {
      kind: 'low_health_crowded',
      healthBelowRatio: 0.5,
      minEnemies: 3,
      withinFeet: 5,
    },
    effects: [
      {
        type: 'spell_pulse_shield',
        knockbackForce: { base: 1.0, scalesWithIntelligence: false },
        radiusTiles: { base: 4, scalesWithIntelligence: false },
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['magic-missile'],
    trigger: { kind: 'enemy_cluster', minEnemies: 1, withinFeet: 10 },
    effects: [
      {
        type: 'spell_magic_missile',
        damage: { base: 11, scalesWithIntelligence: true },
        rangeTiles: { base: 4, scalesWithIntelligence: false },
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['frost-nova'],
    trigger: { kind: 'enemy_cluster', minEnemies: 3, withinFeet: 5 },
    effects: [
      {
        type: 'spell_frost_nova',
        damage: { base: 10, scalesWithIntelligence: true },
        radiusTiles: { base: 3, scalesWithIntelligence: false },
        slowMultiplier: { base: 0.55, scalesWithIntelligence: false },
        slowDurationMs: { base: 3_000, scalesWithIntelligence: false },
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.bless,
    trigger: { kind: 'skill_usage', metric: 'weapon_fired', minAmount: 1 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: { base: 900, scalesWithIntelligence: false },
        vfxColor: 0xfef3c7,
        modifiers: [
          { stat: 'damage', op: 'add', value: { base: 4, scalesWithIntelligence: false } },
          { stat: 'accuracy', op: 'add', value: { base: 0.1, scalesWithIntelligence: false } },
          { stat: 'moveSpeed', op: 'add', value: { base: 0.05, scalesWithIntelligence: false } },
        ],
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.stoneskin,
    trigger: { kind: 'low_health', healthBelowRatio: 0.75 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: { base: 1_200, scalesWithIntelligence: false },
        vfxColor: 0x94a3b8,
        modifiers: [
          { stat: 'armor', op: 'add', value: { base: 4, scalesWithIntelligence: false } },
        ],
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.curse,
    trigger: { kind: 'enemy_cluster', minEnemies: 4, withinFeet: 8 },
    effects: [
      {
        type: 'spell_enemy_slow_burst',
        radiusTiles: { base: 4, scalesWithIntelligence: false },
        slowMultiplier: { base: 0.4, scalesWithIntelligence: false },
        slowDurationMs: { base: 3_600, scalesWithIntelligence: false },
        vfxColor: 0xa855f7,
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['vampiric-touch'],
    trigger: {
      kind: 'low_health_crowded',
      healthBelowRatio: 0.7,
      minEnemies: 1,
      withinFeet: 5,
    },
    effects: [
      {
        type: 'spell_life_drain',
        damage: { base: 12, scalesWithIntelligence: true },
        rangeTiles: { base: 3, scalesWithIntelligence: false },
        // Independent of the damage roll (not a percent-of-dealt heal): its own
        // authored base, scaled by the SAME INT rate so the 0.75 baseline
        // ratio to damage holds at every Intelligence investment.
        heal: { base: 9, scalesWithIntelligence: true },
      },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID.haste,
    trigger: { kind: 'skill_usage', metric: 'weapon_fired', minAmount: 1 },
    effects: [
      {
        type: 'spell_timed_buff',
        durationFrames: { base: 780, scalesWithIntelligence: false },
        vfxColor: 0x67e8f9,
        modifiers: [
          { stat: 'moveSpeed', op: 'add', value: { base: 0.125, scalesWithIntelligence: false } },
          {
            stat: 'projectileSpeed',
            op: 'add',
            value: { base: 50, scalesWithIntelligence: false },
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Level-5 skill unlock passives — general skills (no weapon prerequisite)
  // ---------------------------------------------------------------------------

  {
    ...ABILITY_PRESENTATION_BY_ID['combat-flow'],
    flavorText:
      '"Muscle memory is the cheapest upgrade. The dungeon always offers more." — The Director',
    effects: [
      { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      { type: 'stat_multiply', stat: 'attackSpeed', value: 0.05 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['stalwart-resolve'],
    flavorText:
      '"The ratings love a survivor. The dungeon loves a meal. You\'re both." — The Director',
    effects: [
      { type: 'stat_add', stat: 'armor', value: 3 },
      { type: 'stat_add', stat: 'maxHp', value: 15 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['ever-vigilant'],
    flavorText: '"Dodge. Roll. Repeat. The audience thinks it\'s choreography." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'moveSpeed', value: 0.15 }],
  },

  // ---------------------------------------------------------------------------
  // Level-5 skill unlock passives — weapon CLASS skills (require weapon class)
  // ---------------------------------------------------------------------------

  {
    ...ABILITY_PRESENTATION_BY_ID['blade-mastery'],
    weaponPrerequisite: 'slashing',
    flavorText: '"The Slashing arts are elegant, if you ignore all the blood." — The Director',
    effects: [
      { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      { type: 'stat_add', stat: 'accuracy', value: 0.05 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['vital-targeting'],
    weaponPrerequisite: 'stabbing',
    flavorText: '"The gap between ribs is a six-point rating bump." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['brute-force'],
    weaponPrerequisite: 'smashing',
    flavorText: '"Subtlety is for people who lack upper-body strength." — The Director',
    effects: [
      { type: 'stat_multiply', stat: 'damage', value: 0.15 },
      { type: 'stat_add', stat: 'armor', value: 2 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['marksmans-eye'],
    weaponPrerequisite: 'ranged',
    flavorText: '"The camera loves a player who never misses." — The Director',
    effects: [
      { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      { type: 'stat_multiply', stat: 'projectileSpeed', value: 0.1 },
    ],
  },
  {
    id: 'rapid-release',
    name: 'Rapid Release',
    shortLabel: 'RAPID',
    description:
      'Muscle memory for throwing sharpens your windup — bonus attack speed while a throwing weapon is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing',
    flavorText: '"Speed kills. The Director kills slowly for ratings." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.2 }],
  },
  {
    id: 'iron-resolve',
    name: 'Iron Resolve',
    shortLabel: 'IRON',
    description:
      'Fighting bare-handed builds raw power — bonus damage while a forearms weapon is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'forearms',
    flavorText: '"Hands are the original weapons. Everything else is an accessory." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'arcane-efficiency',
    name: 'Arcane Efficiency',
    shortLabel: 'ARCANE',
    description:
      'Arcane discipline sharpens with practice — bonus damage while an arcane weapon is equipped.',
    category: 'utility',
    kind: 'passive',
    weaponPrerequisite: 'arcane',
    flavorText: '"Magic is just science the audience doesn\'t understand yet." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },

  // ---------------------------------------------------------------------------
  // Level-5 skill unlock passives — weapon TYPE skills (require weapon type)
  // ---------------------------------------------------------------------------

  {
    id: 'keen-swordsman',
    name: 'Keen Swordsman',
    shortLabel: 'KEEN',
    description:
      'Sword technique refines into precision — bonus accuracy and damage while a sword is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'sword',
    flavorText:
      '"A good blade is only as sharp as its wielder. You\'re... getting there." — The Director',
    effects: [
      { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      { type: 'stat_multiply', stat: 'damage', value: 0.08 },
    ],
  },
  {
    id: 'shadowblade',
    name: 'Shadowblade',
    shortLabel: 'SHADOW',
    description:
      'Dagger mastery exploits blind spots — significant damage bonus while a dagger is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'dagger',
    flavorText:
      '"The audience sees what they\'re meant to see. The blade does the rest." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.2 }],
  },
  {
    id: 'crushing-momentum',
    name: 'Crushing Momentum',
    shortLabel: 'CRUSH',
    description: 'Hammer swings build inertia — bonus damage while a hammer is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'hammer',
    flavorText: '"The hammer doesn\'t ask why. Neither should you." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'athletes-grit',
    name: "Athlete's Grit",
    shortLabel: 'GRIT',
    description:
      'Sporting form builds toughness — bonus accuracy and armor while sports equipment is equipped.',
    category: 'defense',
    kind: 'passive',
    weaponPrerequisite: 'sports-equipment',
    flavorText:
      '"The crowd goes wild for a competitor with heart. Also with blood. Mostly blood." — The Director',
    effects: [
      { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      { type: 'stat_add', stat: 'armor', value: 2 },
    ],
  },
  {
    id: 'archers-stance',
    name: "Archer's Stance",
    shortLabel: 'ARCHER',
    description: 'Practiced bow form steadies your aim — bonus accuracy while a bow is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'bow',
    flavorText:
      '"The arrow knows the target before the archer does. Trust the form." — The Director',
    effects: [{ type: 'stat_add', stat: 'accuracy', value: 0.1 }],
  },
  {
    id: 'precision-bolts',
    name: 'Precision Bolts',
    shortLabel: 'PRECISE',
    description:
      'Crossbow expertise translates to harder-hitting shots — bonus damage while a crossbow is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'crossbow',
    flavorText:
      '"Mechanical advantage. The Director is a fan of mechanical advantage." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'hair-trigger',
    name: 'Hair Trigger',
    shortLabel: 'TRIGGER',
    description:
      'Pistol familiarity speeds your draw — bonus attack speed while a pistol is equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'pistol',
    flavorText: '"Fast draw is great television. Slow draw is a corpse." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.2 }],
  },
  {
    id: 'juggling-arsenal',
    name: 'Juggling Arsenal',
    shortLabel: 'JUGGLE',
    description:
      'Expert throwing technique enables multi-projectile salvos while throwing weapons are equipped.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing-weapons',
    flavorText:
      '"One throw per enemy is boring. The audience expects at least three." — The Director',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'bare-knuckle',
    name: 'Bare Knuckle',
    shortLabel: 'KNUCKLE',
    description:
      'Years of fighting empty-handed concentrate force into raw power — bonus damage while unarmed.',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'unarmed',
    flavorText: '"No weapon. No problem. The ratings find it primal." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'arcane-attunement',
    name: 'Arcane Attunement',
    shortLabel: 'ARCANE',
    description:
      'Spellcraft mastery deepens magical resonance — bonus damage while a spellcraft weapon is equipped.',
    category: 'utility',
    kind: 'passive',
    weaponPrerequisite: 'spellcraft',
    flavorText:
      '"Magic is the only force the dungeon respects. You\'re learning the language." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },

  // ---------------------------------------------------------------------------
  // Evolved weapon class passives (L15 replacements for L5)
  // ---------------------------------------------------------------------------

  {
    ...ABILITY_PRESENTATION_BY_ID['slashing-mastery-evolved'],
    weaponPrerequisite: 'slashing',
    flavorText: '"Evolution is natural. Survival is not." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['stabbing-precision-evolved'],
    weaponPrerequisite: 'stabbing',
    flavorText: '"Speed is the ultimate weapon. Everything else is circumstance." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['smashing-force-evolved'],
    weaponPrerequisite: 'smashing',
    flavorText: '"Raw power is honest. The audience respects honesty." — The Director',
    effects: [
      { type: 'stat_add', stat: 'pickupRange', value: 1.0 },
      { type: 'stat_multiply', stat: 'damage', value: 0.08 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['ranged-marksmanship-evolved'],
    weaponPrerequisite: 'ranged',
    flavorText: '"Expert marksmanship turns chaos into choreography." — The Director',
    effects: [
      { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      { type: 'stat_multiply', stat: 'projectileSpeed', value: 0.15 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['throwing-trajectory-evolved'],
    weaponPrerequisite: 'throwing',
    flavorText: '"A perfect throw is like a perfect scene — timed to the frame." — The Director',
    effects: [{ type: 'stat_multiply', stat: 'projectileSpeed', value: 0.15 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['forearms-brawler-evolved'],
    weaponPrerequisite: 'forearms',
    flavorText: '"The best fighters move by instinct. You\'re getting there." — The Director',
    effects: [
      { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      { type: 'stat_multiply', stat: 'damage', value: 0.08 },
    ],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['arcane-power-evolved'],
    weaponPrerequisite: 'arcane',
    flavorText: '"The arcane does not forgive amateurs. You are no longer one." — The Director',
    effects: [
      { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      { type: 'stat_multiply', stat: 'damage', value: 0.08 },
    ],
  },

  // ─── Placeholder generic abilities for L10/L15/L20 milestones ──────────────────
  {
    ...ABILITY_PRESENTATION_BY_ID['placeholder-generic-l10'],
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['placeholder-generic-l15'],
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    ...ABILITY_PRESENTATION_BY_ID['placeholder-generic-l20'],
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },

  // ─── Weapon class ability L5/L10/L15/L20 milestones ─────────────────────────────
  // Slashing weapon class
  {
    id: 'slashing-mastery-base',
    name: 'Slashing Mastery',
    shortLabel: 'SLASH',
    description: '+10% damage with slashing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'slashing',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'slashing-momentum',
    name: 'Slashing Momentum',
    shortLabel: 'MOMENTUM',
    description: '+1 extra projectile with slashing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'slashing',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'stabbing-precision-base',
    name: 'Stabbing Precision',
    shortLabel: 'PREC',
    description: '+15% attack speed with stabbing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'stabbing',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    id: 'stabbing-tempo',
    name: 'Stabbing Tempo',
    shortLabel: 'TEMPO',
    description: '+1 extra projectile with stabbing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'stabbing',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'smashing-impact-base',
    name: 'Smashing Impact',
    shortLabel: 'IMPACT',
    description: '+10% damage with smashing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'smashing',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'smashing-momentum',
    name: 'Smashing Momentum',
    shortLabel: 'MOMENTUM',
    description: '+1 extra projectile with smashing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'smashing',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'ranged-accuracy-base',
    name: 'Ranged Accuracy',
    shortLabel: 'ACCURATE',
    description: '+10% damage with ranged weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'ranged',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'ranged-barrage',
    name: 'Ranged Barrage',
    shortLabel: 'BARRAGE',
    description: '+1 extra projectile with ranged weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'ranged',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'throwing-precision-base',
    name: 'Throwing Precision',
    shortLabel: 'PREC',
    description: '+10% damage with throwing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'throwing-velocity-evolved',
    name: 'Throwing Velocity (Evolved)',
    shortLabel: 'VEL+',
    description: 'Advanced throwing trajectory',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing',
    effects: [{ type: 'stat_multiply', stat: 'projectileSpeed', value: 0.15 }],
  },
  {
    id: 'forearms-brawl-base',
    name: 'Forearms Brawl',
    shortLabel: 'BRAWL',
    description: '+15% attack speed with forearms',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'forearms',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    id: 'forearms-combo-evolved',
    name: 'Forearms Combo (Evolved)',
    shortLabel: 'COMBO+',
    description: 'Advanced combo technique',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'forearms',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.25 }],
  },

  // ─── Weapon type active abilities (L5/L10/L15/L20 milestones) ────────────────
  // Sword type abilities
  {
    id: 'sword-strike-base',
    name: 'Sword Strike',
    shortLabel: 'STRIKE',
    description: 'Basic sword attack',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'sword-cleave',
    name: 'Sword Cleave',
    shortLabel: 'CLEAVE',
    description: 'Powerful cleave attack',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'sword-strike-evolved',
    name: 'Sword Strike (Evolved)',
    shortLabel: 'STRIKE+',
    description: 'Evolved sword strike',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'sword-cleave-evolved',
    name: 'Sword Cleave (Evolved)',
    shortLabel: 'CLEAVE+',
    description: 'Evolved cleave attack',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // Dagger type abilities
  {
    id: 'dagger-rapid-strike-base',
    name: 'Dagger Rapid Strike',
    shortLabel: 'RAPID',
    description: 'Fast dagger strikes',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'dagger-flurry',
    name: 'Dagger Flurry',
    shortLabel: 'FLURRY',
    description: 'Multiple rapid strikes',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    id: 'dagger-rapid-strike-evolved',
    name: 'Dagger Rapid Strike (Evolved)',
    shortLabel: 'RAPID+',
    description: 'Evolved rapid strikes',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'dagger-flurry-evolved',
    name: 'Dagger Flurry (Evolved)',
    shortLabel: 'FLURRY+',
    description: 'Evolved flurry attack',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.25 }],
  },

  // Hammer type abilities
  {
    id: 'hammer-crush-base',
    name: 'Hammer Crush',
    shortLabel: 'CRUSH',
    description: 'Crushing hammer blow',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'hammer-shatter',
    name: 'Hammer Shatter',
    shortLabel: 'SHATTER',
    description: 'Shattering blow',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'hammer-crush-evolved',
    name: 'Hammer Crush (Evolved)',
    shortLabel: 'CRUSH+',
    description: 'Evolved crush attack',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'hammer-shatter-evolved',
    name: 'Hammer Shatter (Evolved)',
    shortLabel: 'SHATTER+',
    description: 'Evolved shatter attack',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // Bow type abilities
  {
    id: 'bow-shot-base',
    name: 'Bow Shot',
    shortLabel: 'SHOT',
    description: 'Basic bow attack',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'bow-piercing',
    name: 'Bow Piercing',
    shortLabel: 'PIERCE',
    description: 'Piercing bow shot',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'bow-shot-evolved',
    name: 'Bow Shot (Evolved)',
    shortLabel: 'SHOT+',
    description: 'Evolved bow shot',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'bow-piercing-evolved',
    name: 'Bow Piercing (Evolved)',
    shortLabel: 'PIERCE+',
    description: 'Evolved piercing shot',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.2 }],
  },

  // Crossbow type abilities
  {
    id: 'crossbow-bolt-base',
    name: 'Crossbow Bolt',
    shortLabel: 'BOLT',
    description: 'Basic crossbow bolt',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'crossbow-barrage',
    name: 'Crossbow Barrage',
    shortLabel: 'BARRAGE',
    description: 'Rapid crossbow fire',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    id: 'crossbow-bolt-evolved',
    name: 'Crossbow Bolt (Evolved)',
    shortLabel: 'BOLT+',
    description: 'Evolved crossbow bolt',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'crossbow-barrage-evolved',
    name: 'Crossbow Barrage (Evolved)',
    shortLabel: 'BARRAGE+',
    description: 'Evolved rapid fire',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.25 }],
  },

  // Pistol type abilities
  {
    id: 'pistol-shot-base',
    name: 'Pistol Shot',
    shortLabel: 'SHOT',
    description: 'Basic pistol shot',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'pistol-volley',
    name: 'Pistol Volley',
    shortLabel: 'VOLLEY',
    description: 'Rapid pistol fire',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    id: 'pistol-shot-evolved',
    name: 'Pistol Shot (Evolved)',
    shortLabel: 'SHOT+',
    description: 'Evolved pistol shot',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'pistol-volley-evolved',
    name: 'Pistol Volley (Evolved)',
    shortLabel: 'VOLLEY+',
    description: 'Evolved rapid fire',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.25 }],
  },

  // Unarmed type abilities
  {
    id: 'unarmed-punch-base',
    name: 'Unarmed Punch',
    shortLabel: 'PUNCH',
    description: 'Basic punch',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'unarmed-barrage',
    name: 'Unarmed Barrage',
    shortLabel: 'BARRAGE',
    description: 'Rapid punches',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    id: 'unarmed-punch-evolved',
    name: 'Unarmed Punch (Evolved)',
    shortLabel: 'PUNCH+',
    description: 'Evolved punch',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'unarmed-barrage-evolved',
    name: 'Unarmed Barrage (Evolved)',
    shortLabel: 'BARRAGE+',
    description: 'Evolved barrage',
    category: 'combat',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.25 }],
  },

  // Spellcraft type abilities
  {
    id: 'spellcraft-bolt-base',
    name: 'Spellcraft Bolt',
    shortLabel: 'BOLT',
    description: 'Basic spell bolt',
    category: 'utility',
    kind: 'passive',
    effects: [{ type: 'stat_add', stat: 'damage', value: 0 }],
  },
  {
    id: 'spellcraft-cascade',
    name: 'Spellcraft Cascade',
    shortLabel: 'CASCADE',
    description: 'Multiple bolts',
    category: 'utility',
    kind: 'passive',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'spellcraft-bolt-evolved',
    name: 'Spellcraft Bolt (Evolved)',
    shortLabel: 'BOLT+',
    description: 'Evolved spell bolt',
    category: 'utility',
    kind: 'passive',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'spellcraft-cascade-evolved',
    name: 'Spellcraft Cascade (Evolved)',
    shortLabel: 'CASCADE+',
    description: 'Evolved cascade',
    category: 'utility',
    kind: 'passive',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // ─── Missing evolved / L10 abilities for weapon class skills ────────────────

  // Slashing
  {
    id: 'slashing-momentum-evolved',
    name: 'Slashing Momentum (Evolved)',
    shortLabel: 'MOMTM+',
    description: '+2 extra projectiles with slashing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'slashing',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // Stabbing
  {
    id: 'stabbing-tempo-evolved',
    name: 'Stabbing Tempo (Evolved)',
    shortLabel: 'TEMPO+',
    description: '+2 extra projectiles with stabbing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'stabbing',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // Smashing
  {
    id: 'smashing-impact-evolved',
    name: 'Smashing Impact (Evolved)',
    shortLabel: 'IMPACT+',
    description: '+15% damage with smashing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'smashing',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'smashing-momentum-evolved',
    name: 'Smashing Momentum (Evolved)',
    shortLabel: 'SMSH-M+',
    description: '+2 extra projectiles with smashing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'smashing',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // Ranged
  {
    id: 'ranged-accuracy-evolved',
    name: 'Ranged Accuracy (Evolved)',
    shortLabel: 'ACCRT+',
    description: '+15% damage with ranged weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'ranged',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'ranged-barrage-evolved',
    name: 'Ranged Barrage (Evolved)',
    shortLabel: 'BARRAGE+',
    description: '+2 extra projectiles with ranged weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'ranged',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // Throwing class
  {
    id: 'throwing-velocity',
    name: 'Throwing Velocity',
    shortLabel: 'VEL',
    description: '+10% projectile speed with throwing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing',
    effects: [{ type: 'stat_multiply', stat: 'projectileSpeed', value: 0.1 }],
  },
  {
    id: 'throwing-precision-evolved',
    name: 'Throwing Precision (Evolved)',
    shortLabel: 'PREC+',
    description: '+15% damage with throwing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },

  // Forearms class
  {
    id: 'forearms-combo',
    name: 'Forearms Combo',
    shortLabel: 'COMBO',
    description: '+15% attack speed with forearms weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'forearms',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 }],
  },
  {
    id: 'forearms-brawl-evolved',
    name: 'Forearms Brawl (Evolved)',
    shortLabel: 'BRAWL+',
    description: '+25% attack speed with forearms weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'forearms',
    effects: [{ type: 'stat_multiply', stat: 'attackSpeed', value: 0.25 }],
  },

  // Arcane class
  {
    id: 'arcane-mastery-base',
    name: 'Arcane Mastery',
    shortLabel: 'ARCANE',
    description: '+10% damage with arcane weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'arcane',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'arcane-mastery-evolved',
    name: 'Arcane Mastery (Evolved)',
    shortLabel: 'ARCANE+',
    description: '+15% damage with arcane weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'arcane',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
  {
    id: 'arcane-efficiency-evolved',
    name: 'Arcane Efficiency (Evolved)',
    shortLabel: 'EFFIC+',
    description: '+15% damage with arcane weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'arcane',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },

  // ─── Throwing Weapons type abilities ────────────────────────────────────────
  {
    id: 'throwingweapons-toss-base',
    name: 'Throwing Weapons Toss',
    shortLabel: 'TOSS',
    description: '+0.1 accuracy with throwing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing-weapons',
    effects: [{ type: 'stat_add', stat: 'accuracy', value: 0.1 }],
  },
  {
    id: 'throwingweapons-salvo',
    name: 'Throwing Weapons Salvo',
    shortLabel: 'SALVO',
    description: '+1 extra projectile with throwing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing-weapons',
    effects: [{ type: 'extra_projectile', count: 1 }],
  },
  {
    id: 'throwingweapons-toss-evolved',
    name: 'Throwing Weapons Toss (Evolved)',
    shortLabel: 'TOSS+',
    description: '+0.2 accuracy with throwing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing-weapons',
    effects: [{ type: 'stat_add', stat: 'accuracy', value: 0.2 }],
  },
  {
    id: 'throwingweapons-salvo-evolved',
    name: 'Throwing Weapons Salvo (Evolved)',
    shortLabel: 'SALVO+',
    description: '+2 extra projectiles with throwing weapons',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'throwing-weapons',
    effects: [{ type: 'extra_projectile', count: 2 }],
  },

  // ─── Sports Equipment type abilities ────────────────────────────────────────
  {
    id: 'sportsequipment-swing-base',
    name: 'Sports Equipment Swing',
    shortLabel: 'SWING',
    description: '+0.1 accuracy with sports equipment',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'sports-equipment',
    effects: [{ type: 'stat_add', stat: 'accuracy', value: 0.1 }],
  },
  {
    id: 'sportsequipment-grand-slam',
    name: 'Sports Equipment Grand Slam',
    shortLabel: 'SLAM',
    description: '+10% damage with sports equipment',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'sports-equipment',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.1 }],
  },
  {
    id: 'sportsequipment-swing-evolved',
    name: 'Sports Equipment Swing (Evolved)',
    shortLabel: 'SWING+',
    description: '+0.2 accuracy with sports equipment',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'sports-equipment',
    effects: [{ type: 'stat_add', stat: 'accuracy', value: 0.2 }],
  },
  {
    id: 'sportsequipment-grand-slam-evolved',
    name: 'Sports Equipment Grand Slam (Evolved)',
    shortLabel: 'SLAM+',
    description: '+15% damage with sports equipment',
    category: 'combat',
    kind: 'passive',
    weaponPrerequisite: 'sports-equipment',
    effects: [{ type: 'stat_multiply', stat: 'damage', value: 0.15 }],
  },
];

/**
 * Maps each skill ID to the ability ID that is granted when that skill reaches
 * level 5. Used by `skillSystem` to call `grantPassiveAbility` on milestone.
 *
 * This is a second source of truth alongside the skill and ability registries.
 * If a skill ID is renamed, update this map accordingly. The test suite in
 * `tests/game/weapon-skill-abilities.test.ts` cross-checks all 20 entries
 * against `getAllSkillDefinitions()` and `getAllAbilityDefinitions()` at runtime
 * to catch drift.
 */
export const SKILL_LEVEL5_ABILITY_GRANTS: ReadonlyMap<string, string> = new Map([
  ['swordsmanship', 'combat-flow'],
  ['iron-skin', 'stalwart-resolve'],
  ['sprint', 'ever-vigilant'],
  ['slashing', 'blade-mastery'],
  ['stabbing', 'vital-targeting'],
  ['smashing', 'brute-force'],
  ['ranged', 'marksmans-eye'],
  ['throwing', 'rapid-release'],
  ['forearms', 'iron-resolve'],
  ['arcane', 'arcane-efficiency'],
  ['sword', 'keen-swordsman'],
  ['dagger', 'shadowblade'],
  ['hammer', 'crushing-momentum'],
  ['sports-equipment', 'athletes-grit'],
  ['bow', 'archers-stance'],
  ['crossbow', 'precision-bolts'],
  ['pistol', 'hair-trigger'],
  ['throwing-weapons', 'juggling-arsenal'],
  ['unarmed', 'bare-knuckle'],
  ['spellcraft', 'arcane-attunement'],
]);

export function parseAbilityCatalog(raw: unknown): AbilityDefinition[] {
  return abilityCatalogSchema.parse(raw);
}

const parsed = parseAbilityCatalog(ABILITY_DEFINITIONS_RAW);
const ABILITY_DEFINITIONS = Object.freeze(parsed.map((def) => Object.freeze({ ...def })));
const registry = new Map<string, AbilityDefinition>();
for (const ability of ABILITY_DEFINITIONS) {
  registry.set(ability.id, ability);
}

export function getAbilityDefinition(id: string): AbilityDefinition | undefined {
  return registry.get(id);
}

export function getAllAbilityDefinitions(): readonly AbilityDefinition[] {
  return ABILITY_DEFINITIONS;
}
