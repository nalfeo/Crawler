/**
 * Single source of truth for the **sweep leg matrix** — exactly which runs the
 * PR tier and the release tier execute.
 *
 * This lives in one module (rather than spread across two workflow YAMLs) so
 * the run counts, seed panels, gating, and floor coverage are reviewable in one
 * place and testable without dispatching a workflow. CI reads it to build its
 * shard matrix; a test asserts the totals so a careless edit that doubles CI
 * cost or silently drops a floor fails loudly.
 *
 * ## Why the tiers differ
 *
 * The PR tier optimizes for **fast regression detection**: it does not force a
 * starter weapon, so each seed runs once with its own seed-selected weapon and
 * the run count stays `seeds`, not `seeds × weapons`. Weapon spread comes from
 * the seed panel. Per-weapon *balance* is deliberately NOT a PR concern.
 *
 * The release tier optimizes for **balance measurement**: Floor 1 runs the full
 * weapon cross-product, which is what the existing baseline-regression check
 * consumes when it files a regression issue.
 */
import { getImplementedFloorIds } from '../../../src/shared/floor-registry.js';
import { resolveFloorChain } from '../../../src/game/ai/progression-runner.js';

export interface SweepLeg {
  /** Stable id, also used as the release baseline's per-leg key. */
  id: string;
  /** Floor the leg starts on. */
  floorId: string;
  /** Inclusive seed range, as the `--seeds` CLI spec. */
  seeds: string;
  /** Number of seeds the spec expands to. */
  seedCount: number;
  /**
   * Weapons forced across the seed panel, or `null` to let each seed select its
   * own (the `--no-force-weapon` mode).
   */
  weapons: readonly string[] | null;
  /** True when the leg chains through the whole implemented floor chain. */
  chain: boolean;
  /**
   * True when a win-rate drop on this leg fails the job. Report-only legs still
   * run and still publish numbers; they just never block.
   */
  blocking: boolean;
  /** Total runs this leg executes. */
  runs: number;
}

/** Full Floor-1 starter weapon set, used by the release tier's balance leg. */
export const RELEASE_FLOOR1_WEAPONS = [
  'sword',
  'bow',
  'baseball-bat',
  'pistol',
  'throwing-knife',
  'fireball',
] as const;

function leg(spec: Omit<SweepLeg, 'runs'>): SweepLeg {
  return { ...spec, runs: spec.seedCount * (spec.weapons?.length ?? 1) };
}

/**
 * PR tier — 50 runs.
 *
 * Floor 1 is the only blocking leg. The chained leg's seeds are a strict subset
 * of the Floor-1 leg's panel (1-10 ⊂ 1-25) so a chained failure can be read
 * directly against that same seed's standalone Floor-1 result instead of being
 * confounded by a different seed panel.
 */
export const PR_SWEEP_LEGS: readonly SweepLeg[] = [
  leg({
    id: 'floor1',
    floorId: 'floor1',
    seeds: '1-25',
    seedCount: 25,
    weapons: null,
    chain: false,
    blocking: true,
  }),
  leg({
    id: 'floor1-chain',
    floorId: 'floor1',
    seeds: '1-10',
    seedCount: 10,
    weapons: null,
    chain: true,
    blocking: false,
  }),
  leg({
    id: 'floor2',
    floorId: 'floor2',
    seeds: '1-15',
    seedCount: 15,
    weapons: null,
    chain: false,
    blocking: false,
  }),
];

/**
 * Release tier — 600 runs, the same total as today, redistributed across the
 * three legs exactly as specified in the approved methodology.
 *
 * Only Floor 1 forces weapons: this leg is what per-weapon balance and the
 * existing baseline-regression issue filing are measured on.
 *
 * NOTE: resizing the Floor-1 leg from 600 → 300 runs is an intentional sweep
 * resize. The baseline-regression check refuses to compare across differing run
 * counts, so this rollout carries an explicit series migration
 * (`RELEASE_SWEEP_REVISION`) — the sanctioned "reset or migrate the series"
 * path named in that check's own error message. It is NOT a silent weakening:
 * comparisons resume, at full strength, from the first release captured under
 * the new revision.
 */
export const RELEASE_SWEEP_LEGS: readonly SweepLeg[] = [
  leg({
    id: 'floor1',
    floorId: 'floor1',
    seeds: '1-50',
    seedCount: 50,
    weapons: RELEASE_FLOOR1_WEAPONS,
    chain: false,
    blocking: true,
  }),
  leg({
    id: 'floor2',
    floorId: 'floor2',
    seeds: '1-150',
    seedCount: 150,
    weapons: null,
    chain: false,
    blocking: false,
  }),
  leg({
    id: 'floor1-chain',
    floorId: 'floor1',
    seeds: '1-150',
    seedCount: 150,
    weapons: null,
    chain: true,
    blocking: false,
  }),
];

/**
 * Identity of the release sweep matrix. Bump this whenever a leg's run count
 * changes; baselines carrying different revisions are not comparable and the
 * regression check reports that instead of throwing or comparing apples to
 * oranges.
 *
 * `2` = the multi-floor matrix above (Floor 1 resized 100→50 seeds, Floor 2 and
 * the chained leg added). `1` was the Floor-1-only 100-seed × 6-weapon sweep.
 */
export const RELEASE_SWEEP_REVISION = 2;

export function totalRuns(legs: readonly SweepLeg[]): number {
  return legs.reduce((sum, l) => sum + l.runs, 0);
}

/** Build the CLI flags for a leg, in a stable order. */
export function legCliArgs(l: SweepLeg, outPath: string): string[] {
  const args = ['--floor', l.floorId, '--seeds', l.seeds, '--out', outPath];
  if (l.weapons) {
    args.push('--weapons', l.weapons.join(','));
  } else {
    args.push('--no-force-weapon');
  }
  if (l.chain) args.push('--chain');
  return args;
}

/**
 * Every implemented floor must be covered by at least one leg of a tier —
 * otherwise completing a floor silently leaves it unswept, which is the exact
 * gap this methodology exists to close. A chained leg covers every floor in the
 * chain it traverses, so it counts for the floors after its start floor.
 */
export function uncoveredImplementedFloors(legs: readonly SweepLeg[]): string[] {
  const implemented = getImplementedFloorIds();
  const covered = new Set<string>();
  for (const l of legs) {
    covered.add(l.floorId);
    if (l.chain) {
      // A chained leg covers exactly the floors the runner actually traverses,
      // which follows each scenario's `nextFloorId` — NOT registry order. A
      // floor registered after the start floor but disconnected from (or skipped
      // by) the scenario graph is never reached, so it must stay uncovered.
      for (const floorId of resolveFloorChain(l.floorId)) covered.add(floorId);
    }
  }
  return implemented.filter((floorId) => !covered.has(floorId));
}
