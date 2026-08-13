import { z } from 'zod';
import { SKILL_HARD_CAP } from '../../shared/skills.js';
import { STAT_KEYS } from '../../shared/stats.js';
import { SPELL_SKILL_ID_BY_SPELL_ID } from '../../shared/spell-skills.js';
import type { SkillDefinition } from './types.js';

const skillMilestoneLevelSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(15),
  z.literal(20),
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
      'spell_used',
    ]),
    usageThresholds: z.array(z.number().int().positive()),
    perLevelBonus: perLevelBonusSchema,
    milestones: z
      .array(
        z.object({
          level: skillMilestoneLevelSchema,
          name: z.string().trim().min(1),
          description: z.string().trim().min(1),
          abilityId: z.string().trim().min(1).optional(),
        }),
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
  // ─── Generic Skills (kept for backward compatibility, grant L5 passives only) ──────
  {
    id: 'swordsmanship',
    name: 'Swordsmanship',
    description: 'Proficiency with swords. The blade becomes an extension of your will.',
    category: 'combat',
    usageMetric: 'hits_landed',
    usageThresholds: [
      15, 40, 90, 160, 260, 380, 520, 680, 860, 1060, 1280, 1520, 1780, 2060, 2360, 2680, 3020,
      3380, 3760, 4160,
    ],
    perLevelBonus: { damage: 1 },
    milestones: [
      {
        level: 5,
        name: 'Flow State',
        description: '+15% damage',
        abilityId: 'combat-flow',
      },
      {
        level: 10,
        name: 'Intermediate',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l10',
      },
      {
        level: 15,
        name: 'Advanced',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l15',
      },
      {
        level: 20,
        name: 'Mastery',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l20',
      },
    ],
  },
  {
    id: 'iron-skin',
    name: 'Iron Skin',
    description: 'Your body hardens with each hit taken. Damage withstood builds resilience.',
    category: 'defense',
    usageMetric: 'damage_dealt',
    usageThresholds: [
      50, 140, 310, 570, 920, 1360, 1890, 2510, 3220, 4020, 4910, 5890, 6960, 8120, 9370, 10710,
      12140, 13660, 15270, 16970,
    ],
    perLevelBonus: { maxHp: 4 },
    milestones: [
      {
        level: 5,
        name: 'Stalwart',
        description: '+20 HP',
        abilityId: 'stalwart-resolve',
      },
      {
        level: 10,
        name: 'Intermediate',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l10',
      },
      {
        level: 15,
        name: 'Advanced',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l15',
      },
      {
        level: 20,
        name: 'Mastery',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l20',
      },
    ],
  },
  {
    id: 'sprint',
    name: 'Sprint',
    description: 'Running becomes a way of life. The faster you move, the faster you think.',
    category: 'utility',
    usageMetric: 'distance_dodged_near_threat',
    usageThresholds: [
      100, 280, 620, 1140, 1850, 2750, 3840, 5120, 6590, 8250, 10100, 12140, 14370, 16790, 19400,
      22200, 25190, 28370, 31740, 35290,
    ],
    perLevelBonus: { moveSpeed: 0.00625 },
    milestones: [
      {
        level: 5,
        name: 'Ever Vigilant',
        description: '+10% move speed',
        abilityId: 'ever-vigilant',
      },
      {
        level: 10,
        name: 'Intermediate',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l10',
      },
      {
        level: 15,
        name: 'Advanced',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l15',
      },
      {
        level: 20,
        name: 'Mastery',
        description: 'Placeholder',
        abilityId: 'placeholder-generic-l20',
      },
    ],
  },

  // ─── Weapon Class Skills (slow leveling · damage focus, grant passives) ──────
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
        description: '+10% damage with slashing weapons',
        abilityId: 'slashing-mastery-base',
      },
      {
        level: 10,
        name: 'Fluid Strikes',
        description: '+1 extra projectile with slashing',
        abilityId: 'slashing-momentum',
      },
      {
        level: 15,
        name: 'Whirlwind',
        description: 'Evolved Sharp Instinct ability',
        abilityId: 'slashing-mastery-evolved',
      },
      {
        level: 20,
        name: 'Blade Mastery',
        description: 'Evolved Fluid Strikes ability',
        abilityId: 'slashing-momentum-evolved',
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
        description: '+15% attack speed with stabbing weapons',
        abilityId: 'stabbing-precision-base',
      },
      {
        level: 10,
        name: 'Rapid Thrust',
        description: '+1 extra projectile with stabbing',
        abilityId: 'stabbing-tempo',
      },
      {
        level: 15,
        name: 'Vital Strike',
        description: 'Evolved Find the Seam ability',
        abilityId: 'stabbing-precision-evolved',
      },
      {
        level: 20,
        name: 'Puncture Mastery',
        description: 'Evolved Rapid Thrust ability',
        abilityId: 'stabbing-tempo-evolved',
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
        description: '+10% damage with blunt weapons',
        abilityId: 'smashing-impact-base',
      },
      {
        level: 10,
        name: 'Juggernaut Step',
        description: '+1 extra projectile with smashing',
        abilityId: 'smashing-momentum',
      },
      {
        level: 15,
        name: 'Shockwave',
        description: 'Evolved Concussive Force ability',
        abilityId: 'smashing-impact-evolved',
      },
      {
        level: 20,
        name: 'Ground Zero',
        description: 'Evolved Juggernaut Step ability',
        abilityId: 'smashing-momentum-evolved',
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
        description: '+10% damage with ranged weapons',
        abilityId: 'ranged-accuracy-base',
      },
      {
        level: 10,
        name: 'Rapid Fire',
        description: '+1 extra projectile with ranged',
        abilityId: 'ranged-barrage',
      },
      {
        level: 15,
        name: 'Deadeye',
        description: 'Evolved Keen Eye ability',
        abilityId: 'ranged-accuracy-evolved',
      },
      {
        level: 20,
        name: 'Perfect Shot',
        description: 'Evolved Rapid Fire ability',
        abilityId: 'ranged-barrage-evolved',
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
        description: '+10% damage with thrown weapons',
        abilityId: 'throwing-precision-base',
      },
      {
        level: 10,
        name: 'Strong Arm',
        description: '+10% projectile speed with throwing',
        abilityId: 'throwing-velocity',
      },
      {
        level: 15,
        name: 'Perfect Release',
        description: 'Evolved Calculated Arc ability',
        abilityId: 'throwing-precision-evolved',
      },
      {
        level: 20,
        name: 'Obliterating Toss',
        description: 'Evolved Strong Arm ability',
        abilityId: 'throwing-velocity-evolved',
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
        description: '+15% attack speed with forearms',
        abilityId: 'forearms-brawl-base',
      },
      {
        level: 10,
        name: 'Flurry',
        description: '+15% attack speed with forearms',
        abilityId: 'forearms-combo',
      },
      {
        level: 15,
        name: 'Bone Crusher',
        description: 'Evolved Iron Knuckle ability',
        abilityId: 'forearms-brawl-evolved',
      },
      {
        level: 20,
        name: 'Bare-Knuckle Legend',
        description: 'Evolved Flurry ability',
        abilityId: 'forearms-combo-evolved',
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
        description: '+10% damage with arcane weapons',
        abilityId: 'arcane-mastery-base',
      },
      {
        level: 10,
        name: 'Arcane Surge',
        description: '+10% damage with arcane weapons',
        abilityId: 'arcane-efficiency',
      },
      {
        level: 15,
        name: 'Spellweaver',
        description: 'Evolved Spell Focus ability',
        abilityId: 'arcane-mastery-evolved',
      },
      {
        level: 20,
        name: 'Arcane Supremacy',
        description: 'Evolved Arcane Surge ability',
        abilityId: 'arcane-efficiency-evolved',
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
        description: '+0.1 accuracy with swords',
        abilityId: 'sword-strike-base',
      },
      {
        level: 10,
        name: "Swordsman's Edge",
        description: '+1 extra projectile with swords',
        abilityId: 'sword-cleave',
      },
      {
        level: 15,
        name: 'True Cut',
        description: 'Evolved Blade Familiarity ability',
        abilityId: 'sword-strike-evolved',
      },
      {
        level: 20,
        name: 'Perfect Form',
        description: "Evolved Swordsman's Edge ability",
        abilityId: 'sword-cleave-evolved',
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
        description: 'Rapid strike technique — quick follow-up attack with daggers',
        abilityId: 'dagger-rapid-strike-base',
      },
      {
        level: 10,
        name: 'Stabmaster',
        description: '+15% attack speed with daggers',
        abilityId: 'dagger-flurry',
      },
      {
        level: 15,
        name: 'Vital Points',
        description: 'Evolved Close Quarters ability',
        abilityId: 'dagger-rapid-strike-evolved',
      },
      {
        level: 20,
        name: 'Shadowstrike',
        description: 'Evolved Stabmaster ability',
        abilityId: 'dagger-flurry-evolved',
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
        description: '+0.1 accuracy with hammers',
        abilityId: 'hammer-crush-base',
      },
      {
        level: 10,
        name: 'Caved In',
        description: '+10% damage with hammers',
        abilityId: 'hammer-shatter',
      },
      {
        level: 15,
        name: 'Precision Blow',
        description: 'Evolved Hammer Time ability',
        abilityId: 'hammer-crush-evolved',
      },
      {
        level: 20,
        name: "Thor's Will",
        description: 'Evolved Caved In ability',
        abilityId: 'hammer-shatter-evolved',
      },
    ],
    flavorText: '"Blunt. Direct. The audience appreciates honesty." — The Director',
  },
  {
    id: 'bow',
    name: 'Bow',
    description: 'Discipline at distance. Every shot is calculated.',
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
        name: 'Steady Aim',
        description: '+0.1 accuracy with bows',
        abilityId: 'bow-shot-base',
      },
      {
        level: 10,
        name: 'Power Draw',
        description: '+15% damage with bows',
        abilityId: 'bow-piercing',
      },
      {
        level: 15,
        name: 'Perfect Draw',
        description: 'Evolved Steady Aim ability',
        abilityId: 'bow-shot-evolved',
      },
      {
        level: 20,
        name: 'Marksman',
        description: 'Evolved Power Draw ability',
        abilityId: 'bow-piercing-evolved',
      },
    ],
    flavorText: '"Patience. Precision. The hallmarks of champions." — The Director',
  },
  {
    id: 'crossbow',
    name: 'Crossbow',
    description: 'Mechanical precision. Pull the trigger, let physics do the work.',
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
        name: 'Mechanical Precision',
        description: '+0.1 accuracy with crossbows',
        abilityId: 'crossbow-bolt-base',
      },
      {
        level: 10,
        name: 'Rapid Reload',
        description: '+15% attack speed with crossbows',
        abilityId: 'crossbow-barrage',
      },
      {
        level: 15,
        name: 'Perfect Tension',
        description: 'Evolved Mechanical Precision ability',
        abilityId: 'crossbow-bolt-evolved',
      },
      {
        level: 20,
        name: 'Ballista',
        description: 'Evolved Rapid Reload ability',
        abilityId: 'crossbow-barrage-evolved',
      },
    ],
    flavorText: '"Engineering meets art. The audience loves it both ways." — The Director',
  },
  {
    id: 'pistol',
    name: 'Pistol',
    description: 'Modern firearm mastery. Quick draws and steady hands.',
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
        name: 'Quick Draw',
        description: '+0.1 accuracy with pistols',
        abilityId: 'pistol-shot-base',
      },
      {
        level: 10,
        name: 'Gunslinger',
        description: '+15% attack speed with pistols',
        abilityId: 'pistol-volley',
      },
      {
        level: 15,
        name: 'Deadshot',
        description: 'Evolved Quick Draw ability',
        abilityId: 'pistol-shot-evolved',
      },
      {
        level: 20,
        name: 'Trigger Mastery',
        description: 'Evolved Gunslinger ability',
        abilityId: 'pistol-volley-evolved',
      },
    ],
    flavorText: '"Bang. Quick. Effective. Peak entertainment." — The Director',
  },
  {
    id: 'throwing-weapons',
    name: 'Throwing Weapons',
    description: 'Improvise. Adapt. Overcome.',
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
        name: 'Sure Throw',
        description: '+0.1 accuracy with throwing weapons',
        abilityId: 'throwing-toss-base',
      },
      {
        level: 10,
        name: 'Multi-Throw',
        description: '+1 extra projectile with throwing weapons',
        abilityId: 'throwing-boomerang',
      },
      {
        level: 15,
        name: 'True Aim',
        description: 'Evolved Sure Throw ability',
        abilityId: 'throwing-toss-evolved',
      },
      {
        level: 20,
        name: 'Bombardier',
        description: 'Evolved Multi-Throw ability',
        abilityId: 'throwing-scatter',
      },
    ],
    flavorText: '"Anything can be a weapon in the right hands." — The Director',
  },
  {
    id: 'unarmed',
    name: 'Unarmed',
    description: 'The body is the weapon. Master it.',
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
        name: 'Perfect Stance',
        description: '+0.1 accuracy with unarmed',
        abilityId: 'unarmed-punch-base',
      },
      {
        level: 10,
        name: 'Combo Artist',
        description: '+15% attack speed unarmed',
        abilityId: 'unarmed-barrage',
      },
      {
        level: 15,
        name: 'Dance of Combat',
        description: 'Evolved Perfect Stance ability',
        abilityId: 'unarmed-punch-evolved',
      },
      {
        level: 20,
        name: 'Martial Master',
        description: 'Evolved Combo Artist ability',
        abilityId: 'unarmed-barrage-evolved',
      },
    ],
    flavorText: '"No weapons. No excuses. Pure skill." — The Director',
  },
  {
    id: 'spellcraft',
    name: 'Spellcraft',
    description: 'Weave magic into weapons. Reality bends to will.',
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
        name: 'Spell Infusion',
        description: '+0.1 accuracy with spellcraft',
        abilityId: 'spellcraft-bolt-base',
      },
      {
        level: 10,
        name: 'Cascade',
        description: '+1 extra projectile with spellcraft',
        abilityId: 'spellcraft-cascade',
      },
      {
        level: 15,
        name: 'Spellsinger',
        description: 'Evolved Spell Infusion ability',
        abilityId: 'spellcraft-bolt-evolved',
      },
      {
        level: 20,
        name: 'Arcane Overflow',
        description: 'Evolved Cascade ability',
        abilityId: 'spellcraft-cascade-evolved',
      },
    ],
    flavorText: '"Magic woven into every moment. Peak performance art." — The Director',
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
        description: '+0.1 accuracy with sports equipment',
        abilityId: 'sports-swing-base',
      },
      {
        level: 10,
        name: 'Crowd Pleaser',
        description: '+10% damage with sports equipment',
        abilityId: 'sports-home-run',
      },
      {
        level: 15,
        name: 'All-Star',
        description: 'Evolved Game Face ability',
        abilityId: 'sports-swing-evolved',
      },
      {
        level: 20,
        name: 'MVP',
        description: 'Evolved Crowd Pleaser ability',
        abilityId: 'sports-grand-slam',
      },
    ],
    flavorText: '"Repurposed sporting goods. Unironically terrifying." — The Director',
  },
  // ─── Spell skills — usage-based efficacy for every Floor 1 spell ─────────
  // Spell output modifiers are applied centrally in progressionEffects.ts. These
  // milestones intentionally have no abilityId: they are real breakpoints, not
  // placeholder catalog abilities.
  ...((
    [
      ['fireball', 'Fireball', 'Shape a hotter, wider blast with every cast.'],
      ['heal', 'Heal', 'Channel restorative magic with greater certainty.'],
      ['pulse-shield', 'Pulse Shield', 'Turn defensive pulses into stronger knockback.'],
      ['magic-missile', 'Magic Missile', 'Guide arcane bolts farther and harder.'],
      ['frost-nova', 'Frost Nova', 'Freeze larger groups for longer.'],
      ['bless', 'Bless', 'Make every blessing last and matter more.'],
      ['stoneskin', 'Stoneskin', 'Harden the protective ward around your body.'],
      ['curse', 'Curse', 'Spread a heavier, longer-lasting hex.'],
      ['vampiric-touch', 'Vampiric Touch', 'Drain more life from every successful touch.'],
      ['haste', 'Haste', 'Push speed magic beyond ordinary limits.'],
    ] as const
  ).map(([spellId, spellName, description]) => ({
    id: SPELL_SKILL_ID_BY_SPELL_ID[spellId],
    name: `${spellName} Mastery`,
    description,
    category: 'utility' as const,
    usageMetric: 'spell_used' as const,
    usageThresholds: [
      2, 5, 10, 18, 30, 45, 65, 90, 120, 155, 195, 240, 290, 345, 405, 470, 540, 615, 695, 780,
    ],
    perLevelBonus: {},
    milestones: [
      {
        level: 5 as const,
        name: 'Awakening',
        description: 'Spell efficacy modifier increases materially.',
      },
      {
        level: 10 as const,
        name: 'Resonance',
        description: 'Spell efficacy modifier increases materially.',
      },
      {
        level: 15 as const,
        name: 'Overchannel',
        description: 'Spell efficacy modifier increases materially.',
      },
      {
        level: 20 as const,
        name: 'Grandmastery',
        description: 'Spell efficacy modifier reaches its dramatic peak.',
      },
    ],
  })) as SkillDefinition[]),
];

const SKILL_DEFINITIONS = skillCatalogSchema.parse(SKILL_DEFINITIONS_RAW);

export function parseSkillCatalog(raw: unknown) {
  return skillCatalogSchema.parse(raw);
}

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
