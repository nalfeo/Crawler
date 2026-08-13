#!/usr/bin/env node
/**
 * health/check-size-coverage.ts — Run a short deterministic headless Floor 1
 * slice and assert every entity that entered the collision grid had a valid
 * `Size` component (radius > 0, OR halfWidth > 0 AND halfHeight > 0).
 *
 * Coverage is measured via the shim counter in `src/core/physics-body.ts`:
 * every `getBodyHalfWidth/Height/Radius` call on a Size-less entity bumps
 * the counter. A green run means every spawner that fires on Floor 1 in
 * this deterministic slice attaches `Size`.
 *
 * ## What this guard PROVES
 * - For the ~800 frames of Floor 1 seed-42 exercised here, every entity that
 *   any core/game system routed through the physics-body helpers had a
 *   valid Size. Shim-counter == 0 ⇒ no spawner on that path forgot Size.
 *
 * ## What this guard does NOT prove
 * - It is a live-path assertion, not a static enumeration. Entities in
 *   spawners that never fire in this deterministic 800-frame slice (Floor
 *   2+ scenarios, later mob waves, boss-only spawners, one-shot event
 *   spawners) can still regress silently. Extending this to a multi-floor
 *   sweep or a static per-spawner enumeration is a documented Slice-2+
 *   follow-up.
 * - The ESLint `no-restricted-syntax` rule blocks *new* `sprite.width|
 *   height` reads outside `src/engine/**`+`src/labs/**`, but does not by
 *   itself prove existing readers migrated correctly — this guard is what
 *   makes that concrete for the covered live path.
 * - `check-physics-defs-sync.ts` guards the registry ↔ doc table
 *   alignment; it does not exercise spawners.
 *
 * Wired into `verify:fast` per the Slice-1 spec.
 */

import { Report } from '../shared/report.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { getShimStats, resetShimStats } from '../../../src/core/physics-body.js';

const report = new Report('check-size-coverage');

const COVERAGE_SEED = 42;
const COVERAGE_MAX_FRAMES = 800;

async function main(): Promise<void> {
  resetShimStats();
  const ai = new BehaviorTreeAI({ seed: COVERAGE_SEED });
  const stats = await runHeadless(ai, {
    seed: COVERAGE_SEED,
    maxFrames: COVERAGE_MAX_FRAMES,
    planningMaxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
  });

  // Non-vacuity: the run must actually spawn combat and land hits, otherwise
  // there is no collision-grid activity to prove Size coverage against.
  if (stats.combat.damageDealt <= 0) {
    report.error(
      `headless coverage run produced no combat damage (seed=${COVERAGE_SEED}, frames=${stats.totalFrames}); Size coverage cannot be verified against a silent run`,
    );
    report.finish();
    return;
  }

  const { count, uniqueEids } = getShimStats();
  if (count === 0) {
    report.info(
      `OK: seed=${COVERAGE_SEED} frames=${stats.totalFrames} damage=${stats.combat.damageDealt} — every collision-grid entity had a valid Size (0 shim fallbacks)`,
    );
  } else {
    report.error(
      `Size coverage FAILED: ${count} missing-Size helper reads across ${uniqueEids} entities during headless run (seed=${COVERAGE_SEED}, frames=${stats.totalFrames}). Add Size to the spawner that produced those entities. Check the logger output (core:physics-body) for per-eid warn messages identifying which eids are missing Size.`,
      { file: 'src/core/spawners/' },
    );
  }
  report.finish();
}

main().catch((err) => {
  report.error(`check-size-coverage crashed: ${err instanceof Error ? err.message : String(err)}`);
  report.finish();
});
