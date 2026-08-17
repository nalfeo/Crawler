/**
 * RISK_REWARD_FUSED determinism + non-inertness guard.
 *
 * The fused pathing scorer (`computeRiskRewardFusedHeading`) sums a float danger
 * field over a bitecs enemy `query()`, runs an argmax over a fixed 13-candidate
 * heading fan, and carries `prevFusedDir` continuity state across travel polls.
 * A seeded/headless engine requires all of that to be bit-reproducible: the same
 * seed + mode must produce a byte-identical run twice. The 2026-07-08 plan review
 * (gpt-5.4, BLOCKING #1) flagged this as UNPROVEN — the legacy collision-pair
 * parity golden never exercises the fused code path, so argmax near-ties or
 * continuity-state cascades could in principle diverge run-to-run without any
 * existing guard catching it.
 *
 * This test closes that gap two ways:
 *   1. DETERMINISM — a full-length fused Floor-1 slice is run twice per seed and
 *      the stable `RunStats` fingerprint must match exactly.
 *   2. NON-INERTNESS — the fused fingerprint must differ from LEGACY on at least
 *      one seed, proving the fused path is genuinely active (not silently
 *      delegating to legacy, which would make the determinism proof vacuous). The
 *      full win-rate divergence lives in the `ai:ab-pathing-mode` sweep; this is
 *      the in-CI proof that the scorer is wired and non-inert (rule #10).
 *
 * Sword is chosen because the danger-field deflection is most active for an
 * aggressive melee closer, so fused reliably diverges from legacy there.
 *
 * `maxWallTimeMs` is Infinity on purpose: sim correctness is frame-based, so a
 * slow CI box must NOT be allowed to truncate a run mid-flight and manufacture a
 * false fingerprint mismatch.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIPathingMode } from '../../src/game/ai/types.js';
import type { AIPathingModeValue, RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';

// Full Floor-1 budget (mirrors the ai:ab-pathing-mode harness) so the run clears
// the welcome-room set piece and actually engages enemies before it ends.
const MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;
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

async function runSlice(seed: number, mode: AIPathingModeValue): Promise<RunStats> {
  const ai = new BehaviorTreeAI({ seed, pathingMode: mode });
  return runHeadless(ai, {
    seed,
    maxFrames: MAX_FRAMES,
    maxWallTimeMs: Number.POSITIVE_INFINITY,
    forceWeaponId: WEAPON,
    floorId: 'floor1',
  });
}

describe('RISK_REWARD_FUSED — determinism + non-inertness guard', () => {
  for (const seed of SEEDS) {
    it(
      `seed ${seed}: fused run is byte-identical across two invocations`,
      async () => {
        const a = await runSlice(seed, AIPathingMode.RISK_REWARD_FUSED);
        const b = await runSlice(seed, AIPathingMode.RISK_REWARD_FUSED);

        // Non-vacuity: the fused danger field is only exercised when enemies are
        // perceived, so require the run to have actually landed hits.
        expect(a.combat.damageDealt).toBeGreaterThan(0);

        expect(fingerprint(a)).toEqual(fingerprint(b));
      },
      DETERMINISM_TIMEOUT_MS,
    );
  }

  // NOTE: the "non-inertness" guard (fused diverges from LEGACY) was removed
  // when AIPathingMode.LEGACY was retired as a dead arm. RISK_REWARD_FUSED is
  // now the sole pathing mode, so there is no LEGACY baseline to compare
  // against. The determinism tests above (byte-identical across two invocations
  // + non-vacuity on damageDealt) remain the primary in-CI fused-path guard.
});
