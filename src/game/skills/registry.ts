import type { SkillDefinition } from './types.js';

/** Real skills — all silly-skill content deferred to v2. */
const SKILL_DEFINITIONS: SkillDefinition[] = [
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

const registry = new Map<string, SkillDefinition>();
for (const skill of SKILL_DEFINITIONS) {
  registry.set(skill.id, skill);
}

export function getSkillDefinition(id: string): SkillDefinition | undefined {
  return registry.get(id);
}

export function getAllSkillDefinitions(): SkillDefinition[] {
  return SKILL_DEFINITIONS;
}
