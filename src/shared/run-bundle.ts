/**
 * Pipeline-neutral run artifact contracts.
 *
 * The concrete RunStats shape belongs to the game/AI layer. Keeping this
 * contract generic lets the engine transport a run artifact without importing
 * game code across the layer boundary.
 */

export type RunEndReason = 'death' | 'victory' | 'timeout' | 'quit';

export interface RunBundleMeta {
  readonly endReason: RunEndReason;
  readonly floorId?: string;
  readonly seed?: number;
}

export interface RunBundle<TRunStats = unknown> {
  readonly runStats: TRunStats;
  readonly recorderJsonl: string;
  readonly logs: readonly string[];
  readonly meta: RunBundleMeta;
}

export interface RunBundleInput<TRunStats> {
  readonly runStats: TRunStats;
  readonly recorderJsonl?: string;
  readonly logs?: readonly string[];
  readonly meta: RunBundleMeta;
}

export function createRunBundle<TRunStats>(input: RunBundleInput<TRunStats>): RunBundle<TRunStats> {
  return {
    runStats: input.runStats,
    recorderJsonl: input.recorderJsonl ?? '',
    logs: [...(input.logs ?? [])],
    meta: { ...input.meta },
  };
}
