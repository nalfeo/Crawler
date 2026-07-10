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
 * Golden fingerprints per seed, captured on the Slice-2 cap head after the
 * design-mandated `KNOCKBACK_WEIGHT_SCALE_MAX = 2.5` refinement to
 * ADR 0044. Each was proven stable across two back-to-back invocations
 * before being pinned here.
 *
 * ## Seed 42 (unchanged from Slice 1's B==H golden)
 *
 * Seed 42 continues to match the Slice-1 legacy-sprite fingerprint
 * `{kills:7, damageDealt:261, damageTaken:25, finalScore:8}` even with
 * weight-divided knockback + cap in place, because on this seed's Floor-1
 * slice the AI's first 1500 frames engage almost exclusively via ranged
 * hits and 120 lb median-mob targets, so the cap and divide-by-weight
 * both resolve to ~1.0× displacement for the mobs that actually take
 * knockback in that window.
 *
 * ## Seeds 7 / 13 / 137 (new, cap-head baselines)
 *
 * Added by Slice 2 (ADR 0044 refinement) as a coverage-hygiene expansion
 * per Rule #9. These were NOT captured pre-cap — the cap is a designed,
 * documented change, so this is an additive expansion of guard coverage
 * on the Slice-2 baseline, not a "moved a value to make a test pass"
 * (which would violate Rule #12).
 *
 * Regenerate ONLY when the base branch has moved AND the run is genuinely
 * divergent for a documented reason. Follow Slice 1's B==H protocol
 * (parent-run == HEAD-run byte-identical on the current base) or the
 * Slice 2 design-authorized re-baseline protocol (2 runs/seed stable +
 * design-owned change documented in ADR + spec + data-table).
 *
 * ## 2026-07-07 re-baseline — Floor 1 spawner-free (ADR 0049)
 *
 * Floor 1's static-spawner spawn table is now intentionally empty
 * (`FLOOR_1_STATIC_SPAWNER_ARCHETYPE_IDS = []`, see floorScenario.ts +
 * ADR 0049), so the four static spawners — and every mob they would have
 * spawned within the 1500-frame slice — no longer exist. This is a
 * design-owned behavior change, verified stable across two back-to-back
 * runs per seed. Before → after (kills / damageDealt / damageTaken / score):
 *   seed   7:  2/118/9/0   →  4/156/10/0
 *   seed  13:  7/229/10/0  →  6/236/5/0
 *   seed  42:  7/261/25/8  →  7/264/10/8   (kills & score unchanged)
 *   seed 137:  4/122/5/0   →  6/230/0/0
 *
 * ## 2026-07-07 re-baseline — welcome-room set piece: spaced NPCs (ADR 0046)
 *
 * The Floor 1 welcome-room set piece now stamps the three quest NPCs (goon,
 * merchant, spell broker) at fixed, SPACED tiles instead of the old clustered
 * spawn, and auto-anchors each NPC's objective tile to where it actually
 * stands (a deliberate, user-approved change — same room, trivially pathable,
 * so no reachability/balance impact). Moving the NPCs shifts their Size-backed
 * collision footprints, which changes the per-frame collision-pair set,
 * cascades through `applyDamage`'s RNG draws, and so drifts these fingerprints.
 * This is NPC-repositioning ONLY: the set piece's cosmetic PROPS are render-only
 * instances on `world.setPieceProps` (NOT entities — see set-piece-render.ts),
 * so they consume no entity ids and are provably non-perturbing (a props-present
 * vs props-skipped run yields byte-identical fingerprints). Verified stable
 * across two back-to-back runs per seed (see the determinism test below).
 * Before → after (kills / damageDealt / damageTaken / score):
 *   seed   7:  4/156/10/0  →  3/125/15/0
 *   seed  13:  6/236/5/0   →  7/211/5/0
 *   seed  42:  7/264/10/8  →  7/279/5/8    (kills & score unchanged)
 *   seed 137:  6/230/0/0   →  5/206/0/2
 *
 * ## 2026-07-08 re-baseline — welcome-room set piece retune: final spaced layout
 *
 * The welcome-room set piece was retuned again (commit 4ce1027b, DATA-ONLY in
 * `set-pieces.json`) to the maintainer-approved final layout: the Goon pinned to
 * the back wall behind his welcome desk, the merchant and spell broker spaced to
 * opposite sides by their shop table and overstuffed bookcase. This moves all
 * three quest NPCs to new tiles (their `x` tiles shift 7→1 / 1→6 / 6→7), which
 * shifts their Size-backed collision footprints, changes the per-frame
 * collision-pair set, and cascades through `applyDamage`'s RNG draws — the same
 * NPC-repositioning mechanism as the 2026-07-07 block. Bisected and proven to be
 * NPC-data-only: this guard still passes 5/5 at the pre-retune commit 7677075e
 * (with every structural change already present — feet-based sizing schema, stamp
 * plumbing, contain-fit rendering, and props stamped), and drifts ONLY once the
 * NPC tile data moves at 4ce1027b. So the newly-added/retuned cosmetic PROPS stay
 * render-only, non-entity instances on `world.setPieceProps` (provably
 * non-perturbing) and NPC placement is the sole cause. A deliberate, user-approved
 * change — same room, trivially pathable, no reachability/balance impact (the
 * Floor-1 win-rate sweep in `floor1-completion.test.ts` stays green). Verified
 * stable across two back-to-back runs per seed. Seed 7's first-1500-frame path
 * never reaches the moved tiles, so it is unchanged.
 * Before → after (kills / damageDealt / damageTaken / score):
 *   seed   7:  3/125/15/0  →  3/125/15/0   (unchanged)
 *   seed  13:  7/211/5/0   →  8/228/5/0
 *   seed  42:  7/279/5/8   →  6/236/10/4
 *   seed 137:  5/206/0/2   →  5/226/5/2
 *
 * ## 2026-07-09 re-baseline — set-piece NPC transform metadata in runtime
 *
 * This branch threads authored NPC visual metadata through the real runtime:
 * set-piece stamp now carries NPC z/size/transform fields into spawn options,
 * and the bridge applies per-instance NPC display sizing/depth/flip/rotation.
 * Those authored welcome-room NPC transforms shift early collision occupancy in
 * the first 1500-frame headless slice and therefore drift the deterministic
 * combat fingerprint values. Re-baseline is pinned only after proving every
 * seed remains deterministic across two back-to-back invocations.
 * Before → after (kills / damageDealt / damageTaken / score):
 *   seed   7:  3/125/15/0   →  4/156/10/0
 *   seed  13:  8/228/5/0    →  7/190/5/0
 *   seed  42:  6/236/10/4   →  4/193/15/2
 *   seed 137:  5/226/5/2    →  4/190/0/0
 */
const GOLDEN_FINGERPRINTS: Record<number, CollisionFingerprint> = {
  42: {
    totalFrames: 1500,
    outcome: 'timeout',
    kills: 4,
    damageDealt: 193,
    damageTaken: 15,
    finalScore: 2,
  },
  7: {
    totalFrames: 1500,
    outcome: 'timeout',
    kills: 4,
    damageDealt: 156,
    damageTaken: 10,
    finalScore: 0,
  },
  13: {
    totalFrames: 1500,
    outcome: 'timeout',
    kills: 7,
    damageDealt: 190,
    damageTaken: 5,
    finalScore: 0,
  },
  137: {
    totalFrames: 1500,
    outcome: 'timeout',
    kills: 4,
    damageDealt: 190,
    damageTaken: 0,
    finalScore: 0,
  },
};

const PARITY_SEEDS = Object.keys(GOLDEN_FINGERPRINTS).map(Number);

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
  for (const seed of PARITY_SEEDS) {
    it(`seed ${seed} run matches the golden fingerprint`, async () => {
      const a = await runSlice(seed);

      // Non-vacuity: the run must actually spawn enemies and land hits, otherwise
      // the parity assertion would trivially hold with an empty collision grid.
      expect(a.combat.damageDealt).toBeGreaterThan(0);

      // Byte-identity vs the pinned per-seed fingerprint. Any drift means a
      // change to collision-driven behavior — root-cause it, don't bump.
      expect(fingerprint(a)).toEqual(GOLDEN_FINGERPRINTS[seed]);
    });
  }

  it('rebaselined seeds are deterministic across two invocations', async () => {
    // Cover every rebaselined seed (not just one), since the ADR 0049
    // re-baseline protocol requires each pinned fingerprint to be stable across
    // two back-to-back runs — this is what makes the golden bump honest rather
    // than a snapshot of a flaky run.
    for (const seed of PARITY_SEEDS) {
      const a = await runSlice(seed);
      const b = await runSlice(seed);
      expect(
        fingerprint(b),
        `seed ${seed} is non-deterministic across two back-to-back runs`,
      ).toEqual(fingerprint(a));
    }
  });
});
