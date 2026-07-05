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
 * - Every collision-grid entity in a real Floor 1 seed-42 run has a valid
 *   Size. Regression = spawner forgot Size ⇒ CI failure at PR time.
 *
 * ## What this guard does NOT prove (documented Slice-1 follow-up)
 * - Floor 2+ spawners fire (they are not reached in an 800-frame run). New
 *   spawners in `floor2Scenario.ts` etc. can regress silently until Slice 2
 *   or a later slice extends this check to a multi-floor sweep or a static
 *   per-archetype enumeration. Complementary defenses in place today:
 *   `check-physics-defs-sync.ts` (drift vs entity-sizing.md), the ESLint
 *   `no-restricted-syntax` rule blocking new `sprite.width|height` reads
 *   outside `src/engine/**`+`src/labs/**`, and unit tests
 *   `tests/ecs/spawners/*.test.ts` that assert Size at spawn time.
 *
 * Wired into `verify:fast` per the Slice-1 spec.
 */

import { Report } from '../shared/report.js';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
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
      `Size coverage FAILED: ${count} sprite-fallback reads across ${uniqueEids} entities during headless run (seed=${COVERAGE_SEED}, frames=${stats.totalFrames}). Add Size to the spawner that produced those entities. Enable globalThis.__CRAWLER_PHYSICS_BODY_SHIM_WARN__ to identify the eids.`,
      { file: 'src/core/spawners/' },
    );
  }
  report.finish();
}

main().catch((err) => {
  report.error(`check-size-coverage crashed: ${err instanceof Error ? err.message : String(err)}`);
  report.finish();
});
