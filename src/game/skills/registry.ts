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
        effect: { type: 'aura', radius: 48, dpsPercentOfDamage: 0.05 },
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
