import {
  createActiveWeaponSnapshotInput,
  createGeneratedEquipmentInstance,
} from '../core/generated-equipment-registry.js';
import type { GameWorld } from '../core/world.js';
import {
  FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_BASE_SCHEMA_VERSION,
  GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
  type GeneratedEquipmentBaseV1,
  type GeneratedEquipmentEnhancementLevel,
  type GeneratedEquipmentInstanceV1,
  type GeneratedEquipmentRarity,
  type ResolvedEquipmentEffectV1,
} from '../shared/generated-equipment-types.js';
import { deepFreeze } from '../shared/canonical-json.js';
import { getEquipmentDefForItem } from '../shared/equipmentDefs.js';
import type { EquipmentItemDef } from '../shared/equipment-types.js';
import type { StatId } from '../shared/stats.js';
import { getWeaponDef, type WeaponDef } from '../shared/weaponDefs.js';
import { getFloor2WeaponWaveABase } from '../shared/data/floor2-weapon-bases.js';
import type { SeededRandom } from '../shared/random.js';
import { getAbilityDefinition } from './abilities/registry.js';

export type GeneratedEquipmentGeneratorErrorCode =
  | 'illegal-enhancement'
  | 'insufficient-effect-budget'
  | 'invalid-effect-catalog'
  | 'invalid-request'
  | 'registry-unconfigured'
  | 'unknown-base';

export class GeneratedEquipmentGeneratorError extends Error {
  constructor(
    readonly code: GeneratedEquipmentGeneratorErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'GeneratedEquipmentGeneratorError';
  }
}

export interface GenerateEquipmentInstanceRequest {
  readonly baseId: string;
  readonly itemLevel: number;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel?: GeneratedEquipmentEnhancementLevel;
}

export interface GenerateEquipmentInstanceOptions {
  /** Derived streams can generate content without perturbing the world gameplay stream. */
  readonly rng?: SeededRandom;
  /** Optional source-specific effect subset; omitted preserves the canonical full catalog. */
  readonly allowedEffectKinds?: readonly GeneratedEquipmentEffectPayload['kind'][];
}

type GeneratedEquipmentTargetKind = 'weapon' | 'armor' | 'accessory';

interface GeneratedEquipmentLevelCurveV1 {
  readonly id: 'weapon-linear-percent/v1' | 'armor-linear-percent/v1' | 'no-inherent-scaling/v1';
  readonly percentPerLevel: number;
}

interface ResolvedGeneratedEquipmentBase {
  readonly base: GeneratedEquipmentBaseV1;
  readonly equipmentDef: EquipmentItemDef;
  readonly weaponDef: WeaponDef | null;
  readonly targetKind: GeneratedEquipmentTargetKind;
  readonly inherentValue: number;
  readonly levelCurve: GeneratedEquipmentLevelCurveV1;
}

type GeneratedEquipmentEffectPayload =
  | {
      readonly kind: 'stat';
      readonly stat: StatId;
      readonly operation: 'add';
      readonly value: number;
    }
  | {
      readonly kind: 'abilityGrant' | 'passiveGrant';
      readonly grantId: string;
    };

interface GeneratedEquipmentEffectDefinition {
  readonly effectId: string;
  readonly displayPrefix: string;
  readonly unitCost: 1 | 2;
  readonly legalTargets: readonly GeneratedEquipmentTargetKind[];
  readonly exclusionGroup?: string;
  readonly payload: GeneratedEquipmentEffectPayload;
}

const LEVEL_CURVES: Readonly<Record<GeneratedEquipmentTargetKind, GeneratedEquipmentLevelCurveV1>> =
  deepFreeze({
    weapon: {
      id: 'weapon-linear-percent/v1',
      percentPerLevel: 0.1,
    },
    armor: {
      id: 'armor-linear-percent/v1',
      percentPerLevel: 0.1,
    },
    accessory: {
      id: 'no-inherent-scaling/v1',
      percentPerLevel: 0,
    },
  });

const EFFECT_CATALOG: readonly GeneratedEquipmentEffectDefinition[] = deepFreeze([
  {
    effectId: 'tempered',
    displayPrefix: 'Tempered',
    unitCost: 1,
    legalTargets: ['weapon'],
    payload: { kind: 'stat', stat: 'damageBonus', operation: 'add', value: 2 },
  },
  {
    effectId: 'guarded',
    displayPrefix: 'Guarded',
    unitCost: 1,
    legalTargets: ['armor'],
    payload: { kind: 'stat', stat: 'armor', operation: 'add', value: 1 },
  },
  {
    effectId: 'vital',
    displayPrefix: 'Vital',
    unitCost: 1,
    legalTargets: ['weapon', 'armor', 'accessory'],
    exclusionGroup: 'primary-stat',
    payload: { kind: 'stat', stat: 'constitution', operation: 'add', value: 1 },
  },
  {
    effectId: 'fortunate',
    displayPrefix: 'Fortunate',
    unitCost: 1,
    legalTargets: ['weapon', 'armor', 'accessory'],
    exclusionGroup: 'primary-stat',
    payload: { kind: 'stat', stat: 'luck', operation: 'add', value: 1 },
  },
  {
    effectId: 'spellbound',
    displayPrefix: 'Spellbound',
    unitCost: 2,
    legalTargets: ['weapon', 'armor', 'accessory'],
    exclusionGroup: 'ability-grant',
    payload: { kind: 'abilityGrant', grantId: 'fireball' },
  },
  {
    effectId: 'instinctive',
    displayPrefix: 'Instinctive',
    unitCost: 2,
    legalTargets: ['weapon', 'armor', 'accessory'],
    exclusionGroup: 'ability-grant',
    payload: { kind: 'passiveGrant', grantId: 'veteran-instinct' },
  },
]);

function fail(code: GeneratedEquipmentGeneratorErrorCode, message: string, path: string): never {
  throw new GeneratedEquipmentGeneratorError(code, message, path);
}

function validateEffectCatalog(): void {
  const ids = new Set<string>();
  for (let index = 0; index < EFFECT_CATALOG.length; index += 1) {
    const effect = EFFECT_CATALOG[index]!;
    if (ids.has(effect.effectId)) {
      fail(
        'invalid-effect-catalog',
        `Duplicate generated-equipment effect ${effect.effectId}`,
        `$.effectCatalog[${index}].effectId`,
      );
    }
    ids.add(effect.effectId);
    if (effect.payload.kind === 'stat') continue;
    const ability = getAbilityDefinition(effect.payload.grantId);
    const expectedKind = effect.payload.kind === 'passiveGrant' ? 'passive' : 'active';
    const actualKind =
      ability?.kind === 'passive' ? 'passive' : ability === undefined ? null : 'active';
    if (actualKind !== expectedKind) {
      fail(
        'invalid-effect-catalog',
        `Grant ${effect.payload.grantId} must resolve to a known ${expectedKind} ability`,
        `$.effectCatalog[${index}].payload.grantId`,
      );
    }
  }
}

validateEffectCatalog();

function requireItemLevel(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    fail('invalid-request', 'Item level must be a positive integer', '$.request.itemLevel');
  }
  return value;
}

function requireRarity(value: GeneratedEquipmentRarity): GeneratedEquipmentRarity {
  if (value !== 'common' && value !== 'uncommon' && value !== 'rare') {
    fail('invalid-request', 'Rarity must be common, uncommon, or rare', '$.request.rarity');
  }
  return value;
}

function requireEnhancement(
  value: GeneratedEquipmentEnhancementLevel | undefined,
  maximum: GeneratedEquipmentEnhancementLevel,
): GeneratedEquipmentEnhancementLevel {
  const enhancement = value ?? 0;
  if (!Number.isInteger(enhancement) || enhancement < 0 || enhancement > maximum) {
    fail(
      'invalid-request',
      `Enhancement must be an integer from +0 through +${maximum}`,
      '$.request.enhancementLevel',
    );
  }
  return enhancement;
}

function baseTags(
  def: EquipmentItemDef,
  targetKind: GeneratedEquipmentTargetKind,
): readonly string[] {
  const tags = [...(def.tags ?? [])];
  const kindTag = targetKind === 'weapon' ? 'weapon' : 'equipment';
  if (!tags.includes(kindTag)) tags.push(kindTag);
  return Object.freeze(tags);
}

function resolveGeneratedEquipmentBase(baseId: string): ResolvedGeneratedEquipmentBase {
  const floor2WeaponBase = getFloor2WeaponWaveABase(baseId);
  const equipmentDef = floor2WeaponBase?.equipmentDef ?? getEquipmentDefForItem(baseId);
  if (equipmentDef === undefined) {
    fail('unknown-base', `Unknown generated-equipment base ${baseId}`, '$.request.baseId');
  }

  let weaponDef: WeaponDef | null = null;
  if (equipmentDef.weaponId !== undefined) {
    const resolvedWeaponDef = getWeaponDef(equipmentDef.weaponId);
    if (resolvedWeaponDef === undefined) {
      fail(
        'unknown-base',
        `Equipment base ${baseId} references unknown weapon ${equipmentDef.weaponId}`,
        '$.base.template.weaponDefId',
      );
    }
    weaponDef = resolvedWeaponDef;
  }

  const armorValue = equipmentDef.statBonuses.armor ?? 0;
  if (!Number.isFinite(armorValue) || armorValue < 0) {
    fail(
      'invalid-request',
      `Equipment base ${baseId} has invalid inherent armor`,
      '$.base.statBonuses.armor',
    );
  }
  const targetKind: GeneratedEquipmentTargetKind =
    weaponDef !== null ? 'weapon' : armorValue > 0 ? 'armor' : 'accessory';
  const template =
    weaponDef === null
      ? ({ kind: 'equipment', equipmentDefId: equipmentDef.id } as const)
      : ({ kind: 'weapon', weaponDefId: weaponDef.id } as const);

  const base: GeneratedEquipmentBaseV1 = deepFreeze({
    schemaVersion: GENERATED_EQUIPMENT_BASE_SCHEMA_VERSION,
    baseId: equipmentDef.id,
    template,
    displayName: equipmentDef.name,
    artKey: floor2WeaponBase?.artKey ?? equipmentDef.artKey ?? equipmentDef.id,
    slots: [...equipmentDef.slots],
    tags: baseTags(equipmentDef, targetKind),
    weightLb: equipmentDef.weightLb,
  });
  return Object.freeze({
    base,
    equipmentDef,
    weaponDef,
    targetKind,
    inherentValue: weaponDef?.baseDamage ?? armorValue,
    levelCurve: LEVEL_CURVES[targetKind],
  });
}

export function getGeneratedEquipmentBaseV1(baseId: string): GeneratedEquipmentBaseV1 {
  return resolveGeneratedEquipmentBase(baseId).base;
}

function effectsAreCompatible(
  left: GeneratedEquipmentEffectDefinition,
  right: GeneratedEquipmentEffectDefinition,
): boolean {
  return (
    left.effectId !== right.effectId &&
    (left.exclusionGroup === undefined ||
      right.exclusionGroup === undefined ||
      left.exclusionGroup !== right.exclusionGroup)
  );
}

function selectEffectDefinitions(
  rng: SeededRandom,
  base: ResolvedGeneratedEquipmentBase,
  budget: 0 | 1 | 2,
  allowedEffectKinds?: readonly GeneratedEquipmentEffectPayload['kind'][],
): readonly GeneratedEquipmentEffectDefinition[] {
  if (budget === 0) return Object.freeze([]);
  const legal = EFFECT_CATALOG.filter(
    (effect) =>
      effect.legalTargets.includes(base.targetKind) &&
      (allowedEffectKinds === undefined || allowedEffectKinds.includes(effect.payload.kind)),
  );
  if (budget === 1) {
    const minor = legal.filter((effect) => effect.unitCost === 1);
    if (minor.length === 0) {
      fail(
        'insufficient-effect-budget',
        `No legal one-unit effect exists for ${base.base.baseId}`,
        '$.effects',
      );
    }
    return Object.freeze([minor[rng.nextInt(0, minor.length - 1)]!]);
  }

  const singleMajor = legal.filter((effect) => effect.unitCost === 2).map((effect) => [effect]);
  const minor = legal.filter((effect) => effect.unitCost === 1);
  const minorPairs: GeneratedEquipmentEffectDefinition[][] = [];
  for (let left = 0; left < minor.length; left += 1) {
    for (let right = left + 1; right < minor.length; right += 1) {
      const leftEffect = minor[left]!;
      const rightEffect = minor[right]!;
      if (effectsAreCompatible(leftEffect, rightEffect)) {
        minorPairs.push([leftEffect, rightEffect]);
      }
    }
  }

  const shapes = [singleMajor, minorPairs].filter((shape) => shape.length > 0);
  if (shapes.length === 0) {
    fail(
      'insufficient-effect-budget',
      `No legal two-unit effect combination exists for ${base.base.baseId}`,
      '$.effects',
    );
  }
  const shape = shapes[rng.nextInt(0, shapes.length - 1)]!;
  return Object.freeze([...shape[rng.nextInt(0, shape.length - 1)]!]);
}

function materializeEffects(
  definitions: readonly GeneratedEquipmentEffectDefinition[],
): readonly ResolvedEquipmentEffectV1[] {
  return Object.freeze(
    definitions.map((definition, effectOrdinal): ResolvedEquipmentEffectV1 => {
      const common = {
        schemaVersion: GENERATED_EQUIPMENT_EFFECT_SCHEMA_VERSION,
        effectId: definition.effectId,
        effectOrdinal,
        unitCost: definition.unitCost,
      };
      return definition.payload.kind === 'stat'
        ? deepFreeze({ ...common, ...definition.payload })
        : deepFreeze({ ...common, ...definition.payload });
    }),
  );
}

function normalizeInherent(value: number): number {
  return Math.floor(value + 0.5);
}

function displayName(
  baseName: string,
  definitions: readonly GeneratedEquipmentEffectDefinition[],
  enhancementLevel: GeneratedEquipmentEnhancementLevel,
): string {
  const prefix = definitions.map((effect) => effect.displayPrefix).join(' ');
  const name = prefix.length === 0 ? baseName : `${prefix} ${baseName}`;
  return enhancementLevel === 0 ? name : `${name} +${enhancementLevel}`;
}

export function generateEquipmentInstance(
  world: GameWorld,
  request: GenerateEquipmentInstanceRequest,
  options: GenerateEquipmentInstanceOptions = {},
): GeneratedEquipmentInstanceV1 {
  if (world.generatedEquipmentRegistry.runKey === null) {
    fail(
      'registry-unconfigured',
      'Generated equipment requires a configured world registry run key',
      '$.registry.runKey',
    );
  }

  const itemLevel = requireItemLevel(request.itemLevel);
  const rarity = requireRarity(request.rarity);
  const policy = world.generatedEquipmentRegistry.generationPolicy;
  const enhancementLevel = requireEnhancement(
    request.enhancementLevel,
    policy.maximumEnhancementLevel,
  );
  const resolvedBase = resolveGeneratedEquipmentBase(request.baseId);
  if (enhancementLevel > 0 && resolvedBase.inherentValue === 0) {
    fail(
      'illegal-enhancement',
      `Base ${resolvedBase.base.baseId} has no inherent damage or armor`,
      '$.request.enhancementLevel',
    );
  }

  const levelMultiplier = 1 + resolvedBase.levelCurve.percentPerLevel * Math.max(0, itemLevel - 1);
  const rarityMultiplier = policy.rarityInherentScalars[rarity];
  const enhancementMultiplier = 1 + policy.enhancementPercentPerLevel * enhancementLevel;
  const resolvedInherent =
    resolvedBase.inherentValue * levelMultiplier * rarityMultiplier * enhancementMultiplier;

  const effectDefinitions = selectEffectDefinitions(
    options.rng ?? world.rng,
    resolvedBase,
    policy.rarityEffectUnits[rarity],
    options.allowedEffectKinds,
  );
  const resolvedEffects = materializeEffects(effectDefinitions);
  const statBonuses: Partial<Record<StatId, number>> = {
    ...resolvedBase.equipmentDef.statBonuses,
  };
  if (resolvedBase.targetKind === 'armor') {
    statBonuses.armor = resolvedInherent;
  }
  for (const effect of resolvedEffects) {
    if ('kind' in effect && effect.kind === 'stat') {
      statBonuses[effect.stat] = (statBonuses[effect.stat] ?? 0) + effect.value;
    }
  }
  if (resolvedBase.targetKind === 'armor') {
    statBonuses.armor = normalizeInherent(statBonuses.armor ?? 0);
  }

  const abilityGrants = resolvedEffects.flatMap((effect) =>
    'kind' in effect && effect.kind === 'abilityGrant' ? [effect.grantId] : [],
  );
  const passiveGrants = resolvedEffects.flatMap((effect) =>
    'kind' in effect && effect.kind === 'passiveGrant' ? [effect.grantId] : [],
  );
  const activeWeaponSnapshot =
    resolvedBase.weaponDef === null
      ? null
      : createActiveWeaponSnapshotInput(resolvedBase.weaponDef.id, {
          baseDamage: normalizeInherent(resolvedInherent),
        });

  return createGeneratedEquipmentInstance(world, {
    baseId: resolvedBase.base.baseId,
    itemLevel,
    rarity,
    enhancementLevel,
    resolvedEffects,
    frozen: {
      schemaVersion: FROZEN_EQUIPMENT_FIELDS_SCHEMA_VERSION,
      displayName: displayName(resolvedBase.base.displayName, effectDefinitions, enhancementLevel),
      artKey: resolvedBase.base.artKey,
      slots: resolvedBase.base.slots,
      tags: resolvedBase.base.tags,
      weightLb: resolvedBase.base.weightLb,
      statBonuses,
      abilityGrants,
      passiveGrants,
      activeWeaponSnapshot,
    },
  });
}
