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
    category: z.enum(['combat', 'defense', 'utility']),
    usageMetric: z.enum([
      'hits_landed',
      'damage_dealt',
      'distance_dodged_near_threat',
      'weapon_fired',
    ]),
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

  // ─── Weapon Class Skills (slow leveling · damage focus) ──────────────────
  // Each fires on `weapon_fired`; threshold[1] ≈ 80 so level 2 lands by floor 1 end.
  {
    id: 'slashing',
    name: 'Slashing',
    description: 'Master of bladed sweeps. Every swing cuts deeper.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      30, 80, 180, 330, 530, 780, 1080, 1430, 1830, 2280, 2780, 3330, 3930, 4580, 5280, 6030, 6830,
      7680, 8580, 9530,
    ],
    perLevelBonus: { damage: 2 },
    milestones: [
      {
        level: 5,
        name: 'Sharp Instinct',
        description: '+10% damage multiplier with slashing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Fluid Strikes',
        description: '+10% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.1 },
      },
      {
        level: 15,
        name: 'Whirlwind',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Blade Mastery',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText: '"They came with weapons. You came with purpose." — The Director',
  },
  {
    id: 'stabbing',
    name: 'Stabbing',
    description: 'Precision thrusts find gaps in any armor. Strike true.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      30, 80, 180, 330, 530, 780, 1080, 1430, 1830, 2280, 2780, 3330, 3930, 4580, 5280, 6030, 6830,
      7680, 8580, 9530,
    ],
    perLevelBonus: { damage: 2 },
    milestones: [
      {
        level: 5,
        name: 'Find the Seam',
        description: '+10% damage multiplier with stabbing weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Rapid Thrust',
        description: '+15% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 },
      },
      {
        level: 15,
        name: 'Vital Strike',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Puncture Mastery',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText:
      '"Speed is the weapon. Everything else is just the delivery method." — The Director',
  },
  {
    id: 'smashing',
    name: 'Smashing',
    description: 'Raw impact force. Enemies crumble, walls follow.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      30, 80, 180, 330, 530, 780, 1080, 1430, 1830, 2280, 2780, 3330, 3930, 4580, 5280, 6030, 6830,
      7680, 8580, 9530,
    ],
    perLevelBonus: { damage: 2 },
    milestones: [
      {
        level: 5,
        name: 'Concussive Force',
        description: '+10% damage multiplier with blunt weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Juggernaut Step',
        description: '+8 pickup range from scattered debris',
        effect: { type: 'stat_add', stat: 'pickupRange', value: 8 },
      },
      {
        level: 15,
        name: 'Shockwave',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Ground Zero',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText: '"Big numbers. Bigger reactions. That\'s what the audience wants." — The Director',
  },
  {
    id: 'ranged',
    name: 'Ranged',
    description: 'Discipline at distance. Every shot placed, not wasted.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      30, 80, 180, 330, 530, 780, 1080, 1430, 1830, 2280, 2780, 3330, 3930, 4580, 5280, 6030, 6830,
      7680, 8580, 9530,
    ],
    perLevelBonus: { damage: 2 },
    milestones: [
      {
        level: 5,
        name: 'Keen Eye',
        description: '+10% damage multiplier with ranged weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Rapid Fire',
        description: '+1 extra projectile per shot',
        effect: { type: 'extra_projectile', count: 1 },
      },
      {
        level: 15,
        name: 'Deadeye',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Perfect Shot',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText: '"The audience holds its breath at maximum range." — The Director',
  },
  {
    id: 'throwing',
    name: 'Throwing',
    description: 'Harness flight and force. Objects in motion do serious work.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      30, 80, 180, 330, 530, 780, 1080, 1430, 1830, 2280, 2780, 3330, 3930, 4580, 5280, 6030, 6830,
      7680, 8580, 9530,
    ],
    perLevelBonus: { damage: 2 },
    milestones: [
      {
        level: 5,
        name: 'Calculated Arc',
        description: '+10% damage multiplier with thrown weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Strong Arm',
        description: '+10% projectile speed',
        effect: { type: 'stat_multiply', stat: 'projectileSpeed', value: 0.1 },
      },
      {
        level: 15,
        name: 'Perfect Release',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Obliterating Toss',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText: '"Improvised weapons. Unimprovised carnage." — The Director',
  },
  {
    id: 'forearms',
    name: 'Forearms',
    description: 'Your fists are your first, last, and best weapon. Train them accordingly.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      30, 80, 180, 330, 530, 780, 1080, 1430, 1830, 2280, 2780, 3330, 3930, 4580, 5280, 6030, 6830,
      7680, 8580, 9530,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Iron Knuckle',
        description: '+10% damage multiplier with unarmed strikes',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Flurry',
        description: '+15% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 },
      },
      {
        level: 15,
        name: 'Bone Crusher',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Bare-Knuckle Legend',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText:
      '"No weapon? No problem. The audience loves a bare-knuckle showdown." — The Director',
  },
  {
    id: 'arcane',
    name: 'Arcane',
    description: 'Command forces beyond the physical. The dungeon has never seen anything like it.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      30, 80, 180, 330, 530, 780, 1080, 1430, 1830, 2280, 2780, 3330, 3930, 4580, 5280, 6030, 6830,
      7680, 8580, 9530,
    ],
    perLevelBonus: { damage: 2 },
    milestones: [
      {
        level: 5,
        name: 'Spell Focus',
        description: '+10% damage multiplier with arcane weapons',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 10,
        name: 'Arcane Surge',
        description: '+10% projectile speed',
        effect: { type: 'stat_multiply', stat: 'projectileSpeed', value: 0.1 },
      },
      {
        level: 15,
        name: 'Overcharge',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
      {
        level: 20,
        name: 'Archmage',
        description: '+50% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.5 },
      },
    ],
    flavorText:
      '"Magic is unpredictable. That is precisely why the audience loves it." — The Director',
  },

  // ─── Weapon Type Skills (fast leveling · accuracy focus) ─────────────────
  // Each fires on `weapon_fired`; threshold[3] ≈ 90 so level 4 lands by floor 1 end.
  {
    id: 'sword',
    name: 'Sword',
    description: 'The sword is an extension of the arm. Learn it and nothing is out of reach.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Blade Familiarity',
        description: '+0.1 accuracy bonus with swords',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: "Swordsman's Edge",
        description: '+10% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 15,
        name: 'True Cut',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'Perfect Form',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText: '"A classic choice. The audience respects tradition." — The Director',
  },
  {
    id: 'dagger',
    name: 'Dagger',
    description: 'Fast, quiet, surgical. A dagger in practiced hands is terrifying.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Close Quarters',
        description: '+0.1 accuracy bonus with daggers',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Stabmaster',
        description: '+15% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 },
      },
      {
        level: 15,
        name: 'Vital Points',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'Shadowstrike',
        description: '+20% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.2 },
      },
    ],
    flavorText: '"Small blade, big drama." — The Director',
  },
  {
    id: 'hammer',
    name: 'Hammer',
    description: 'Heavy and slow, but land it right and enemies go flying.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Hammer Time',
        description: '+0.1 accuracy bonus with hammers',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Caved In',
        description: '+10% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 15,
        name: 'Precision Blow',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: "Thor's Will",
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText: '"Blunt. Direct. The audience appreciates honesty." — The Director',
  },
  {
    id: 'sports-equipment',
    name: 'Sports Equipment',
    description: 'Bats, balls, and raw athletic instinct. Improvise. Win.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Game Face',
        description: '+0.1 accuracy bonus with sports equipment',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Crowd Pleaser',
        description: '+10% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 15,
        name: 'Home Run',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'MVP',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText: '"Repurposed sporting goods. Unironically terrifying." — The Director',
  },
  {
    id: 'bow',
    name: 'Bow',
    description: 'Ancient weapon, ancient discipline. Draw, breathe, release.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Steady Draw',
        description: '+0.1 accuracy bonus with bows',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'True Aim',
        description: '+10% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.1 },
      },
      {
        level: 15,
        name: 'Arrow Storm',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'Legolas Fantasy',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText: '"Romance of the archer. Until you\'re on the receiving end." — The Director',
  },
  {
    id: 'crossbow',
    name: 'Crossbow',
    description: 'Point. Click. Repeat. Crossbow mastery is about patience and placement.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Bolt Placement',
        description: '+0.1 accuracy bonus with crossbows',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Repeater',
        description: '+15% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 },
      },
      {
        level: 15,
        name: 'Bullseye',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'Crossbow Master',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText: '"Technology. A wonderful equalizer." — The Director',
  },
  {
    id: 'pistol',
    name: 'Pistol',
    description: 'Compact, reliable, devastating. Every bullet counts.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Grip Control',
        description: '+0.1 accuracy bonus with pistols',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Trigger Discipline',
        description: '+15% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 },
      },
      {
        level: 15,
        name: 'Dead Eye',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'Gunslinger',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText:
      '"Six shots. Make them count. Or don\'t — the audience loves a reload fumble." — The Director',
  },
  {
    id: 'throwing-weapons',
    name: 'Throwing Weapons',
    description: 'Knives, boomerangs, anything airborne. The arc is everything.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Trajectory Math',
        description: '+0.1 accuracy bonus with throwing weapons',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Wrist Snap',
        description: '+10% projectile speed',
        effect: { type: 'stat_multiply', stat: 'projectileSpeed', value: 0.1 },
      },
      {
        level: 15,
        name: 'Precision Release',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'Circus Trick',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText: '"It always comes back. One way or another." — The Director',
  },
  {
    id: 'unarmed',
    name: 'Unarmed',
    description: 'Fists, elbows, knees, teeth. The most honest form of combat.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Street Brawler',
        description: '+0.1 accuracy bonus with unarmed strikes',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Combo Artist',
        description: '+20% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.2 },
      },
      {
        level: 15,
        name: 'Pressure Points',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'One Punch',
        description: '+30% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.3 },
      },
    ],
    flavorText:
      "\"No weapon? The audience calls it 'committed'. We call it 'ratings gold'.\" — The Director",
  },
  {
    id: 'spellcraft',
    name: 'Spellcraft',
    description: 'Harness arcane energies. Control is the difference between mastery and disaster.',
    category: 'combat',
    usageMetric: 'weapon_fired',
    usageThresholds: [
      10, 30, 55, 90, 135, 190, 255, 330, 415, 510, 615, 730, 855, 990, 1135, 1290, 1455, 1630,
      1815, 2010,
    ],
    perLevelBonus: { accuracy: 0.03 },
    milestones: [
      {
        level: 5,
        name: 'Spell Shaping',
        description: '+0.1 accuracy bonus with spells',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.1 },
      },
      {
        level: 10,
        name: 'Arcane Flow',
        description: '+15% attack speed',
        effect: { type: 'stat_multiply', stat: 'attackSpeed', value: 0.15 },
      },
      {
        level: 15,
        name: 'Focused Channeling',
        description: '+0.15 accuracy bonus',
        effect: { type: 'stat_add', stat: 'accuracy', value: 0.15 },
      },
      {
        level: 20,
        name: 'Grand Magus',
        description: '+25% damage multiplier',
        effect: { type: 'stat_multiply', stat: 'damage', value: 0.25 },
      },
    ],
    flavorText:
      '"Explosions are always popular. Controlled explosions are merely responsible." — The Director',
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
