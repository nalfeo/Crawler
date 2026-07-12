/**
 * NAVMESH_FUSED determinism guard (Slice 4a + 4b seam term).
 *
 * NAVMESH_FUSED composes three already-deterministic layers: the Slice-3 recast
 * waypoint route (a PURE query — its cross-platform byte-identity is locked by
 * the navmesh-determinism golden 75917f12), the RISK_REWARD_FUSED danger/reward
 * fan applied at FOLLOW level (its own determinism is locked by
 * fused-pathing-determinism.test.ts), and — as of Slice 4b — the tangential
 * seam-following term that rides ON TOP of that fan at the shipped weight
 * (NAVMESH_FUSED_SEAM_WEIGHT = 2, the operator-adjudicated production weight).
 * This test proves the COMPOSITION is still bit-reproducible end-to-end: the
 * fused fan sums a float danger field over a bitecs enemy `query()`, the seam
 * term adds a centered-gradient tangent alignment bonus, an argmax runs over a
 * fixed 13-candidate heading fan, and `prevFusedDir` continuity state carries
 * across the navmesh-driven travel polls — so an argmax near-tie or a continuity
 * cascade on the navmesh heading could in principle diverge run-to-run without
 * ANY component golden catching it (none exercises navmesh-route + fused-follow +
 * seam together).
 *
 * Same-seed byte-identity ONLY. The functional wiring proof — that NAVMESH_FUSED
 * genuinely runs the recast route AND the fused fan AND (at weight > 0) the seam
 * block — is the DETERMINISTIC unit assertion in
 * tests/unit/ai/navmesh-pathing.test.ts (getFusedDebug() non-null + navWaypoints
 * populated + the seam counter climbing at weight 2). A headless "fingerprint
 * differs from pure-NAVMESH on \u22651 seed" gate was deliberately NOT added here: it
 * is brittle (2026-07-08 plan review, concern #1) because two modes can
 * legitimately coincide on a given seed set without either being inert, so it
 * belongs in the deterministic unit test, not a full-run fingerprint diff.
 *
 * maxWallTimeMs is Infinity on purpose: sim correctness is frame-based, so a slow
 * CI box must NOT truncate a run mid-flight and manufacture a false mismatch.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIPathingMode } from '../../src/game/ai/types.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { GAME } from '../../src/shared/constants.js';

// Full Floor-1 budget (mirrors the ai:navmesh-sweep harness) so the run clears
// the welcome-room set piece and actually engages enemies before it ends.
const MAX_FRAMES = Math.ceil((6 * 60 * 1000 * 1.1) / GAME.DELTA_MS);
const WEAPON = 'sword';
const SEEDS = [42, 101] as const;
const DETERMINISM_TIMEOUT_MS = 300_000;

interface Fingerprint {
  totalFrames: number;
  outcome: RunStats['outcome'];
  kills: number;
  damageDealt: number;
  damageTaken: number;
  finalScore: number;
}

function fingerprint(s: RunStats): Fingerprint {
  return {
    totalFrames: s.totalFrames,
    outcome: s.outcome,
    kills: s.combat.totalKills,
    damageDealt: s.combat.damageDealt,
    damageTaken: s.combat.damageTaken,
    finalScore: s.finalScore,
  };
}

// runHeadless awaits initNavmesh() internally for navmesh-routed modes, so this
// test does not need to init the recast runtime itself. seamWeight is left to the
// default (NAVMESH_FUSED_SEAM_WEIGHT = 2) on purpose: this golden tracks the
// SHIPPED NAVMESH_FUSED behavior, so it always locks determinism of whatever seam
// weight production runs — currently the operator-adjudicated W=2.
async function runSlice(seed: number): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed, pathingMode: AIPathingMode.NAVMESH_FUSED });
  return runHeadless(ai, {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
    forceWeaponId: WEAPON,
    floorId: 'floor1',
  });
}

describe('NAVMESH_FUSED — determinism guard', () => {
  for (const seed of SEEDS) {
    it(
      `seed ${seed}: navmesh-fused run is byte-identical across two invocations`,
      async () => {
        const a = await runSlice(seed);
        const b = await runSlice(seed);

        // Non-vacuity: the fused danger fan is only exercised when enemies are
        // perceived along the navmesh route, so require the run to have landed hits
        // (otherwise the determinism proof would be vacuous for an idle agent).
        expect(a.combat.damageDealt).toBeGreaterThan(0);

        expect(fingerprint(a)).toEqual(fingerprint(b));
      },
      DETERMINISM_TIMEOUT_MS,
    );
  }
});
