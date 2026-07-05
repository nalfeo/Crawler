#!/usr/bin/env node
/**
 * health/check-weight-coverage.ts — Run a short deterministic headless Floor 1
 * slice and assert that every entity with `Enemy`, `Player`, or `Prop`
 * carries a positive `Weight.value`.
 *
 * ## Contract
 *
 * Per spec `.specify/specs/entity-physics.md` R2 (post-#769 realignment) and
 * ADR 0044, every knockback-eligible entity MUST carry a positive weight —
 * including Immovable props (a 10 000 lb wall is exactly what trips
 * `IMMOVABLE_THRESHOLD`; Immovable governs displacement, not weight
 * presence). `knockbackSystem` divides by `weight` to scale displacement
 * (Slice 2), so a weight of 0 or unset would produce nonsense (either an
 * infinite scale or a divide-by-baseline fallback that silently masks a
 * spawner regression).
 *
 * ## What this guard PROVES
 * - After a real headless seed-42 Floor-1 slice, every live entity with
 *   `Enemy | Player | Prop` has `weight.value > 0`. Regression = spawner
 *   forgot Weight ⇒ CI failure at PR time.
 *
 * ## What this guard does NOT prove
 * - Floor 2+ spawners fire (they're not reached in an 800-frame slice).
 *   Complementary defenses: `check-physics-defs-sync.ts` (drift vs
 *   entity-sizing.md) and per-spawner unit tests.
 * - Enemies that die and get culled before the snapshot are not checked
 *   (removed from queries). Since Weight is attached at spawn time by the
 *   same code path for every enemy of a given def, the surviving cohort is
 *   representative — a broken spawner would produce zero-weight survivors
 *   too.
 *
 * Wired into `verify:fast` alongside `check-size-coverage.ts` (Slice 1
 * pattern).
 */

import { hasComponent } from 'bitecs';
import { Report } from '../shared/report.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { Enemy, Player, Prop } from '../../../src/core/components.js';
import type { GameWorld } from '../../../src/core/world.js';

const report = new Report('check-weight-coverage');

const COVERAGE_SEED = 42;
const COVERAGE_MAX_FRAMES = 800;

interface WeightFailure {
  readonly eid: number;
  readonly weight: number;
  readonly kind: 'Enemy' | 'Player' | 'Prop';
}

function inspectWeights(world: GameWorld): { checked: number; failures: WeightFailure[] } {
  const failures: WeightFailure[] = [];
  let checked = 0;
  const weightStore = world.stores.weight;
  // Walk the entire eid range using the presence of Position as the
  // "live entity" proxy (every gameplay entity has Position). Enemies/
  // Players/Props then filter down via component tags.
  const positionX = world.stores.position.x;
  const maxEid = positionX.length;
  for (let eid = 0; eid < maxEid; eid++) {
    // bitecs stores are zero-initialized; a lack of position means either
    // the eid was never allocated or it belonged to a non-positioned
    // entity type we don't care about here.
    let kind: WeightFailure['kind'] | null = null;
    if (hasComponent(world.ecs, eid, Enemy)) {
      kind = 'Enemy';
    } else if (hasComponent(world.ecs, eid, Player)) {
      kind = 'Player';
    } else if (hasComponent(world.ecs, eid, Prop)) {
      kind = 'Prop';
    }
    if (kind === null) continue;
    checked += 1;
    const weight = weightStore.value[eid] ?? 0;
    if (weight <= 0) {
      failures.push({ eid, weight, kind });
    }
  }
  return { checked, failures };
}

async function main(): Promise<void> {
  let snapshot: { checked: number; failures: WeightFailure[] } | null = null;

  const ai = new BehaviorTreeAI({ seed: COVERAGE_SEED });
  const stats = await runHeadless(ai, {
    seed: COVERAGE_SEED,
    maxFrames: COVERAGE_MAX_FRAMES,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
    onFinish: (world) => {
      snapshot = inspectWeights(world);
    },
  });

  if (snapshot === null) {
    report.error(
      'onFinish inspection did not run — headless runner did not expose the world snapshot.',
    );
    report.finish();
    return;
  }

  // Non-vacuity: the run must have observed knockback-eligible entities,
  // otherwise the guard is inert.
  const captured: { checked: number; failures: WeightFailure[] } = snapshot;
  if (captured.checked === 0) {
    report.error(
      `weight coverage FAILED: no Enemy/Player/Prop entities alive at end of headless run (seed=${COVERAGE_SEED}, frames=${stats.totalFrames}). The guard cannot verify coverage against a silent snapshot — investigate spawners.`,
    );
    report.finish();
    return;
  }

  if (captured.failures.length === 0) {
    report.info(
      `OK: seed=${COVERAGE_SEED} frames=${stats.totalFrames} — every Enemy/Player/Prop had positive Weight (${captured.checked} entities checked).`,
    );
  } else {
    const sample = captured.failures
      .slice(0, 10)
      .map((f) => `eid=${f.eid} kind=${f.kind} weight=${f.weight}`)
      .join('; ');
    report.error(
      `Weight coverage FAILED: ${captured.failures.length} of ${captured.checked} knockback-eligible entities had weight <= 0 at end of headless run (seed=${COVERAGE_SEED}, frames=${stats.totalFrames}). Sample: ${sample}. Add Weight to the spawner that produced these entities (see src/core/spawners/).`,
      { file: 'src/core/spawners/' },
    );
  }
  report.finish();
}

main().catch((err) => {
  report.error(
    `check-weight-coverage crashed: ${err instanceof Error ? err.message : String(err)}`,
  );
  report.finish();
});
