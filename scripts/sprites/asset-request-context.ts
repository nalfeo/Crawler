import { getFloorEnemyPack } from '../../src/shared/enemy-packs.js';
import { getAvailableFloorIds, getFloorManifest } from '../../src/shared/floor-registry.js';
import { FAMILY_DESIGN_LANGUAGE, FLOOR_DESIGN_LANGUAGE } from './design-language-addenda.js';

export const MOB_ROLES = ['normal', 'elite', 'boss'] as const;
export type MobRole = (typeof MOB_ROLES)[number];

export interface DirectionInjections {
  readonly floor?: string;
  readonly family?: string;
  readonly category?: string;
}

/**
 * Request-local replacements for canonical direction strings. These are
 * intentionally stored alongside the resolved snapshot; changing a request
 * does not mutate the game's design-language source of truth.
 */
export interface DirectionInjectionOverrides {
  readonly floor?: string;
  readonly family?: string;
  readonly category?: string;
}

export interface AssetRequestContextSourceIds {
  readonly floorId?: string;
  readonly enemyPackId?: string;
  readonly familyId?: string;
  readonly archetypeId?: string;
}

/**
 * Immutable selection and direction snapshot carried from an authoring request
 * through synthesis and into the generated candidate YAML.
 */
export interface AssetRequestContext {
  readonly sourceIds: AssetRequestContextSourceIds;
  readonly mobRole?: MobRole;
  readonly injections: DirectionInjections;
  readonly injectionOverrides?: DirectionInjectionOverrides;
}

export interface AssetRequestContextInput {
  readonly floor?: number;
  readonly floorId?: string;
  readonly familyId?: string;
  readonly mobRole?: MobRole;
  readonly injectionOverrides?: DirectionInjectionOverrides;
}

export interface AssetRequestContextCapability {
  readonly floorId: string;
  readonly floor: number;
  readonly name: string;
  readonly enemyPackId?: string;
  readonly canonicalFloorInjection?: string;
  readonly families: readonly {
    readonly id: string;
    readonly roles: readonly MobRole[];
    readonly canonicalFamilyInjection?: string;
  }[];
}

const MAX_INJECTION_LENGTH = 4_000;

export class AssetRequestContextError extends Error {
  override readonly name = 'AssetRequestContextError';
}

/**
 * Reads current game manifests and enemy packs into a local-authoring
 * capability model. It deliberately exposes source IDs and canonical strings,
 * rather than duplicating them in the workflow UI.
 */
export function getAssetRequestContextCapabilities(): readonly AssetRequestContextCapability[] {
  return getAvailableFloorIds().flatMap((floorId) => {
    const manifest = getFloorManifest(floorId);
    if (!manifest) return [];
    const pack = manifest.enemyPackId ? getFloorEnemyPack(manifest.enemyPackId) : undefined;
    const families = pack
      ? [
          ...new Set(
            pack.archetypes.flatMap((archetype) =>
              archetype.familyId ? [archetype.familyId] : [],
            ),
          ),
        ]
          .sort()
          .map((familyId) => ({
            id: familyId,
            roles: rolesForFamily(pack.archetypes, familyId),
            ...(familyInjection(familyId)
              ? { canonicalFamilyInjection: familyInjection(familyId) }
              : {}),
          }))
      : [];
    const floor = floorNumber(floorId);
    return [
      {
        floorId,
        floor,
        name: manifest.name,
        ...(manifest.enemyPackId ? { enemyPackId: manifest.enemyPackId } : {}),
        ...(floorInjection(floor) ? { canonicalFloorInjection: floorInjection(floor) } : {}),
        families,
      },
    ];
  });
}

/**
 * Resolve a selected context against live floor manifests/enemy packs. The
 * returned strings are a snapshot for reproducibility; overrides replace only
 * this request's copy and never update canonical design-language modules.
 */
export function resolveAssetRequestContext(input: AssetRequestContextInput): AssetRequestContext {
  const floorId = normalizeOptionalId(input.floorId, 'floorId');
  const familyId = normalizeOptionalId(input.familyId, 'familyId');
  const mobRole = input.mobRole;
  if (mobRole !== undefined && !MOB_ROLES.includes(mobRole)) {
    throw new AssetRequestContextError(
      `Unknown mobRole '${String(mobRole)}'. Expected ${MOB_ROLES.join(', ')}.`,
    );
  }

  const inferredFloorId = floorIdForNumber(input.floor);
  const resolvedFloorId =
    floorId ?? (inferredFloorId && getFloorManifest(inferredFloorId) ? inferredFloorId : undefined);
  const manifest = resolvedFloorId ? getFloorManifest(resolvedFloorId) : undefined;
  if (floorId && !manifest) {
    throw new AssetRequestContextError(
      `Unknown floorId '${floorId}'. Select a floor returned by GET /api/workflow/asset-context.`,
    );
  }
  if (floorId && input.floor !== undefined && input.floor !== floorNumber(floorId)) {
    throw new AssetRequestContextError(
      `floor (${input.floor}) does not match floorId '${floorId}'. Use floor ${floorNumber(floorId)}.`,
    );
  }

  const overrides = normalizeInjectionOverrides(input.injectionOverrides);
  if (overrides.family !== undefined && !familyId) {
    throw new AssetRequestContextError('family injection override requires a selected familyId.');
  }

  let archetypeId: string | undefined;
  const sourceIds: AssetRequestContextSourceIds = {
    ...(resolvedFloorId ? { floorId: resolvedFloorId } : {}),
    ...(manifest ? { enemyPackId: manifest.enemyPackId } : {}),
    ...(familyId ? { familyId } : {}),
  };
  if (familyId) {
    if (!manifest) {
      throw new AssetRequestContextError(
        `familyId '${familyId}' requires a known floorId. Select a floor from GET /api/workflow/asset-context.`,
      );
    }
    if (!manifest.enemyPackId) {
      throw new AssetRequestContextError(
        `Floor '${manifest.id}' declares no enemy pack and cannot resolve family context.`,
      );
    }
    const pack = getFloorEnemyPack(manifest.enemyPackId);
    if (!pack) {
      throw new AssetRequestContextError(
        `Floor '${manifest.id}' references unknown enemy pack '${manifest.enemyPackId}'.`,
      );
    }
    const roles = rolesForFamily(pack.archetypes, familyId);
    if (roles.length === 0) {
      throw new AssetRequestContextError(
        `Family '${familyId}' is not bound to enemy pack '${manifest.enemyPackId}' for ${manifest.id}.`,
      );
    }
    if (mobRole && !roles.includes(mobRole)) {
      throw new AssetRequestContextError(
        `Family '${familyId}' has no '${mobRole}' role in enemy pack '${manifest.enemyPackId}'.`,
      );
    }
    const archetype = pack.archetypes.find(
      (candidate) =>
        candidate.familyId === familyId && roleForArchetype(candidate) === (mobRole ?? 'normal'),
    );
    if (archetype) archetypeId = archetype.id;
  } else if (mobRole) {
    throw new AssetRequestContextError('mobRole requires a selected familyId.');
  }

  const finalSourceIds: AssetRequestContextSourceIds = {
    ...sourceIds,
    ...(archetypeId ? { archetypeId } : {}),
  };
  const floor = input.floor ?? (resolvedFloorId ? floorNumber(resolvedFloorId) : undefined);
  const canonicalFloor = floor === undefined ? undefined : floorInjection(floor);
  const canonicalFamily = familyId ? familyInjection(familyId) : undefined;
  const injections: DirectionInjections = {
    ...((overrides.floor ?? canonicalFloor) ? { floor: overrides.floor ?? canonicalFloor } : {}),
    ...((overrides.family ?? canonicalFamily)
      ? { family: overrides.family ?? canonicalFamily }
      : {}),
    ...(overrides.category ? { category: overrides.category } : {}),
  };

  return {
    sourceIds: finalSourceIds,
    ...(mobRole ? { mobRole } : {}),
    injections,
    ...(Object.keys(overrides).length > 0 ? { injectionOverrides: overrides } : {}),
  };
}

export function directionAddendaFromContext(context?: AssetRequestContext): {
  readonly floor?: string;
  readonly theme?: string;
} {
  if (!context) return {};
  return {
    ...(context.injections.floor ? { floor: context.injections.floor } : {}),
    ...(context.injections.family ? { theme: context.injections.family } : {}),
  };
}

function floorIdForNumber(floor: number | undefined): string | undefined {
  return floor === undefined ? undefined : `floor${floor}`;
}

function floorNumber(floorId: string): number {
  const match = /^floor([1-9]\d*)$/.exec(floorId);
  if (!match) {
    throw new AssetRequestContextError(`Floor id '${floorId}' must use the form floor<N>.`);
  }
  return Number(match[1]);
}

function floorInjection(floor: number): string | undefined {
  return FLOOR_DESIGN_LANGUAGE[floor];
}

function familyInjection(familyId: string): string | undefined {
  return FAMILY_DESIGN_LANGUAGE[familyId as keyof typeof FAMILY_DESIGN_LANGUAGE];
}

function rolesForFamily(
  archetypes: readonly {
    readonly familyId?: string;
    readonly isBoss?: boolean;
    readonly id: string;
  }[],
  familyId: string,
): readonly MobRole[] {
  return MOB_ROLES.filter((role) =>
    archetypes.some(
      (archetype) => archetype.familyId === familyId && roleForArchetype(archetype) === role,
    ),
  );
}

function roleForArchetype(archetype: { readonly id: string; readonly isBoss?: boolean }): MobRole {
  if (archetype.isBoss) return 'boss';
  return archetype.id.includes('-elite-') ? 'elite' : 'normal';
}

function normalizeOptionalId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new AssetRequestContextError(`${field} must be a lowercase kebab-case identifier.`);
  }
  return normalized;
}

function normalizeInjectionOverrides(
  overrides: DirectionInjectionOverrides | undefined,
): DirectionInjectionOverrides {
  if (!overrides) return {};
  return {
    ...(overrides.floor !== undefined
      ? { floor: normalizeInjection(overrides.floor, 'floor') }
      : {}),
    ...(overrides.family !== undefined
      ? { family: normalizeInjection(overrides.family, 'family') }
      : {}),
    ...(overrides.category !== undefined
      ? { category: normalizeInjection(overrides.category, 'category') }
      : {}),
  };
}

function normalizeInjection(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INJECTION_LENGTH) {
    throw new AssetRequestContextError(
      `${label} injection override must contain 1-${MAX_INJECTION_LENGTH} characters.`,
    );
  }
  return trimmed;
}
