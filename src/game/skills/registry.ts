import { z } from 'zod';
import { SKILL_HARD_CAP } from '../../shared/skills.js';
import { STAT_KEYS } from '../../shared/stats.js';
import type { SkillDefinition } from './types.js';

const skillMilestoneLevelSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(15),
  z.literal(20),
]);

const statKeySchema = z.enum(STAT_KEYS);

const milestoneEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stat_add'), stat: statKeySchema, value: z.number() }).strict(),
  z.object({ type: z.literal('stat_multiply'), stat: statKeySchema, value: z.number() }).strict(),
  z.object({ type: z.literal('extra_projectile'), count: z.number() }).strict(),
  z
    .object({
      type: z.literal('aura'),
      radius: z.number().positive(),
      dpsPercentOfDamage: z.number().positive(),
    })
    .strict(),
]);

const perLevelBonusSchema = z
  .object(Object.fromEntries(STAT_KEYS.map((key) => [key, z.number().optional()])))
  .strict();

const skillSchema: z.ZodType<SkillDefinition> = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    category: z.enum(['combat', 'defense', 'utility', 'weapon_class', 'weapon_type']),
    usageMetric: z.enum(['hits_landed', 'damage_dealt', 'distance_dodged_near_threat']),
    usageThresholds: z.array(z.number().int().positive()),
    perLevelBonus: perLevelBonusSchema,
    milestones: z
      .array(
        z
          .object({
            level: skillMilestoneLevelSchema,
            name: z.string().trim().min(1),
            description: z.string().trim().min(1),
            effect: milestoneEffectSchema,
          })
          .strict(),
      )
      .length(4),
    flavorText: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.usageThresholds.length !== SKILL_HARD_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `usageThresholds must have exactly ${SKILL_HARD_CAP} entries`,
        path: ['usageThresholds'],
      });
    }

    for (let i = 1; i < value.usageThresholds.length; i++) {
      if (value.usageThresholds[i]! <= value.usageThresholds[i - 1]!) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'usageThresholds must be strictly increasing',
          path: ['usageThresholds', i],
        });
      }
    }

    const levels = value.milestones.map((m) => m.level).sort((a, b) => a - b);
    const expected = [5, 10, 15, 20];
    for (let i = 0; i < expected.length; i++) {
      if (levels[i] !== expected[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'milestones must contain levels 5,10,15,20 exactly once',
          path: ['milestones'],
        });
        break;
      }
    }
  });

const skillCatalogSchema = z.array(skillSchema).superRefine((skills, ctx) => {
  const ids = new Set<string>();
  for (const skill of skills) {
    if (ids.has(skill.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate skill id: ${skill.id}`,
      });
    }
    ids.add(skill.id);
  }
});

/** Real skills — all silly-skill content deferred to v2. */
const SKILL_DEFINITIONS_RAW: SkillDefinition[] = [
  {
    id: 'swordsmanship',
    name: 'Swordsmanship',
    description: 'Mastery of melee and ranged precision. Every hit sharpens the edge.',
    category: 'combat',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 25, 45, 70, 100, 135, 175, 220, 270, 325, 385, 450, 520, 595, 675, 760, 850, 945, 1045,
      1150,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Keen Edge',
        description: '+10% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Double Strike',
        description: '+1 extra projectile per attack',
        effect: { type: 'extra_projectile', count: 1 },
      },
      {
        level: 15,
        name: 'Bladestorm',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Absolute Mastery',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText: '"The arena demands precision. The audience demands spectacle." — The Director',
  },
  {
    id: 'iron-skin',
    name: 'Iron Skin',
    description: 'Hardened through punishment. Each blow you survive makes you harder to kill.',
    category: 'defense',
    usageMetric: 'damage_dealt',
    usageThresholds: [
      50, 120, 210, 320, 450, 600, 770, 960, 1170, 1400, 1650, 1920, 2210, 2520, 2850, 3200, 3570,
      3960, 4370, 4800,
    ],
    perLevelBonus: { armor: 1, maxHp: 5 },
    milestones: [
      {
        level: 5,
        name: 'Toughened Hide',
        description: '+20 max HP',
        effect: { type: 'stat_add', stat: 'maxHp', value: 20 },
      },
      {
        level: 10,
        name: 'Stone Wall',
        description: '+5 armor',
        effect: { type: 'stat_add', stat: 'armor', value: 5 },
      },
      {
        level: 15,
        name: 'Unbreakable',
        description: '+50 max HP',
        effect: { type: 'stat_add', stat: 'maxHp', value: 50 },
      },
      {
        level: 20,
        name: 'Juggernaut',
        description: 'Aura — damages nearby enemies for 5% of your damage per second',
        effect: { type: 'aura', radius: 6, dpsPercentOfDamage: 0.05 },
      },
    ],
    flavorText:
      '"Audience engagement peaks when performers survive against all odds." — The Director',
  },
  {
    id: 'sprint',
    name: 'Sprint',
    description: 'Keep moving. The arena rewards agility.',
    category: 'utility',
    usageMetric: 'distance_dodged_near_threat',
    usageThresholds: [
      30, 80, 150, 240, 350, 480, 630, 800, 990, 1200, 1430, 1680, 1950, 2240, 2550, 2880, 3230,
      3600, 3990, 4400,
    ],
    perLevelBonus: { moveSpeed: 0.05, pickupRange: 2 },
    milestones: [
      {
        level: 5,
        name: 'Quick Feet',
        description: '+0.3 move speed',
        effect: { type: 'stat_add', stat: 'moveSpeed', value: 0.3 },
      },
      {
        level: 10,
        name: 'Slipstream',
        description: '+8 pickup range',
        effect: { type: 'stat_add', stat: 'pickupRange', value: 8 },
      },
      {
        level: 15,
        name: 'Ghost Step',
        description: '+0.5 move speed',
        effect: { type: 'stat_add', stat: 'moveSpeed', value: 0.5 },
      },
      {
        level: 20,
        name: 'Blur',
        description: '+0.15 attack speed multiplier from constant motion',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 },
      },
    ],
    flavorText: '"Mobility is survival. Also, the audience loves a runner." — The Director',
  },

  // -----------------------------------------------------------------------
  // WEAPON CLASS SKILLS — broad attack style, grant damage, level slowly
  // Balance target: level 2 by end of floor 1 (~150 uses)
  // -----------------------------------------------------------------------
  {
    id: 'slashing',
    name: 'Slashing',
    description: 'Mastery of edged, sweeping cuts. Blades feel natural in your hands.',
    category: 'weapon_class',
    usageMetric: 'hits_landed',
    usageThresholds: [
      40, 150, 340, 600, 940, 1360, 1870, 2480, 3200, 4040, 5010, 6120, 7380, 8800, 10390, 12160,
      14120, 16280, 18650, 21240,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Keen Edge',
        description: '+5% damage with slashing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      },
      {
        level: 10,
        name: 'Razor Focus',
        description: '+5 flat damage with slashing weapons',
        effect: { type: 'stat_add', stat: 'damage', value: 5 },
      },
      {
        level: 15,
        name: 'Whirling Blade',
        description: '+10% damage with slashing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 20,
        name: 'Bladestorm',
        description: '+20% damage with slashing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.2 },
      },
    ],
    flavorText: '"A clean cut is both efficient and telegenic." — The Director',
  },
  {
    id: 'stabbing',
    name: 'Stabbing',
    description: 'Precision thrusting technique. Every stab finds the gap in the armor.',
    category: 'weapon_class',
    usageMetric: 'hits_landed',
    usageThresholds: [
      40, 150, 340, 600, 940, 1360, 1870, 2480, 3200, 4040, 5010, 6120, 7380, 8800, 10390, 12160,
      14120, 16280, 18650, 21240,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Point First',
        description: '+5% damage with stabbing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      },
      {
        level: 10,
        name: 'Vital Strike',
        description: '+3% attack speed with stabbing weapons',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.03 },
      },
      {
        level: 15,
        name: 'Deep Thrust',
        description: '+10% damage with stabbing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 20,
        name: 'Heartseeker',
        description: '+20% damage with stabbing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.2 },
      },
    ],
    flavorText:
      '"Audience reaction data shows 23% higher engagement on clean stab kills." — The Director',
  },
  {
    id: 'smashing',
    name: 'Smashing',
    description: 'Raw power behind blunt impacts. You hit harder because you are harder.',
    category: 'weapon_class',
    usageMetric: 'hits_landed',
    usageThresholds: [
      40, 150, 340, 600, 940, 1360, 1870, 2480, 3200, 4040, 5010, 6120, 7380, 8800, 10390, 12160,
      14120, 16280, 18650, 21240,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Bone Breaker',
        description: '+5% damage with smashing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      },
      {
        level: 10,
        name: 'Concussive Force',
        description: '+5 flat damage with smashing weapons',
        effect: { type: 'stat_add', stat: 'damage', value: 5 },
      },
      {
        level: 15,
        name: 'Pulverize',
        description: '+10% damage with smashing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 20,
        name: 'Earthshatter',
        description: '+20% damage with smashing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.2 },
      },
    ],
    flavorText: '"The crowd goes wild for a solid hit. Science." — The Director',
  },
  {
    id: 'ranged',
    name: 'Ranged Combat',
    description: 'Discipline at distance. Firing from a safe position is a legitimate strategy.',
    category: 'weapon_class',
    usageMetric: 'hits_landed',
    usageThresholds: [
      40, 150, 340, 600, 940, 1360, 1870, 2480, 3200, 4040, 5010, 6120, 7380, 8800, 10390, 12160,
      14120, 16280, 18650, 21240,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Steady Aim',
        description: '+5% damage with ranged weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      },
      {
        level: 10,
        name: 'Quick Draw',
        description: '+5% attack speed',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 15,
        name: 'Eagle Eye',
        description: '+10% damage with ranged weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 20,
        name: 'Deadeye',
        description: '+20% damage with ranged weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.2 },
      },
    ],
    flavorText: '"Cowardice is a viewer opinion. Effectiveness is a metric." — The Director',
  },
  {
    id: 'forearms',
    name: 'Forearms',
    description: 'Bare hands, maximum commitment. The oldest weapon in the dungeon.',
    category: 'weapon_class',
    usageMetric: 'hits_landed',
    usageThresholds: [
      40, 150, 340, 600, 940, 1360, 1870, 2480, 3200, 4040, 5010, 6120, 7380, 8800, 10390, 12160,
      14120, 16280, 18650, 21240,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Iron Fist',
        description: '+5% damage with unarmed strikes',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      },
      {
        level: 10,
        name: 'Rapid Strikes',
        description: '+5% attack speed',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 15,
        name: 'Combat Mastery',
        description: '+10% damage with unarmed strikes',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 20,
        name: 'One Punch',
        description: '+25% damage with unarmed strikes',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText: '"No weapon? Magnificent. The audience adores the underdog." — The Director',
  },

  // -----------------------------------------------------------------------
  // WEAPON TYPE SKILLS — specific weapon family, grant accuracy, level faster
  // Balance target: level 4 by end of floor 1 (~150 uses)
  // -----------------------------------------------------------------------
  {
    id: 'sword',
    name: 'Sword',
    description: 'The classic blade. Proper technique makes every swing count.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: 'Swordplay',
        description: '+3% attack speed with swords',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.03 },
      },
      {
        level: 10,
        name: 'Precision Cuts',
        description: '+2 flat damage with swords',
        effect: { type: 'stat_add', stat: 'damage', value: 2 },
      },
      {
        level: 15,
        name: 'Bladework',
        description: '+5% attack speed with swords',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 20,
        name: 'Duelist',
        description: '+10% damage with swords',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
    ],
    flavorText: '"Timeless. The analytics don\'t lie." — The Director',
  },
  {
    id: 'dagger',
    name: 'Dagger',
    description:
      'Speed over power. A dagger in the right hands hits faster than the eye can track.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: 'Quick Hands',
        description: '+5% attack speed with daggers',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 10,
        name: 'Shadow Strike',
        description: '+3% attack speed with daggers',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.03 },
      },
      {
        level: 15,
        name: 'Flurry',
        description: '+8% attack speed with daggers',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.08 },
      },
      {
        level: 20,
        name: 'Assassination',
        description: '+10% damage with daggers',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
    ],
    flavorText:
      '"Technically it\'s a knife. The audience calls it whatever gets views." — The Director',
  },
  {
    id: 'sports-equipment',
    name: 'Sports Equipment',
    description: 'Bats, balls, and miscellaneous athletic gear repurposed for violence.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: 'Home Run Swing',
        description: '+5% damage with sports equipment',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      },
      {
        level: 10,
        name: 'Athletic Form',
        description: '+3% attack speed with sports equipment',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.03 },
      },
      {
        level: 15,
        name: "Champion's Grip",
        description: '+8% damage with sports equipment',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.08 },
      },
      {
        level: 20,
        name: 'MVP',
        description: '+15% damage with sports equipment',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.15 },
      },
    ],
    flavorText: '"Season 3 contestants brought bats. Ratings were record-breaking." — The Director',
  },
  {
    id: 'bow',
    name: 'Bow',
    description: 'Patient, deliberate, and deadly at range. Draw. Hold. Release.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: "Archer's Eye",
        description: '+5% attack speed with bows',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 10,
        name: 'Piercing Shot',
        description: '+2 flat damage with bows',
        effect: { type: 'stat_add', stat: 'damage', value: 2 },
      },
      {
        level: 15,
        name: 'Rapid Nocking',
        description: '+8% attack speed with bows',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.08 },
      },
      {
        level: 20,
        name: 'Marksman',
        description: '+10% damage with bows',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
    ],
    flavorText: '"Classic. The audience relates to the bow. Everyone\'s seen one." — The Director',
  },
  {
    id: 'crossbow',
    name: 'Crossbow',
    description: 'Mechanical precision. Less art, more engineering. Still deadly.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: 'Fast Reload',
        description: '+5% attack speed with crossbows',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 10,
        name: 'Heavy Bolt',
        description: '+3 flat damage with crossbows',
        effect: { type: 'stat_add', stat: 'damage', value: 3 },
      },
      {
        level: 15,
        name: 'Expert Loader',
        description: '+8% attack speed with crossbows',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.08 },
      },
      {
        level: 20,
        name: 'Sniper',
        description: '+10% damage with crossbows',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
    ],
    flavorText: '"Less dramatic than a bow. More dramatic than most." — The Director',
  },
  {
    id: 'pistol',
    name: 'Pistol',
    description: 'Compact firepower. Small enough to run with, dangerous enough to matter.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: 'Trigger Discipline',
        description: '+5% attack speed with pistols',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 10,
        name: 'Center Mass',
        description: '+2 flat damage with pistols',
        effect: { type: 'stat_add', stat: 'damage', value: 2 },
      },
      {
        level: 15,
        name: 'Double Tap',
        description: '+8% attack speed with pistols',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.08 },
      },
      {
        level: 20,
        name: 'Gunslinger',
        description: '+10% damage with pistols',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
    ],
    flavorText:
      '"I had to fight three network partners to allow firearms. Worth it." — The Director',
  },
  {
    id: 'heavy-weapon',
    name: 'Heavy Weapon',
    description: 'Sledgehammers, war-mauls, and other instruments of mass redistribution.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: 'Overhead Swing',
        description: '+5% damage with heavy weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.05 },
      },
      {
        level: 10,
        name: 'Momentum',
        description: '+3% attack speed with heavy weapons',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.03 },
      },
      {
        level: 15,
        name: 'Brutal Force',
        description: '+8% damage with heavy weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.08 },
      },
      {
        level: 20,
        name: 'Titan Blow',
        description: '+15% damage with heavy weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.15 },
      },
    ],
    flavorText:
      '"The hammer segment consistently wins the slow-motion replay poll." — The Director',
  },
  {
    id: 'thrown',
    name: 'Thrown Weapons',
    description: 'Blades, projectiles, and hazards launched with lethal intent.',
    category: 'weapon_type',
    usageMetric: 'hits_landed',
    usageThresholds: [
      10, 30, 70, 150, 280, 460, 700, 1000, 1370, 1810, 2320, 2910, 3580, 4340, 5190, 6140, 7200,
      8380, 9690, 11140,
    ],
    perLevelBonus: { attackSpeed: 0.01 },
    milestones: [
      {
        level: 5,
        name: 'Good Arm',
        description: '+5% attack speed with thrown weapons',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.05 },
      },
      {
        level: 10,
        name: 'True Flight',
        description: '+5% projectile speed',
        effect: { type: 'stat_add', stat: 'projectileSpeed', value: 0.05 },
      },
      {
        level: 15,
        name: 'Perfect Release',
        description: '+8% attack speed with thrown weapons',
        effect: { type: 'stat_add', stat: 'attackSpeed', value: 0.08 },
      },
      {
        level: 20,
        name: 'Unerring',
        description: '+10% damage with thrown weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
    ],
    flavorText: '"Physics is just math. You can learn to throw perfectly." — The Director',
  },
];

export function parseSkillCatalog(raw: unknown): SkillDefinition[] {
  return skillCatalogSchema.parse(raw);
}

const parsed = parseSkillCatalog(SKILL_DEFINITIONS_RAW);
const SKILL_DEFINITIONS = Object.freeze(parsed.map((skill) => Object.freeze({ ...skill })));

const registry = new Map<string, SkillDefinition>();
for (const skill of SKILL_DEFINITIONS) {
  registry.set(skill.id, skill);
}

export function getSkillDefinition(id: string): SkillDefinition | undefined {
  return registry.get(id);
}

export function getAllSkillDefinitions(): readonly SkillDefinition[] {
  return SKILL_DEFINITIONS;
}

/** All weapon CLASS skill definitions (broad attack style). */
export function getWeaponClassSkills(): readonly SkillDefinition[] {
  return SKILL_DEFINITIONS.filter((s) => s.category === 'weapon_class');
}

/** All weapon TYPE skill definitions (specific weapon family). */
export function getWeaponTypeSkills(): readonly SkillDefinition[] {
  return SKILL_DEFINITIONS.filter((s) => s.category === 'weapon_type');
}
