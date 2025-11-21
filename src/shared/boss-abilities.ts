import { z } from 'zod';
import bossAbilityCatalogJson from './data/boss-abilities.floor2.json';
import { loadFamilies } from './data/families.js';
import { floor2EnemyPack } from './enemy-packs.js';

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const designValueSchema = z
  .object({
    id: idSchema,
    value: z.union([z.number().finite(), z.string().min(1), z.boolean()]),
    unit: z.enum([
      'count',
      'degrees',
      'descriptor',
      'feet',
      'flag',
      'milliseconds',
      'mode',
      'percent',
    ]),
  })
  .strict();

const telegraphShapeSchema = z.enum([
  'annulus',
  'arc-sweep',
  'circle',
  'cone',
  'contracting-annulus',
  'lane',
  'lane-and-circle',
  'multi-circle',
  'radial-projectiles',
  'self-aura',
  'sequential-annuli',
  'spawn-circles',
]);

type TelegraphShape = z.infer<typeof telegraphShapeSchema>;

const REQUIRED_TELEGRAPH_METRICS: Readonly<Record<TelegraphShape, readonly string[]>> = {
  annulus: ['inner-radius', 'outer-radius'],
  'arc-sweep': ['arc-angle', 'range', 'sweep-angle'],
  circle: ['radius'],
  cone: ['angle', 'range'],
  'contracting-annulus': ['start-radius', 'end-radius', 'ring-width'],
  lane: ['width'],
  'lane-and-circle': ['lane-width', 'endpoint-radius'],
  'multi-circle': ['count', 'radius'],
  'radial-projectiles': ['projectile-count'],
  'self-aura': ['radius'],
  'sequential-annuli': ['band-count', 'band-width', 'max-radius'],
  'spawn-circles': ['count', 'radius'],
};

const timingSchema = z
  .object({
    firstEligibleAfterMs: z.number().int().positive(),
    cooldownMs: z.number().int().positive(),
    cooldownAnchor: z.literal('resolution'),
    randomJitterMs: z.literal(0),
  })
  .strict();

const targetingSchema = z
  .object({
    mode: z.enum([
      'fixed-pattern',
      'player-direction',
      'player-position',
      'player-position-with-offsets',
      'self',
    ]),
    lockAt: z.enum(['self', 'telegraph-start']),
    tracksPlayer: z.literal(false),
    origin: z.enum(['follows-caster', 'locked']),
  })
  .strict()
  .superRefine((targeting, ctx) => {
    const isSelf = targeting.mode === 'self';
    if (isSelf && (targeting.lockAt !== 'self' || targeting.origin !== 'follows-caster')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'self-targeted abilities must use lockAt=self and origin=follows-caster',
      });
    }
    if (!isSelf && (targeting.lockAt !== 'telegraph-start' || targeting.origin !== 'locked')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-self abilities must lock their target and origin at telegraph start',
      });
    }
  });

/**
 * Contracts for well-known telegraph metric IDs. Any metric ID in this map
 * must carry the corresponding value type and unit, regardless of which
 * telegraph shape requires it. This rejects malformed catalog data such as
 * `radius: "wide", unit: "mode"` at the catalog boundary rather than
 * deferring the failure to runtime adapters.
 */
const METRIC_CONTRACTS: Readonly<
  Record<string, { valueType: 'positive-number' | 'positive-integer' | 'string'; unit: string }>
> = {
  radius: { valueType: 'positive-number', unit: 'feet' },
  'inner-radius': { valueType: 'positive-number', unit: 'feet' },
  'outer-radius': { valueType: 'positive-number', unit: 'feet' },
  'start-radius': { valueType: 'positive-number', unit: 'feet' },
  'end-radius': { valueType: 'positive-number', unit: 'feet' },
  'max-radius': { valueType: 'positive-number', unit: 'feet' },
  'endpoint-radius': { valueType: 'positive-number', unit: 'feet' },
  width: { valueType: 'positive-number', unit: 'feet' },
  'lane-width': { valueType: 'positive-number', unit: 'feet' },
  'band-width': { valueType: 'positive-number', unit: 'feet' },
  'ring-width': { valueType: 'positive-number', unit: 'feet' },
  range: { valueType: 'positive-number', unit: 'feet' },
  'max-range': { valueType: 'positive-number', unit: 'feet' },
  angle: { valueType: 'positive-number', unit: 'degrees' },
  'arc-angle': { valueType: 'positive-number', unit: 'degrees' },
  'sweep-angle': { valueType: 'positive-number', unit: 'degrees' },
  count: { valueType: 'positive-integer', unit: 'count' },
  'band-count': { valueType: 'positive-integer', unit: 'count' },
  'projectile-count': { valueType: 'positive-integer', unit: 'count' },
  'length-mode': { valueType: 'string', unit: 'mode' },
};

const telegraphSchema = z
  .object({
    durationMs: z.number().int().positive(),
    shape: telegraphShapeSchema,
    dangerColor: z.enum(['ability-theme', 'hostile-red']),
    description: z.string().min(40),
    metrics: z.array(designValueSchema).min(1),
  })
  .strict()
  .superRefine((telegraph, ctx) => {
    const ids = new Set<string>();
    for (const [index, metric] of telegraph.metrics.entries()) {
      if (ids.has(metric.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metrics', index, 'id'],
          message: `duplicate telegraph metric "${metric.id}"`,
        });
      }
      ids.add(metric.id);
    }
    for (const requiredId of REQUIRED_TELEGRAPH_METRICS[telegraph.shape]) {
      if (!ids.has(requiredId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metrics'],
          message: `${telegraph.shape} telegraph requires metric "${requiredId}"`,
        });
      }
    }
    if (
      (telegraph.shape === 'lane' || telegraph.shape === 'lane-and-circle') &&
      !ids.has('max-range') &&
      !ids.has('length-mode')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics'],
        message: `${telegraph.shape} telegraph requires length metric "max-range" or "length-mode"`,
      });
    }
    // Shape-specific metric contracts: validate value type and unit for any
    // metric ID that has a known contract (e.g. radius must be a positive
    // number in feet, not a string or a wrong unit).
    for (const [index, metric] of telegraph.metrics.entries()) {
      const contract = METRIC_CONTRACTS[metric.id];
      if (contract === undefined) continue;
      if (metric.unit !== contract.unit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metrics', index, 'unit'],
          message: `metric "${metric.id}" must have unit "${contract.unit}", got "${metric.unit}"`,
        });
      }
      const { value } = metric;
      if (contract.valueType === 'string') {
        if (typeof value !== 'string') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['metrics', index, 'value'],
            message: `metric "${metric.id}" must be a string value`,
          });
        }
      } else if (contract.valueType === 'positive-integer') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['metrics', index, 'value'],
            message: `metric "${metric.id}" must be a positive integer`,
          });
        }
      } else {
        // positive-number
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['metrics', index, 'value'],
            message: `metric "${metric.id}" must be a positive finite number`,
          });
        }
      }
    }
  });

const effectSchema = z
  .object({
    description: z.string().min(40),
    designValues: z.array(designValueSchema).min(1),
  })
  .strict()
  .superRefine((effect, ctx) => {
    const seen = new Set<string>();
    for (const [index, value] of effect.designValues.entries()) {
      if (seen.has(value.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['designValues', index, 'id'],
          message: `duplicate effect design value "${value.id}"`,
        });
      }
      seen.add(value.id);
    }
  });

const bossAbilityDefSchema = z
  .object({
    id: idSchema,
    bossArchetypeId: idSchema,
    bossName: z.string().min(1),
    familyId: idSchema,
    attackName: z.string().min(3),
    announcementText: z.string().min(3),
    category: z.enum(['area-denial', 'attack', 'debuff', 'defense', 'self-buff', 'summon']),
    timing: timingSchema,
    targeting: targetingSchema,
    telegraph: telegraphSchema,
    effect: effectSchema,
    codex: z
      .object({
        shortDescription: z.string().min(20),
        fullDescription: z.string().min(60),
        counterplay: z.string().min(40),
      })
      .strict(),
    presentation: z
      .object({
        vfxStrategy: z.literal('procedural'),
        particleIntensity: z.literal('gratuitous'),
        vfxDescription: z.string().min(60),
        castAnimationRequirement: z.literal('optional'),
      })
      .strict(),
  })
  .strict()
  .superRefine((ability, ctx) => {
    const usesThemedCue = ability.category === 'defense' || ability.category === 'self-buff';
    const expectedColor = usesThemedCue ? 'ability-theme' : 'hostile-red';
    if (ability.telegraph.dangerColor !== expectedColor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['telegraph', 'dangerColor'],
        message: `${ability.category} abilities must use ${expectedColor} telegraph cues`,
      });
    }
  });

export type BossAbilityDef = z.infer<typeof bossAbilityDefSchema>;

export const bossAbilityCatalogSchema = z
  .object({
    schemaVersion: z.literal('boss-abilities/v1'),
    floorId: z.literal('floor-2'),
    entries: z.array(bossAbilityDefSchema).min(1),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const abilityIds = new Set<string>();
    const bossIds = new Set<string>();
    const familyIds = new Set<string>();
    for (const [index, ability] of catalog.entries.entries()) {
      for (const [value, seen, label, path] of [
        [ability.id, abilityIds, 'ability id', 'id'],
        [ability.bossArchetypeId, bossIds, 'boss archetype', 'bossArchetypeId'],
        [ability.familyId, familyIds, 'family', 'familyId'],
      ] as const) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['entries', index, path],
            message: `duplicate ${label} "${value}"`,
          });
        }
        seen.add(value);
      }
    }
  });

export type BossAbilityCatalog = z.infer<typeof bossAbilityCatalogSchema>;

function validateFloor2Coverage(catalog: BossAbilityCatalog): void {
  const bosses = floor2EnemyPack.archetypes.filter((archetype) => archetype.isBoss === true);
  const bossesById = new Map(bosses.map((boss) => [boss.id, boss]));
  const familyIds = new Set(loadFamilies().map((family) => family.id));
  const errors: string[] = [];

  for (const ability of catalog.entries) {
    const boss = bossesById.get(ability.bossArchetypeId);
    if (boss === undefined) {
      errors.push(`catalog references unknown Floor 2 boss "${ability.bossArchetypeId}"`);
      continue;
    }
    if (ability.bossName !== boss.name) {
      errors.push(
        `${ability.bossArchetypeId} name mismatch: catalog="${ability.bossName}", enemies.floor2="${boss.name}"`,
      );
    }
    if (ability.familyId !== boss.familyId) {
      errors.push(
        `${ability.bossArchetypeId} family mismatch: catalog="${ability.familyId}", enemies.floor2="${boss.familyId}"`,
      );
    }
    if (!familyIds.has(ability.familyId)) {
      errors.push(`${ability.bossArchetypeId} references unknown family "${ability.familyId}"`);
    }
    bossesById.delete(ability.bossArchetypeId);
  }

  for (const missingBossId of bossesById.keys()) {
    errors.push(`Floor 2 boss "${missingBossId}" has no ability catalog entry`);
  }
  if (catalog.entries.length !== bosses.length) {
    errors.push(
      `catalog has ${catalog.entries.length} entries but Floor 2 has ${bosses.length} bosses`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Invalid Floor 2 boss ability coverage:\n- ${errors.join('\n- ')}`);
  }
}

export function loadFloor2BossAbilityCatalog(
  json: unknown = bossAbilityCatalogJson,
): BossAbilityCatalog {
  const catalog = bossAbilityCatalogSchema.parse(json);
  validateFloor2Coverage(catalog);
  return catalog;
}

export const FLOOR2_BOSS_ABILITY_CATALOG = loadFloor2BossAbilityCatalog();

const ABILITY_BY_ID = new Map(
  FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) => [ability.id, ability]),
);
const ABILITY_BY_BOSS_ID = new Map(
  FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) => [ability.bossArchetypeId, ability]),
);

export function getFloor2BossAbilityById(abilityId: string): BossAbilityDef | undefined {
  return ABILITY_BY_ID.get(abilityId);
}

export function getFloor2BossAbilityByBossId(bossArchetypeId: string): BossAbilityDef | undefined {
  return ABILITY_BY_BOSS_ID.get(bossArchetypeId);
}

export function formatBossAbilityAnnouncement(ability: BossAbilityDef): string {
  return `${ability.attackName} — ${ability.announcementText}`;
}

export interface BossAbilityCodexEntry {
  readonly id: string;
  readonly bossArchetypeId: string;
  readonly bossName: string;
  readonly attackName: string;
  readonly shortDescription: string;
  readonly fullDescription: string;
  readonly counterplay: string;
}

export function toBossAbilityCodexEntry(ability: BossAbilityDef): BossAbilityCodexEntry {
  return {
    id: ability.id,
    bossArchetypeId: ability.bossArchetypeId,
    bossName: ability.bossName,
    attackName: ability.attackName,
    shortDescription: ability.codex.shortDescription,
    fullDescription: ability.codex.fullDescription,
    counterplay: ability.codex.counterplay,
  };
}
