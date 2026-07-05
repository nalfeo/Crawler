/**
 * Slice-1 collision-pair parity guard (spec R8).
 *
 * The Size component + `physics-body.ts` helper migration must be
 * *bit-identical* to the legacy sprite-half-extent path: every numeric Size
 * value in the registry equals today's shipping sprite half-extent, and every
 * consumer that used to read `sprite.width|height` now reads through the
 * helper. If a spawner or migrated consumer drifts, the collision grid's
 * per-frame pair set changes, cascades through `applyDamage`'s RNG draws, and
 * the deterministic `RunStats` differ from the golden below.
 *
 * We run a short headless Floor 1 slice on a fixed seed with the default
 * behavior tree AI and compare a stable subset of `RunStats` against a
 * **golden fingerprint captured on `feat/size-weight-design`** — the branch
 * this slice is stacked on, i.e. the "legacy sprite" pre-migration state. If
 * the fingerprint drifts, that is a real semantic divergence — root-cause
 * it, don't bump the golden.
 *
 * The full determinism cascade (grid vs legacy full-scan) is covered by
 * `tests/headless/melee-broadphase-pipeline-determinism.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';

const PARITY_SEED = 42;
const PARITY_MAX_FRAMES = 1500;

interface CollisionFingerprint {
  totalFrames: number;
  outcome: RunStats['outcome'];
  kills: number;
  damageDealt: number;
  damageTaken: number;
  finalScore: number;
}

/**
 * Fingerprint captured on Slice 1's rebased parent commit — current `main`
 * tip `4ab04365` (feat: distance-from-spawn mob level scaling, #781) — with
 * ZERO Slice-1 code applied. This is the "legacy sprite half-extent" path
 * on the branch's actual base, not the stale `feat/size-weight-design`
 * design branch this slice was originally drafted against.
 *
 * ## Neutrality proof
 *
 * The guard's purpose is to prove the Size migration is byte-identical to
 * the pre-migration sprite path. That was verified via a differential B vs
 * H measurement on this same fingerprint:
 *
 *   B (parent 4ab04365, no Slice-1 code):
 *     kills=7 damageDealt=261 damageTaken=25 finalScore=8 outcome=timeout
 *   H (Slice-1 HEAD, all Slice-1 commits applied):
 *     kills=7 damageDealt=261 damageTaken=25 finalScore=8 outcome=timeout
 *
 * B == H → migration is inert. The prior golden values
 * `{kills:6, damageDealt:212.5, damageTaken:10, finalScore:5}` were
 * captured on `feat/size-weight-design@e8ae8adb` before three unrelated
 * PRs shifted Floor-1 seed-42 gameplay:
 *   - #764 spawnerArenaSystem (arena locks/fences/banked-XP)
 *   - #765 Floor-1 quest-NPC consolidation
 *   - #781 distance-from-spawn mob level scaling
 * None of that drift is Slice-1's doing. The guard still works — it now
 * detects regressions against the CURRENT base, which is what it's for.
 *
 * Regenerate this ONLY when the base branch has moved AND the run is
 * genuinely divergent for a documented reason, and record a fresh B==H
 * proof at that time.
 */
const GOLDEN_FINGERPRINT: CollisionFingerprint = {
  totalFrames: 1500,
  outcome: 'timeout',
  kills: 7,
  damageDealt: 261,
  damageTaken: 25,
  finalScore: 8,
};

async function runSlice(seed: number): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed });
  return runHeadless(ai, {
    seed,
    maxFrames: PARITY_MAX_FRAMES,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
  });
}

function fingerprint(stats: RunStats): CollisionFingerprint {
  return {
    totalFrames: stats.totalFrames,
    outcome: stats.outcome,
    kills: stats.combat.totalKills,
    damageDealt: stats.combat.damageDealt,
    damageTaken: stats.combat.damageTaken,
    finalScore: stats.finalScore,
  };
}

describe('collision-pair parity (Slice 1)', () => {
  it(`seed ${PARITY_SEED} run matches the legacy-sprite golden fingerprint`, async () => {
    const a = await runSlice(PARITY_SEED);

    // Non-vacuity: the run must actually spawn enemies and land hits, otherwise
    // the parity assertion would trivially hold with an empty collision grid.
    expect(a.combat.damageDealt).toBeGreaterThan(0);

    // Byte-identity vs the pre-migration base-branch fingerprint. Any drift
    // means Size migration changed collision-driven behavior — root-cause it.
    expect(fingerprint(a)).toEqual(GOLDEN_FINGERPRINT);
  });

  it('parity run is deterministic across two invocations', async () => {
    const a = await runSlice(PARITY_SEED);
    const b = await runSlice(PARITY_SEED);
    expect(fingerprint(b)).toEqual(fingerprint(a));
  });
});
