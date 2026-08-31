import { resolveOptionalPurchases, type OptionalPurchasesConfig } from './optional-purchases.js';
import { getFloorManifest } from '../../shared/floor-registry.js';

export interface AiFeatureFlagContext {
  surface: 'lab' | 'headless';
  floorId: string;
  /**
   * False when the active target is a synthetic/lab-only scenario preset that
   * swaps out the floor's real content (e.g. a spawner-arena inspection slice)
   * instead of genuine floor gameplay. Headless runs are always real floor
   * targets. Omitted/undefined is treated as `true` so callers unaware of
   * scenario presets (headless, or a lab on its default preset) still see
   * every otherwise-applicable flag as applicable.
   */
  isRealFloorTarget?: boolean;
}

const AI_FEATURE_FLAG_DEFINITIONS = [
  {
    key: 'weaponPersonas',
    label: 'Weapon personas',
    defaultEnabled: (_context: AiFeatureFlagContext) => true,
    resolve: undefined,
    // AI-only toggle: read fresh every frame, so it takes effect immediately.
    reloadRequired: false,
    applicableTo: (_context: AiFeatureFlagContext) => true,
  },
  {
    key: 'optionalPurchases',
    label: 'Optional purchases (merchant + broker)',
    defaultEnabled: (_context: AiFeatureFlagContext) => true,
    resolve: (input: OptionalPurchasesConfig) => resolveOptionalPurchases(input),
    reloadRequired: false,
    applicableTo: (_context: AiFeatureFlagContext) => true,
  },
  {
    key: 'settlementReturnRouting',
    label: 'Settlement return routing',
    defaultEnabled: (context: AiFeatureFlagContext) =>
      context.surface === 'lab' || context.floorId === 'floor1',
    resolve: undefined,
    reloadRequired: false,
    applicableTo: (_context: AiFeatureFlagContext) => true,
  },
  {
    key: 'attackWaves',
    label: 'Attack waves (periodic rat packs)',
    defaultEnabled: (_context: AiFeatureFlagContext) => false,
    resolve: undefined,
    // The system reads world.attackWaveFlags.attackWaves live each frame.
    // This UI control is reload-required because it only configures the world
    // through ScenarioInitializationOptions before play.
    reloadRequired: true,
    applicableTo: (context: AiFeatureFlagContext) =>
      context.isRealFloorTarget !== false &&
      (getFloorManifest(context.floorId)?.behavior.trashAttackWaves ?? false),
  },
  {
    key: 'floor1Spawners',
    label: 'Floor 1 static spawners (2 rats-nest + 2 slime-pool)',
    defaultEnabled: (_context: AiFeatureFlagContext) => false,
    resolve: undefined,
    // Only consulted by `initializeFloor1Scenario` at world-init time (see
    // ScenarioInitializationOptions), so it also only takes effect on restart.
    reloadRequired: true,
    applicableTo: (context: AiFeatureFlagContext) =>
      context.isRealFloorTarget !== false && context.floorId === 'floor1',
  },
] as const;

export type AiFeatureFlagKey = (typeof AI_FEATURE_FLAG_DEFINITIONS)[number]['key'];
export type AiFeatureFlags = Record<AiFeatureFlagKey, boolean>;
export type AiFeatureFlagInput = Partial<AiFeatureFlags> & OptionalPurchasesConfig;

export function getAiFeatureFlagControls(context?: AiFeatureFlagContext): ReadonlyArray<{
  key: AiFeatureFlagKey;
  label: string;
  /** True when a toggle only takes effect on the run's next (re)start. */
  reloadRequired: boolean;
  /** Whether this control can affect the supplied target. */
  applicable: boolean;
}> {
  return AI_FEATURE_FLAG_DEFINITIONS.map(({ key, label, reloadRequired, applicableTo }) => ({
    key,
    label,
    reloadRequired,
    applicable: context === undefined || applicableTo(context),
  }));
}

export function resolveAiFeatureFlags(
  input: AiFeatureFlagInput,
  context: AiFeatureFlagContext,
): AiFeatureFlags {
  const resolved = {} as AiFeatureFlags;
  for (const definition of AI_FEATURE_FLAG_DEFINITIONS) {
    const requested =
      input[definition.key] ?? definition.resolve?.(input) ?? definition.defaultEnabled(context);
    resolved[definition.key] = definition.applicableTo(context) ? requested : false;
  }
  return resolved;
}
