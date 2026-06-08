/**
 * Shared status types and pure utility functions for the art-plan lifecycle.
 *
 * Imported by both the browser DevTools model (src/devtools/art-plan-model.ts)
 * and the Node CLI model (scripts/sprites/asset-plan.ts) so the two
 * implementations stay in sync.
 */

export type IntegrationState = 'integrated' | 'missing' | 'not-applicable';

/** All possible per-asset lifecycle statuses, ordered from most to least complete. */
export type ArtPlanStatus =
  | 'ready'
  | 'approved'
  | 'approved-not-integrated'
  | 'approved-missing-file'
  | 'brief-ready'
  | 'brief-ready-placeholder'
  | 'needs-art-placeholder'
  | 'planned';

type IntegrationTargetLike =
  | { readonly kind: 'sprite-registry'; readonly id: string }
  | { readonly kind: 'item-catalog'; readonly id: string };

export function resolveIntegrationState(
  target: IntegrationTargetLike | undefined,
  approvedAssetExists: boolean,
  spriteIds: ReadonlySet<string>,
  itemIds: ReadonlySet<string>,
): IntegrationState {
  if (!target) return 'not-applicable';
  if (target.kind === 'sprite-registry') {
    return spriteIds.has(target.id) ? 'integrated' : 'missing';
  }
  return itemIds.has(target.id) && approvedAssetExists ? 'integrated' : 'missing';
}

export function resolveArtPlanStatus(args: {
  readonly briefAuthored: boolean;
  readonly approved: boolean;
  readonly approvedAssetExists: boolean;
  readonly integrationState: IntegrationState;
  readonly placeholderInUse: boolean;
}): ArtPlanStatus {
  if (args.approved && !args.approvedAssetExists) return 'approved-missing-file';
  if (args.approved && args.integrationState === 'integrated') return 'ready';
  if (args.approved && args.integrationState === 'not-applicable') return 'approved';
  if (args.approved) return 'approved-not-integrated';
  if (args.briefAuthored && args.placeholderInUse) return 'brief-ready-placeholder';
  if (args.briefAuthored) return 'brief-ready';
  if (args.placeholderInUse) return 'needs-art-placeholder';
  return 'planned';
}

export function briefKey(type: string, name: string): string {
  return `${type}::${name}`;
}
