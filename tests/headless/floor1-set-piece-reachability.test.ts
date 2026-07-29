import { describe, expect, it } from 'vitest';
import { checkFloor1SetPieceReachability } from '../../src/game/set-piece-reachability.js';

/**
 * Local smoke panel for the prefab set-piece reachability hard gate: the carved
 * welcome-room must be reachable from spawn with every door + NPC anchor pathable
 * on every seed. The broad zero-tolerance sweep (>10 runs) runs in CI via
 * `CI` workflow (`set-piece-reachability` job); this panel gives fast local
 * feedback and guards against regressions in `npm run verify`. Seeds are a fixed
 * deterministic panel — NO cherry-picking (rule #12): a single sealed room here
 * is a real bug, not a seed to swap out.
 *
 * Seed 21 is a pinned regression: the generator places the welcome-office hub so
 * it is only reachable THROUGH an initially-locked quest door. The lock-aware hub
 * reachability repair in `initializeFloor1Scenario` must carve a direct unlocked
 * connector so the hub (and its quest NPCs) is reachable in the locked initial
 * state; without it the three quest NPCs scatter outside the carved room.
 */
const SEED_PANEL = [1, 2, 3, 7, 19, 21, 30, 32, 42, 69, 100, 777, 2024] as const;

describe('Floor 1 set-piece reachability (prefab welcome-room)', () => {
  for (const seed of SEED_PANEL) {
    it(`seed ${seed}: welcome-room reachable with all doors + NPC anchors pathable`, () => {
      const result = checkFloor1SetPieceReachability(seed);
      expect(
        result.pass,
        `seed ${seed} failed reachability:\n  - ${result.failures.join('\n  - ')}`,
      ).toBe(true);
      // Sanity: the carve must produce a real shell (>= 1 door) and keep the
      // hub's NPC anchors inside the room.
      expect(result.doorCount, `seed ${seed}: expected >= 1 door`).toBeGreaterThanOrEqual(1);
      expect(
        result.npcCount,
        `seed ${seed}: expected >= 1 in-room NPC anchor`,
      ).toBeGreaterThanOrEqual(1);
      // Zero degradations is the expected steady state (parent-session pushback):
      // every seed must AUTHORITATIVELY carve (bounds == footprint), never fall
      // back to the legacy render-only stamp. A `carved: false` here means carve
      // tiers 1–2 are under-powered — fix the carve, do not swap the seed.
      expect(
        result.carved,
        `seed ${seed}: prefab degraded to the render-only fallback (bounds != footprint)`,
      ).toBe(true);
    });
  }
});
