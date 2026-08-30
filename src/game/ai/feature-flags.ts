import { resolveOptionalPurchases, type OptionalPurchasesConfig } from './optional-purchases.js';

export interface AiFeatureFlagContext {
  surface: 'lab' | 'headless';
  floorId: string;
}

const AI_FEATURE_FLAG_DEFINITIONS = [
  {
    key: 'weaponPersonas',
    label: 'Weapon personas',
    defaultEnabled: (_context: AiFeatureFlagContext) => true,
    resolve: undefined,
  },
  {
    key: 'optionalPurchases',
    label: 'Optional purchases (merchant + broker)',
    defaultEnabled: (_context: AiFeatureFlagContext) => true,
    resolve: (input: OptionalPurchasesConfig) => resolveOptionalPurchases(input),
  },
  {
    key: 'settlementReturnRouting',
    label: 'Settlement return routing',
    defaultEnabled: (context: AiFeatureFlagContext) =>
      context.surface === 'lab' || context.floorId === 'floor1',
    resolve: undefined,
  },
] as const;

export type AiFeatureFlagKey = (typeof AI_FEATURE_FLAG_DEFINITIONS)[number]['key'];
export type AiFeatureFlags = Record<AiFeatureFlagKey, boolean>;
export type AiFeatureFlagInput = Partial<AiFeatureFlags> & OptionalPurchasesConfig;

export function getAiFeatureFlagControls(): ReadonlyArray<{
  key: AiFeatureFlagKey;
  label: string;
}> {
  return AI_FEATURE_FLAG_DEFINITIONS.map(({ key, label }) => ({ key, label }));
}

export function resolveAiFeatureFlags(
  input: AiFeatureFlagInput,
  context: AiFeatureFlagContext,
): AiFeatureFlags {
  const resolved = {} as AiFeatureFlags;
  for (const definition of AI_FEATURE_FLAG_DEFINITIONS) {
    resolved[definition.key] =
      input[definition.key] ?? definition.resolve?.(input) ?? definition.defaultEnabled(context);
  }
  return resolved;
}
